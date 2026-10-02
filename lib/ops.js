/**
 * dsh-session-cleaner / ops.js
 *
 * The two operations, with every service injected so they can be tested
 * against a fixture directory without a running Harness:
 *
 *   deleteSessionData()          - permanent delete, including derived caches
 *   moveSessionToWorkspace()     -真 cross-workspace move (re-home the artifact)
 *
 * `deps` = { persistence, registry, sessions, agents, emit, logger, homePath, dshHome }
 * Every field may be undefined; each is guarded.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  ARTIFACT_NAMES, assertSessionDirectory, assertSessionId, encodeArtifact,
  generationOf, locateArtifact, readArtifactFile, writeTempFile
} from './artifact.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const describe = error => (error && (error.message ?? String(error))) || 'unknown error'

const resolveTarget = async (sessionId, deps, { headerOnly = false } = {}) => {
  const sessionsRoot = deps.homePath?.('sessions')
  if (typeof sessionsRoot !== 'string') return { sessionsRoot: undefined, artifact: undefined }
  let header
  const persistence = deps.persistence
  if (typeof persistence?.list === 'function') {
    try {
      const rows = await persistence.list()
      header = rows?.find?.(row => row?.id === sessionId)
    } catch { /* fall through to the disk walk */ }
  }
  const artifact = await locateArtifact({
    sessionsRoot,
    sessionId,
    header,
    headerOnly,
    locate: typeof persistence?.locate === 'function' ? header => persistence.locate(header) : undefined
  })
  return { sessionsRoot, artifact }
}

/** Registry-global id set (archivedSessionIds / pinnedSessionIds). */
export const updateGlobalSet = async (registry, key, sessionId, mode) => {
  if (registry === undefined) return false
  let changed = false
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    const current = Array.isArray(state?.[key]) ? state[key] : []
    const present = current.includes(sessionId)
    if (mode === 'remove' ? !present : present) return
    changed = true
    await registry.setState({
      ...state,
      [key]: mode === 'remove' ? current.filter(id => id !== sessionId) : [...current, sessionId]
    })
  })
  return changed
}

/** Drop one session from every workspace's ordered accounting. */
export const detachFromWorkspaces = async (registry, sessionId) => {
  if (registry === undefined) return []
  const detachedFrom = []
  for (const entity of registry.list()) {
    const ids = entity?.record?.sessionIds ?? entity?.sessionIds ?? []
    if (Array.isArray(ids) && ids.includes(sessionId)) {
      await entity.detachSession(sessionId)
      detachedFrom.push(entity.id)
    }
  }
  return detachedFrom
}

/** Ordered workspace projection for the client. */
export const listWorkspaces = registry => {
  if (registry === undefined) return []
  return registry.list().map(entity => {
    const ids = Array.isArray(entity?.record?.sessionIds) ? [...entity.record.sessionIds] : [...(entity?.sessionIds ?? [])]
    return { id: entity.id, title: entity.title || entity.id, path: entity.path, sessionCount: ids.length, sessionIds: ids }
  })
}

/**
 * Derived-cache cleanup — the part DSH itself has no API for.
 *
 * The projection cache stores one version-stamped document per session in the
 * `session_projcache` domain ("No eviction or retention surface", per its own
 * documentation); older DSH releases kept the same records in a single
 * `session_projcache.json` unit, which is pruned here as well when present.
 */
export const purgeProjectionCache = async ({ dshHome, sessionId, apply = true }) => {
  const report = { recordFiles: [], aggregateRowPruned: false, aggregateBackup: undefined, warnings: [] }
  if (typeof dshHome !== 'string') return report
  const storages = join(dshHome, 'storages')

  for (const candidate of [
    join(storages, 'session_projcache', 'sessions', `${sessionId}.json`),
    join(storages, 'session_projcache', `${sessionId}.json`)
  ]) {
    for (const suffix of ['', '.tmp', '.lock']) {
      const file = candidate + suffix
      try {
        const info = await fs.lstat(file)
        if (!info.isFile() || info.isSymbolicLink()) continue
        if (apply) await fs.rm(file, { force: true })
        report.recordFiles.push(file)
      } catch (error) {
        if (error.code !== 'ENOENT') report.warnings.push(`读取 ${file} 失败: ${describe(error)}`)
      }
    }
  }

  const aggregate = join(storages, 'session_projcache.json')
  try {
    const info = await fs.lstat(aggregate)
    if (info.isFile() && !info.isSymbolicLink()) {
      const parsed = JSON.parse(await fs.readFile(aggregate, 'utf8'))
      const rows = parsed?.tables?.sessions
      if (rows !== undefined && Object.hasOwn(rows, sessionId)) {
        if (apply) {
          const backup = `${aggregate}.${Date.now()}.bak`
          await fs.copyFile(aggregate, backup)
          delete rows[sessionId]
          const temp = `${aggregate}.${randomBytes(4).toString('hex')}.tmp`
          await fs.writeFile(temp, JSON.stringify(parsed), 'utf8')
          await fs.rename(temp, aggregate)
          report.aggregateBackup = backup
        }
        report.aggregateRowPruned = true
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') report.warnings.push(`清理投影缓存聚合文件失败: ${describe(error)}`)
  }
  return report
}

/**
 * Permanently delete one session and everything derived from it.
 * Idempotent: an unknown session resolves to a no-op report.
 */
export const deleteSessionData = async ({ sessionId, deps, options = {} }) => {
  assertSessionId(sessionId)
  const { sessions, agents, registry, emit, logger, dshHome } = deps
  const warnings = []
  // Header-only: a truncated history must still be deletable.
  let target = await resolveTarget(sessionId, deps, { headerOnly: true })

  const session = (() => { try { return sessions?.get?.(sessionId) } catch { return undefined } })()
  const agent = (() => { try { return agents?.get?.(sessionId) } catch { return undefined } })()

  // 1. Stop the live runtime before touching its files.
  if (agent !== undefined) {
    try { agent.cancel?.({ kind: 'disposed' }) } catch (error) { warnings.push(`停止会话失败: ${describe(error)}`) }
    try {
      if (typeof agent.scope?.dispose === 'function') await Promise.race([agent.scope.dispose(), sleep(3000)])
    } catch (error) { warnings.push(`等待会话释放失败: ${describe(error)}`) }
    try { agents?.store?.delete?.(sessionId) } catch { /* best effort */ }
  }

  // 2. Detach the store entry (flushes a final drain) or announce disposal.
  let detached = false
  if (session !== undefined) {
    try { await sessions.flush?.(session) } catch { /* best effort */ }
    try {
      const entry = sessions?.store?.get?.(sessionId)
      if (entry !== undefined && typeof entry.detach === 'function') {
        entry.detach()
        await sleep(200)
        detached = true
      }
    } catch { /* best effort */ }
  }
  if (!detached) {
    try { emit?.('session/disposed', { id: sessionId }) } catch { /* best effort */ }
  }

  // 3. A blank session can materialize its first artifact during teardown.
  target = await resolveTarget(sessionId, deps, { headerOnly: true })

  // 4. Registry accounting: membership (all workspaces), archive set, pin set.
  let detachedFrom = []
  let unarchived = false
  let unpinned = false
  try {
    detachedFrom = await detachFromWorkspaces(registry, sessionId)
    unarchived = await updateGlobalSet(registry, 'archivedSessionIds', sessionId, 'remove')
    unpinned = await updateGlobalSet(registry, 'pinnedSessionIds', sessionId, 'remove')
  } catch (error) {
    warnings.push(`更新工作区登记失败: ${describe(error)}`)
  }

  // 5. The artifact directory: every generation, temp file and backup goes with it.
  let artifactRemoved
  let generations = []
  if (target.artifact !== undefined) {
    const dir = dirname(target.artifact.path)
    await assertSessionDirectory(target.sessionsRoot, dir, sessionId)
    generations = (await fs.readdir(dir).catch(() => []))
      .filter(name => generationOf(name) !== null)
    await fs.rm(dir, { recursive: true, force: true })
    artifactRemoved = dir
  }

  // 6. Derived caches last: disposal itself may persist a cache row.
  let projectionCache = { recordFiles: [], aggregateRowPruned: false, warnings: [] }
  try {
    projectionCache = await purgeProjectionCache({ dshHome, sessionId, apply: options.purgeProjectionCache !== false })
    warnings.push(...projectionCache.warnings)
  } catch (error) {
    warnings.push(`清理投影缓存失败: ${describe(error)}`)
  }
  for (const warning of warnings) { try { logger?.warn?.(`session-cleaner: ${warning}`) } catch { /* ignore */ } }

  return {
    ok: true,
    sessionId,
    existed: target.artifact !== undefined || session !== undefined || agent !== undefined,
    wasLive: session !== undefined || agent !== undefined,
    artifactRemoved: artifactRemoved ?? null,
    generationsRemoved: generations,
    detachedFromWorkspaces: detachedFrom,
    unarchived,
    unpinned,
    projectionCache,
    warnings
  }
}

/**
 * Move one session into another workspace.
 *
 * DSH indexes workspace membership off the session header's immutable `cwd`,
 * so a registry-only edit would be reverted; the artifact has to be re-homed:
 * rewrite the header's cwd, publish it at the location `persistence.locate()`
 * derives for the new cwd, keep a live session/writer pointed at the new file,
 * then swap the workspace accounting. Every failure path restores the
 * original artifact, so the session never lands half-moved.
 */
export const moveSessionToWorkspace = async ({ sessionId, targetWorkspaceId, deps }) => {
  assertSessionId(sessionId)
  const { persistence, registry, sessions, logger } = deps
  if (persistence === undefined) throw Object.assign(new Error('sessionPersistence 服务不可用'), { code: 'no-persistence' })
  if (typeof persistence.locate !== 'function') {
    throw Object.assign(new Error('当前持久化后端无法定位会话工件，无法移动'), { code: 'no-locate' })
  }
  if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId === '') {
    throw Object.assign(new Error('目标工作区必填'), { code: 'bad-request' })
  }
  const target = registry?.list?.().find(entity => entity.id === targetWorkspaceId)
  if (target === undefined) throw Object.assign(new Error('目标工作区不存在'), { code: 'workspace-not-found' })
  const targetPath = target.path

  const { sessionsRoot, artifact } = await resolveTarget(sessionId, deps)
  if (artifact === undefined) {
    throw Object.assign(new Error('会话没有磁盘记录（可能是不存在或尚未产生任何消息的空白会话）'), { code: 'session-not-found' })
  }
  const storedHeader = artifact.header
  if (storedHeader.origin === 'subagent') {
    throw Object.assign(new Error('子代理会话不支持跨工作区移动'), { code: 'subagent-unsupported' })
  }
  if (storedHeader.cwd !== undefined) {
    let currentCanonical
    try { currentCanonical = await fs.realpath(storedHeader.cwd) } catch { /* re-home below */ }
    if (currentCanonical !== undefined && currentCanonical === targetPath) {
      return { ok: true, sessionId, moved: false, message: '会话已属于目标工作区' }
    }
  }

  const liveSession = (() => { try { return sessions?.get?.(sessionId) } catch { return undefined } })()
  const liveWriter = (() => {
    const writers = persistence?.tracker?.writers
    return typeof writers?.get === 'function' ? writers.get(sessionId) : undefined
  })()
  if (liveSession !== undefined && liveWriter === undefined) {
    throw Object.assign(
      new Error('当前运行时未暴露可重绑定的写入器，无法安全迁移运行中的会话；请先关闭该会话后重试'),
      { code: 'no-live-writer' }
    )
  }
  if (liveSession !== undefined) {
    try { await sessions.flush(liveSession) } catch { /* best effort */ }
  }

  const coordinator = persistence.coordinator
  const serialize = typeof coordinator?.serialize === 'function'
    ? operation => coordinator.serialize(sessionId, operation)
    : operation => operation()

  return serialize(async () => {
    const oldPath = artifact.path
    const newHeader = { ...storedHeader, cwd: targetPath }
    const located = persistence.locate(newHeader)
    const newPath = located?.path
    if (typeof newPath !== 'string') throw Object.assign(new Error('持久化后端无法定位目标路径'), { code: 'no-locate' })
    // The filename generation and the header version must agree, or DSH
    // rejects the session on the next boot.
    const expectedVersion = generationOf(basename(newPath))
    if (typeof expectedVersion === 'number') newHeader.version = expectedVersion
    if (oldPath === newPath) throw Object.assign(new Error('源路径与目标路径相同，拒绝覆盖'), { code: 'same-path' })

    await assertSessionDirectory(sessionsRoot, dirname(oldPath), sessionId)
    await assertSessionDirectory(sessionsRoot, dirname(newPath), sessionId, { allowMissing: true })
    try {
      await fs.lstat(newPath)
      throw Object.assign(new Error('目标位置已有会话工件，拒绝覆盖'), { code: 'target-exists' })
    } catch (error) { if (error.code !== 'ENOENT') throw error }

    const bytes = await encodeArtifact(JSON.stringify(newHeader), artifact.rest, { isZstd: oldPath.endsWith('.zstd') })
    await fs.mkdir(dirname(newPath), { recursive: true })
    const tempNew = await writeTempFile(newPath, bytes)
    const hiddenOld = `${oldPath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.rename(oldPath, hiddenOld)
    } catch (error) {
      await fs.rm(tempNew, { force: true })
      throw Object.assign(new Error(`移动失败（无法隐藏原工件，会话保持原状）: ${describe(error)}`), { code: 'move-failed', cause: error })
    }
    try {
      await fs.rename(tempNew, newPath)
    } catch (error) {
      try { await fs.rename(hiddenOld, oldPath) }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError],
          `移动发布失败且回滚失败；原始会话保留在 ${hiddenOld}，新文件保留在 ${tempNew}`)
      }
      await fs.rm(tempNew, { force: true })
      throw Object.assign(new Error(`移动发布失败，原始会话已恢复: ${describe(error)}`), { code: 'move-failed', cause: error })
    }

    // From here the file is at the new location; every in-memory face moves with it.
    const state = coordinator?.states?.get?.(sessionId)
    if (state?.owner !== undefined && liveSession !== undefined && state.owner !== liveSession) {
      await fs.rm(newPath, { force: true })
      await fs.rename(hiddenOld, oldPath)
      throw Object.assign(new Error('持久化 owner 与当前 live session 不一致，已回滚'), { code: 'owner-mismatch' })
    }
    const oldMeta = state?.meta
    const oldLiveHeader = liveSession?.header
    const oldWriterHeader = liveWriter?.header
    const oldIndexedHeader = registry?.headers?.get?.(sessionId)
    const oldIndexedPath = registry?.sessionPaths?.get?.(sessionId)
    const oldInvalidPath = registry?.invalidSessionPaths?.get?.(sessionId)
    const fromWorkspaceIds = registry?.list?.()
      .filter(entity => entity.id !== target.id && (entity?.record?.sessionIds ?? entity?.sessionIds ?? []).includes(sessionId))
      .map(entity => entity.id) ?? []
    const detachedFrom = []
    let attached = false

    const rollback = async error => {
      if (state !== undefined && oldMeta !== undefined) state.meta = oldMeta
      coordinator?.preparations?.invalidate?.(sessionId)
      if (liveSession !== undefined && oldLiveHeader !== undefined) liveSession.header = oldLiveHeader
      if (liveWriter !== undefined && oldWriterHeader !== undefined) liveWriter.header = oldWriterHeader
      if (registry?.headers !== undefined) {
        if (oldIndexedHeader === undefined) registry.headers.delete?.(sessionId)
        else registry.headers.set?.(sessionId, oldIndexedHeader)
      }
      if (registry?.sessionPaths !== undefined) {
        if (oldIndexedPath === undefined) registry.sessionPaths.delete?.(sessionId)
        else registry.sessionPaths.set?.(sessionId, oldIndexedPath)
      }
      if (registry?.invalidSessionPaths !== undefined) {
        if (oldInvalidPath === undefined) registry.invalidSessionPaths.delete?.(sessionId)
        else registry.invalidSessionPaths.set?.(sessionId, oldInvalidPath)
      }
      const rollbackErrors = []
      try { if (attached) await target.detachSession(sessionId) } catch (e) { rollbackErrors.push(e) }
      for (const id of detachedFrom) {
        try {
          const entity = registry?.list?.().find(candidate => candidate.id === id)
          if (entity !== undefined) await entity.attachSession(sessionId)
        } catch (e) { rollbackErrors.push(e) }
      }
      try { await fs.rm(newPath, { force: true }) } catch (e) { rollbackErrors.push(e) }
      try { await fs.rename(hiddenOld, oldPath) } catch (e) { rollbackErrors.push(e) }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], `移动失败且回滚不完整；原始会话可能保留在 ${hiddenOld}`)
      }
      throw error
    }

    try {
      if (state !== undefined) {
        state.meta = { ...state.meta, ...newHeader, cwd: targetPath }
        state.materialized = true
      }
      coordinator?.preparations?.invalidate?.(sessionId)
      if (liveSession !== undefined) {
        liveSession.header = Object.freeze({ ...newHeader })
        // Keep the SAME writer handle (queue, cursor, lease) and retarget it.
        if (liveWriter.header === undefined || liveWriter.header === null) {
          throw Object.assign(new Error('写入器不支持安全重绑定'), { code: 'no-live-writer' })
        }
        liveWriter.header = Object.freeze({ ...newHeader })
      }
      registry?.headers?.set?.(sessionId, { ...newHeader })
      registry?.sessionPaths?.set?.(sessionId, targetPath)
      registry?.invalidSessionPaths?.delete?.(sessionId)

      await registry?.enqueueOperation?.(async () => {
        for (const id of fromWorkspaceIds) {
          const entity = registry.list().find(candidate => candidate.id === id)
          if (entity === undefined) continue
          await entity.detachSession(sessionId)
          detachedFrom.push(id)
        }
        await target.attachSession(sessionId)
        attached = true
      })
    } catch (error) {
      return rollback(error)
    }

    try { await fs.rm(hiddenOld, { force: true }) } catch { /* best effort */ }
    try {
      await assertSessionDirectory(sessionsRoot, dirname(oldPath), sessionId)
      await fs.rm(dirname(oldPath), { recursive: true, force: true })
    } catch (error) {
      try { logger?.warn?.(`session-cleaner: 旧会话目录未能清理: ${describe(error)}`) } catch { /* ignore */ }
    }

    return {
      ok: true,
      sessionId,
      moved: true,
      fromWorkspaceIds,
      toWorkspaceId: target.id,
      toWorkspaceTitle: target.title || target.id,
      artifactFrom: oldPath,
      artifactTo: newPath,
      wasLive: liveSession !== undefined
    }
  })
}
