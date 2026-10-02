/**
 * dsh-session-cleaner / artifact.js
 *
 * Reading and rewriting a DSH session artifact.
 *
 * Layout contract (DSH jsonl persistence):
 *   - The artifact is `session[.v<N>].jsonl[.zstd]`.
 *   - A `.zstd` artifact is a CONCATENATION of checksummed Zstandard frames,
 *     one frame per durable batch, and the FIRST frame holds exactly the
 *     header line. Frame boundaries therefore have to be computed from each
 *     frame header; a magic-byte scan or a plain whole-buffer
 *     `zstdDecompressSync()` silently stops after the first frame.
 *
 * This module implements the frame walk itself and re-encodes as a
 * two-frame artifact (header frame + body frame), which is what DSH's
 * reader accepts.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress, zstdCompress } from 'node:zlib'

const zstdDecompressAsync = promisify(zstdDecompress)
const zstdCompressAsync = promisify(zstdCompress)
const ZSTD_MAGIC = 0xfd2fb528

/** Canonical artifact filenames, newest generation first. */
export const ARTIFACT_NAMES = [
  'session.v4.jsonl.zstd',
  'session.v3.jsonl.zstd',
  'session.v2.jsonl.zstd',
  'session.jsonl.zstd',
  'session.jsonl'
]

/** A session id is a directory segment: never a path, never a traversal. */
export function assertSessionId(id) {
  if (typeof id !== 'string' || id.trim() === '' || id === '.' || id === '..'
    || /[\\/\x00-\x1f<>:"|?*]/.test(id) || /[. ]$/.test(id)) {
    throw Object.assign(new Error('非法的会话标识'), { code: 'bad-request' })
  }
  return id
}

/** Generation number encoded in an artifact filename (0 = legacy plain name). */
export function generationOf(filename) {
  const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(filename)
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * Walk concatenated Zstandard frames.
 * Returns `{ frames, tornStart }`; `tornStart` marks an incomplete tail.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw Object.assign(new Error(`会话日志损坏：字节 ${offset} 处不是 Zstandard 帧头`), { code: 'corrupt-artifact' })
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) {
      throw Object.assign(new Error(`会话日志损坏：帧头保留位非零（字节 ${offset - 1}）`), { code: 'corrupt-artifact' })
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw Object.assign(new Error('会话日志损坏：出现保留的块类型'), { code: 'corrupt-artifact' })
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** Decode every frame; refuses a torn tail (a truncated history must never be rewritten). */
export async function decodeArtifact(buffer, { isZstd }) {
  if (!isZstd) {
    const text = buffer.toString('utf8')
    if (!text.endsWith('\n')) {
      throw Object.assign(new Error('会话日志尾行不完整，拒绝改写'), { code: 'torn-artifact' })
    }
    return text
  }
  const scan = scanZstdFrames(buffer)
  if (scan.frames.length === 0) {
    throw Object.assign(new Error('会话日志不含任何 Zstandard 帧'), { code: 'corrupt-artifact' })
  }
  if (scan.tornStart !== undefined) {
    throw Object.assign(new Error('会话日志存在截断的 Zstandard 帧，拒绝改写；请先备份并修复'), { code: 'torn-artifact' })
  }
  const parts = []
  for (const frame of scan.frames) parts.push(await zstdDecompressAsync(buffer.subarray(frame.start, frame.end)))
  const text = Buffer.concat(parts).toString('utf8')
  if (!text.endsWith('\n')) {
    throw Object.assign(new Error('会话日志尾行不完整，拒绝改写'), { code: 'torn-artifact' })
  }
  return text
}

/** Re-encode: frame 1 is exactly the header line, frame 2 the remaining events. */
export async function encodeArtifact(headerLine, rest, { isZstd }) {
  if (!isZstd) return Buffer.from(`${headerLine}\n${rest}`, 'utf8')
  const headerFrame = await zstdCompressAsync(Buffer.from(`${headerLine}\n`, 'utf8'))
  if (rest === '') return headerFrame
  const bodyFrame = await zstdCompressAsync(Buffer.from(rest, 'utf8'))
  return Buffer.concat([headerFrame, bodyFrame])
}

/** Read + decode one artifact file. */
export async function readArtifactFile(path) {
  const info = await fs.lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw Object.assign(new Error('会话工件必须是普通文件'), { code: 'unsafe-artifact' })
  }
  const isZstd = path.endsWith('.zstd')
  const text = await decodeArtifact(await fs.readFile(path), { isZstd })
  const newlineAt = text.indexOf('\n')
  if (newlineAt === -1) throw Object.assign(new Error('会话工件缺少头行'), { code: 'corrupt-artifact' })
  let header
  try { header = JSON.parse(text.slice(0, newlineAt)) }
  catch { throw Object.assign(new Error('会话工件头行无法解析'), { code: 'corrupt-artifact' }) }
  return { path, isZstd, text, headerLine: text.slice(0, newlineAt), rest: text.slice(newlineAt + 1), header }
}

/**
 * Header-only read: decode just the FIRST frame (the header line) instead of
 * the whole history. Deleting must stay possible for a truncated log, and
 * this keeps it cheap on multi-megabyte artifacts.
 */
export async function readArtifactHeader(path) {
  const info = await fs.lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw Object.assign(new Error('会话工件必须是普通文件'), { code: 'unsafe-artifact' })
  }
  const isZstd = path.endsWith('.zstd')
  if (!isZstd) {
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(info.size, 1024 * 1024))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      const newlineAt = text.indexOf('\n')
      if (newlineAt === -1) throw Object.assign(new Error('会话工件缺少头行'), { code: 'corrupt-artifact' })
      return { path, isZstd, header: JSON.parse(text.slice(0, newlineAt)) }
    } finally { await handle.close() }
  }
  const handle = await fs.open(path, 'r')
  try {
    let size = Math.min(Math.max(info.size, 64), 1024 * 1024)
    for (;;) {
      const buffer = Buffer.alloc(Math.min(size, info.size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const slice = buffer.subarray(0, bytesRead)
      const scan = scanZstdFrames(slice, 1)
      if (scan.frames.length === 1) {
        const decoded = await zstdDecompressAsync(slice.subarray(scan.frames[0].start, scan.frames[0].end))
        const text = decoded.toString('utf8')
        const newlineAt = text.indexOf('\n')
        if (newlineAt === -1) throw Object.assign(new Error('会话工件头行不完整'), { code: 'corrupt-artifact' })
        return { path, isZstd, header: JSON.parse(text.slice(0, newlineAt)) }
      }
      if (bytesRead >= info.size || size >= 8 * 1024 * 1024) {
        throw Object.assign(new Error('会话工件头帧不完整'), { code: 'corrupt-artifact' })
      }
      size *= 4
    }
  } finally { await handle.close() }
}

/**
 * Only `<sessionsRoot>/<project>/<sessionDir>` may ever be mutated, and
 * neither child may be a symlink/junction. Re-checked immediately before
 * every destructive or moving operation.
 */
export async function assertSessionDirectory(sessionsRoot, directory, sessionId, { allowMissing = false } = {}) {
  assertSessionId(sessionId)
  if (typeof sessionsRoot !== 'string' || typeof directory !== 'string') {
    throw Object.assign(new Error('无法校验会话目录'), { code: 'unsafe-path' })
  }
  const base = resolve(sessionsRoot)
  const target = resolve(directory)
  const rel = relative(base, target)
  const parts = rel.split(sep)
  if (rel === '' || parts.length !== 2 || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw Object.assign(new Error('会话目录超出允许范围'), { code: 'unsafe-path' })
  }
  const canonicalRoot = await fs.realpath(base)
  let current = base
  for (const part of parts) {
    current = join(current, part)
    let info
    try { info = await fs.lstat(current) }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return target
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw Object.assign(new Error('会话目录不能是符号链接、junction 或普通文件'), { code: 'unsafe-path' })
    }
    const child = relative(canonicalRoot, await fs.realpath(current))
    if (child === '' || child.startsWith('..') || child.includes(`..${sep}`)) {
      throw Object.assign(new Error('会话目录解析到了允许范围之外'), { code: 'unsafe-path' })
    }
  }
  return target
}

/** Write a temp file next to its destination, fsync, and return the temp path. */
export async function writeTempFile(finalPath, data) {
  const temp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    try { await handle.close() } catch { /* keep original error */ }
    try { await fs.rm(temp, { force: true }) } catch { /* uncommitted temp */ }
    throw error
  }
  await handle.close()
  return temp
}

/**
 * Find one session's artifact on disk.
 * `persistence.locate()` is the fast path; the directory walk is the
 * fallback for artifacts the index cannot see (it matches the directory
 * name instead of re-deriving DSH's own path encoding).
 *
 * With `headerOnly` the log is never fully decoded, so a truncated history
 * is still locatable (needed by delete); callers that rewrite the log must
 * take the default and decode it all.
 */
export async function locateArtifact({ sessionsRoot, sessionId, header, locate, headerOnly = false }) {
  assertSessionId(sessionId)
  if (typeof sessionsRoot !== 'string') return undefined
  const read = headerOnly ? readArtifactHeader : readArtifactFile
  // Identity must be provable before anything is deleted: an unreadable
  // candidate is skipped on the header-only (delete) path and reported as a
  // failure on the full-read (move) path, where the log is about to be rewritten.
  const skippable = error => error.code === 'ENOENT' || (headerOnly && error.code === 'corrupt-artifact')
  if (header !== undefined && typeof locate === 'function') {
    try {
      const located = locate(header)
      const path = located?.path
      if (typeof path === 'string') {
        const artifact = await read(path)
        if (artifact.header?.id === sessionId) {
          return headerOnly ? { ...artifact, path } : artifact
        }
      }
    } catch (error) {
      if (!skippable(error)) throw error
    }
  }
  let projects
  try { projects = await fs.readdir(sessionsRoot, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  const wanted = [sessionId, `session-${sessionId}`, `session-${sessionId.replace(/^session-/, '')}`]
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue
    for (const name of wanted) {
      const dir = join(sessionsRoot, project.name, name)
      let info
      try { info = await fs.lstat(dir) } catch { continue }
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      for (const filename of ARTIFACT_NAMES) {
        const candidate = join(dir, filename)
        try {
          const artifact = await read(candidate)
          if (artifact.header?.id === sessionId) {
            return headerOnly ? { ...artifact, path: candidate } : artifact
          }
        } catch (error) {
          if (!skippable(error)) throw error
        }
      }
    }
  }
  return undefined
}

export const artifactDirOf = path => dirname(path)
export const artifactNameOf = path => basename(path)
