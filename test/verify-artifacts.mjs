/**
 * Codec verification against every real session artifact (read-only).
 * For each artifact: decode -> re-encode -> decode, and require the two
 * decodes to be byte-identical. A single-frame decoder silently produces a
 * header-only file here, so this is the test that actually protects a move.
 *
 *   node test/verify-artifacts.mjs [sessionsRoot]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACT_NAMES, decodeArtifact, encodeArtifact, readArtifactFile, scanZstdFrames } from '../lib/artifact.js'

const root = process.argv[2] ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'), 'sessions')

const files = []
try {
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of fs.readdirSync(path.join(root, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const name of ARTIFACT_NAMES) {
        const full = path.join(root, project.name, session.name, name)
        if (fs.existsSync(full)) files.push(full)
      }
    }
  }
} catch { /* no DSH_HOME on this machine: report the skip below instead of crashing */ }

let ok = 0
let failed = 0
let totalBytes = 0
let totalDecoded = 0
console.log(`artifacts found: ${files.length}\n`)
if (files.length === 0) {
  console.log(`no session artifacts under ${root}`)
  console.log('(nothing to verify here — run this on a machine with DSH sessions for the real round-trip check)')
  process.exit(0)
}
for (const file of files) {
  const label = file.slice(root.length + 1)
  try {
    const raw = fs.readFileSync(file)
    const artifact = await readArtifactFile(file)
    const frames = artifact.path.endsWith('.zstd') ? scanZstdFrames(raw).frames.length : 0
    const reencoded = await encodeArtifact(artifact.headerLine, artifact.rest, { isZstd: artifact.path.endsWith('.zstd') })
    const decoded = await decodeArtifact(reencoded, { isZstd: artifact.path.endsWith('.zstd') })
    const identical = decoded === artifact.text
    const events = artifact.text.split('\n').filter(Boolean).length - 1
    totalBytes += raw.length
    totalDecoded += Buffer.byteLength(artifact.text)
    if (!identical) throw new Error('round-trip mismatch')
    ok += 1
    console.log(`  PASS  ${String(raw.length).padStart(9)} B / ${frames} frames -> ${String(Buffer.byteLength(artifact.text)).padStart(9)} B, ${events} events  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${label}: ${error.code ?? ''} ${error.message}`)
  }
}
console.log(`\n${ok} passed, ${failed} failed`)
console.log(`on-disk ${(totalBytes / 1048576).toFixed(1)} MB -> decoded ${(totalDecoded / 1048576).toFixed(1)} MB`)
if (failed > 0) process.exit(1)
