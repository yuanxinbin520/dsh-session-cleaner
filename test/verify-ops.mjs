/**
 * End-to-end verification of the two operations on a THROWAWAY fixture.
 * Never touches the live DSH_HOME: everything happens under os.tmpdir().
 *
 *   node test/verify-ops.mjs [sessionsRootWithRealLogs]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeArtifact, decodeArtifact, generationOf, readArtifactFile } from '../lib/artifact.js'
import { zstdCompressSync } from 'node:zlib'
import { deleteSessionData, moveSessionToWorkspace } from '../lib/ops.js'

const REAL_SESSIONS = process.argv[2] ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'), 'sessions')

/** DSH's project-directory naming, implemented here only to build fixtures. */
const encodeProject = value => {
  let readable = ''
  let separatorRun = false
  for (const ch of value) {
    const code = ch.charCodeAt(0)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
}

// ---------------------------------------------------------------- fixture root
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-cleaner-test-'))
const dshHome = path.join(root, '.dsh')
const sessionsRoot = path.join(dshHome, 'sessions')
const projA = path.join(root, 'projA')
const projB = path.join(root, 'projB')
fs.mkdirSync(projA, { recursive: true })
fs.mkdirSync(projB, { recursive: true })

// Fixture source: the largest real artifact when a DSH_HOME is present,
// otherwise a synthetic multi-frame log, so the suite runs anywhere (CI too).
const candidates = []
try {
  for (const project of fs.readdirSync(REAL_SESSIONS, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of fs.readdirSync(path.join(REAL_SESSIONS, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']) {
        const full = path.join(REAL_SESSIONS, project.name, session.name, name)
        if (fs.existsSync(full)) candidates.push({ full, size: fs.statSync(full).size })
      }
    }
  }
} catch { /* no DSH_HOME here: fall through to the synthetic source */ }

/** DSH writes one Zstandard frame per durable batch; mimic that shape. */
const synthesiseSource = () => {
  const header = {
    type: 'session', version: 4, id: 'synthetic', createdAt: Date.now(),
    cwd: 'D:\\synthetic', isSeeded: false, delegationDepth: 0, agentPreset: 'standard'
  }
  const events = []
  for (let seq = 1; seq <= 2000; seq += 1) {
    events.push(JSON.stringify({ type: seq % 50 === 0 ? 'assistant' : 'user', seq, text: `event ${seq} `.repeat(4) }))
  }
  return {
    label: `synthetic multi-frame log (${events.length + 1} frames)`,
    header,
    rest: `${events.join('\n')}\n`,
    // one frame for the header line, then one frame per event
    render: async override => Buffer.concat([
      zstdCompressSync(Buffer.from(`${JSON.stringify(override)}\n`, 'utf8')),
      ...events.map(event => zstdCompressSync(Buffer.from(`${event}\n`, 'utf8')))
    ])
  }
}

let SOURCE
if (candidates.length > 0) {
  candidates.sort((a, b) => a.size - b.size)
  const chosen = candidates.at(-1)
  const artifact = await readArtifactFile(chosen.full)
  SOURCE = {
    label: `${path.basename(chosen.full)} (${chosen.size} B, real DSH log)`,
    header: artifact.header,
    rest: artifact.rest,
    render: async override => encodeArtifact(JSON.stringify(override), artifact.rest, { isZstd: true })
  }
} else {
  SOURCE = synthesiseSource()
}
console.log(`fixture source: ${SOURCE.label}\n`)

/** Plant the source body under a synthetic header we fully control. */
const plantArtifact = async ({ id, cwd, name = 'session.v4.jsonl.zstd' }) => {
  const header = { ...SOURCE.header, id, cwd, version: generationOf(name) ?? 4 }
  const bytes = await SOURCE.render(header)
  const text = await decodeArtifact(bytes, { isZstd: name.endsWith('.zstd') })
  const file = path.join(sessionsRoot, encodeProject(cwd), `session-${id}`, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  return { file, header, text, rest: text.slice(text.indexOf('\n') + 1) }
}

const makeState = () => ({
  workspaces: [
    { id: 'ws-A', path: projA, title: 'projA', sessionIds: [] },
    { id: 'ws-B', path: projB, title: 'projB', sessionIds: [] }
  ],
  archivedSessionIds: [],
  pinnedSessionIds: []
})

const makeRegistry = initial => {
  const state = initial // mutated in place, like the fixture's own view
  const registry = {
    headers: new Map(), sessionPaths: new Map(), invalidSessionPaths: new Map(),
    list: () => state.workspaces.map(ws => ({
      id: ws.id, title: ws.title, path: ws.path,
      get sessionIds() { return ws.sessionIds },
      get record() { return { sessionIds: ws.sessionIds } },
      async detachSession(id) { ws.sessionIds = ws.sessionIds.filter(x => x !== id) },
      async attachSession(id) { if (!ws.sessionIds.includes(id)) ws.sessionIds.push(id) }
    })),
    requireState: () => state,
    async setState(next) { Object.assign(state, next) },
    async enqueueOperation(operation) { return operation() }
  }
  return registry
}

const makePersistence = ({ id, artifactPath, header, liveWriter }) => ({
  tracker: { writers: new Map(liveWriter ? [[id, liveWriter]] : []) },
  coordinator: { states: new Map(), preparations: { invalidate() {} }, serialize: (sid, op) => op() },
  async list() { return [header] },
  locate(h) { return { path: path.join(sessionsRoot, encodeProject(h.cwd), `session-${h.id}`, path.basename(artifactPath)) } }
})

let failures = 0
const check = async (name, fn) => {
  const step = async () => fn()
  try { await step(); console.log(`  PASS  ${name}`) }
  catch (error) { failures += 1; console.log(`  FAIL  ${name}: ${error.message}`) }
}

// ---------------------------------------------------------------- delete
console.log('delete:')
{
  const id = '11111111-2222-3333-4444-555555555555'
  const planted = await plantArtifact({ id, cwd: projA })
  const state = makeState()
  state.workspaces[0].sessionIds = [id, 'other-session']
  state.workspaces[1].sessionIds = [id]
  state.archivedSessionIds = [id, 'keep-me']
  state.pinnedSessionIds = [id]
  const registry = makeRegistry(state)
  const persistence = makePersistence({ id, artifactPath: planted.file, header: planted.header })

  // derived-cache leftovers, exactly where DSH leaves them
  const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, `${id}.json`), '{"version":7,"record":{}}')
  fs.writeFileSync(path.join(cacheDir, `${id}.json.lock`), '{"pid":1}')
  const aggregate = path.join(dshHome, 'storages', 'session_projcache.json')
  fs.writeFileSync(aggregate, JSON.stringify({
    unit: { name: 'session_projcache', version: 3 }, global: null,
    tables: { sessions: { [id]: { identity: {} }, 'other-session': { identity: {} } } }
  }))
  const warnings = []
  const deps = { persistence, registry, sessions: undefined, agents: undefined, emit: () => {}, logger: { warn: m => warnings.push(m) }, homePath: s => (s === 'sessions' ? sessionsRoot : undefined), dshHome }

  const report = await deleteSessionData({ sessionId: id, deps })
  await check('session directory is gone', () => assert.equal(fs.existsSync(path.dirname(planted.file)), false))
  await check('report lists the removed generations', () => assert.deepEqual(report.generationsRemoved, ['session.v4.jsonl.zstd']))
  await check('projection-cache record + lock removed', () => {
    assert.equal(fs.existsSync(path.join(cacheDir, `${id}.json`)), false)
    assert.equal(fs.existsSync(path.join(cacheDir, `${id}.json.lock`)), false)
  })
  await check('legacy aggregate row pruned, unrelated row kept', () => {
    const parsed = JSON.parse(fs.readFileSync(aggregate, 'utf8'))
    assert.equal(Object.hasOwn(parsed.tables.sessions, id), false)
    assert.equal(Object.hasOwn(parsed.tables.sessions, 'other-session'), true)
  })
  await check('aggregate backup written', () => {
    assert.ok(report.projectionCache.aggregateBackup)
    assert.ok(fs.existsSync(report.projectionCache.aggregateBackup))
  })
  await check('detached from every workspace', () => {
    assert.deepEqual(report.detachedFromWorkspaces.sort(), ['ws-A', 'ws-B'])
    assert.equal(state.workspaces[0].sessionIds.includes(id), false)
    assert.equal(state.workspaces[1].sessionIds.includes(id), false)
    assert.equal(state.workspaces[0].sessionIds.includes('other-session'), true)
  })
  await check('archive + pin sets cleaned, unrelated ids kept', () => {
    assert.deepEqual(state.archivedSessionIds, ['keep-me'])
    assert.deepEqual(state.pinnedSessionIds, [])
  })
  await check('the destroyed log was substantial (not a header-only file)', () =>
    assert.ok(planted.rest.split('\n').filter(Boolean).length > 100))
  await check('second delete is a harmless no-op', async () => {
    const again = await deleteSessionData({ sessionId: id, deps })
    assert.equal(again.ok, true)
    assert.equal(again.existed, false)
    assert.equal(again.artifactRemoved, null)
  })
  await check('rejects a path-traversal session id', async () => {
    await assert.rejects(() => deleteSessionData({ sessionId: '../evil', deps }), /非法/)
  })
}

// ---------------------------------------------------------------- move
console.log('\nmove:')
{
  const id = '99999999-8888-7777-6666-555555555555'
  const planted = await plantArtifact({ id, cwd: projA, name: 'session.v3.jsonl.zstd' })
  const state = makeState()
  state.workspaces[0].sessionIds = [id]
  const registry = makeRegistry(state)
  const header = { ...planted.header }
  const liveWriter = { header: { ...header } }
  const liveSession = { header: { ...header } }
  const persistence = makePersistence({ id, artifactPath: planted.file, header, liveWriter })
  const deps = {
    persistence, registry, agents: undefined, emit: () => {}, logger: { warn() {} },
    sessions: { get: sid => (sid === id ? liveSession : undefined), flush: async () => {} },
    homePath: s => (s === 'sessions' ? sessionsRoot : undefined), dshHome
  }

  const result = await moveSessionToWorkspace({ sessionId: id, targetWorkspaceId: 'ws-B', deps })
  const after = await readArtifactFile(result.artifactTo)
  const eventCount = text => text.split('\n').filter(Boolean).length - 1

  await check('artifact published under the target workspace path', () => {
    assert.ok(fs.existsSync(result.artifactTo))
    assert.ok(result.artifactTo.includes(encodeProject(projB)))
  })
  await check('event body is byte-identical after the move', () => assert.equal(after.rest, planted.rest))
  await check('every event survives (multi-frame log not truncated)', () => {
    assert.ok(eventCount(after.text) > 1000, `expected a large log, got ${eventCount(after.text)} events`)
    assert.equal(eventCount(after.text), eventCount(planted.text))
  })
  await check('header cwd rewritten to the target path', () => assert.equal(after.header.cwd, projB))
  await check('header version still matches the filename generation', () => assert.equal(after.header.version, 3))
  await check('old session directory removed', () => assert.equal(fs.existsSync(path.dirname(planted.file)), false))
  await check('registry accounting swapped between workspaces', () => {
    assert.deepEqual(state.workspaces[0].sessionIds, [])
    assert.deepEqual(state.workspaces[1].sessionIds, [id])
  })
  await check('live session + writer retargeted (no teardown)', () => {
    assert.equal(liveSession.header.cwd, projB)
    assert.equal(liveWriter.header.cwd, projB)
  })
  await check('moving into the current workspace is a no-op', async () => {
    const again = await moveSessionToWorkspace({ sessionId: id, targetWorkspaceId: 'ws-B', deps })
    assert.equal(again.moved, false)
  })
  await check('unknown target workspace is rejected and changes nothing', async () => {
    await assert.rejects(() => moveSessionToWorkspace({ sessionId: id, targetWorkspaceId: 'nope', deps }), /目标工作区不存在/)
  })
  await check('unknown session is rejected', async () => {
    await assert.rejects(
      () => moveSessionToWorkspace({ sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', targetWorkspaceId: 'ws-A', deps }),
      /没有磁盘记录/
    )
  })

  // never overwrite an existing destination
  const id2 = '12121212-3434-5656-7878-909090909090'
  const planted2 = await plantArtifact({ id: id2, cwd: projA, name: 'session.v3.jsonl.zstd' })
  const header2 = { ...planted2.header, id: id2, cwd: projA }
  const persistence2 = makePersistence({ id: id2, artifactPath: planted2.file, header: header2 })
  const occupied = path.join(sessionsRoot, encodeProject(projB), `session-${id2}`, 'session.v3.jsonl.zstd')
  fs.mkdirSync(path.dirname(occupied), { recursive: true })
  fs.copyFileSync(planted2.file, occupied)
  await check('refuses to overwrite an existing target artifact', async () => {
    await assert.rejects(
      () => moveSessionToWorkspace({ sessionId: id2, targetWorkspaceId: 'ws-B', deps: { ...deps, persistence: persistence2 } }),
      /拒绝覆盖/
    )
    assert.ok(fs.existsSync(planted2.file), 'source must survive a refused move')
  })
}

// ---------------------------------------------------------------- corrupt log
console.log('\ncorrupt-log handling:')
{
  const state = makeState()
  const registry = makeRegistry(state)
  const deps = (persistence, extra = {}) => ({
    persistence, registry, sessions: undefined, agents: undefined, emit: () => {}, logger: { warn() {} },
    homePath: s => (s === 'sessions' ? sessionsRoot : undefined), dshHome, ...extra
  })

  // truncated tail
  const idTorn = 'abcdefab-cdef-abcd-efab-cdefabcdefab'
  const torn = await plantArtifact({ id: idTorn, cwd: projA })
  const bytes = fs.readFileSync(torn.file)
  fs.writeFileSync(torn.file, bytes.subarray(0, bytes.length - 40))
  state.workspaces[0].sessionIds = [idTorn]
  const persistenceTorn = makePersistence({ id: idTorn, artifactPath: torn.file, header: torn.header })
  await check('move refuses a truncated log and leaves it in place', async () => {
    await assert.rejects(
      () => moveSessionToWorkspace({ sessionId: idTorn, targetWorkspaceId: 'ws-B', deps: deps(persistenceTorn) }),
      /截断/
    )
    assert.ok(fs.existsSync(torn.file))
  })
  await check('delete still works on a truncated log (header-only read)', async () => {
    const report = await deleteSessionData({ sessionId: idTorn, deps: deps(persistenceTorn) })
    assert.equal(report.artifactRemoved !== null, true)
    assert.equal(fs.existsSync(path.dirname(torn.file)), false)
  })

  // foreign data in place of an artifact
  const idBad = 'beefbeef-beef-beef-beef-beefbeefbeef'
  const badDir = path.join(sessionsRoot, encodeProject(projA), `session-${idBad}`)
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(path.join(badDir, 'session.v4.jsonl.zstd'), 'not a zstd frame at all')
  await check('junk that is not a session artifact is not treated as one', async () => {
    const persistence = makePersistence({ id: idBad, artifactPath: path.join(badDir, 'session.v4.jsonl.zstd'), header: { id: idBad, cwd: projA } })
    const report = await deleteSessionData({ sessionId: idBad, deps: deps(persistence) })
    // identity cannot be proven -> reported as non-existent rather than deleted blindly
    assert.equal(report.existed, false)
    assert.ok(fs.existsSync(badDir), 'unverifiable directory must be left alone')
  })
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
fs.rmSync(root, { recursive: true, force: true })
if (failures > 0) process.exit(1)
