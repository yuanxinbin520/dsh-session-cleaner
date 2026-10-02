/**
 * dsh-session-cleaner — Host half.
 *
 * Adds the two session operations DSH itself does not ship, exposed to the
 * client over a small same-origin JSON API:
 *
 *   GET  /session-cleaner/api/workspaces   workspace list + current membership
 *   POST /session-cleaner/api/move         { sessionId, targetWorkspaceId }
 *   POST /session-cleaner/api/delete       { sessionId }
 *
 * `delete` is thorough: live teardown, workspace/archive/pin accounting, the
 * whole artifact directory, and the projection-cache leftovers that DSH has
 * no eviction API for.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deleteSessionData, listWorkspaces, moveSessionToWorkspace } from './ops.js'

export const name = 'dsh-session-cleaner'

export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'agents', 'sessionPersistence']

const API_PREFIX = '/session-cleaner/api'
const MAX_BODY = 64 * 1024

const readBody = async req => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw Object.assign(new Error('请求体过大'), { code: 'body-too-large' })
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const send = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const describe = error => (error && (error.message ?? String(error))) || 'unknown error'

const statusFor = code => (code === 'bad-request' ? 400
  : code === 'session-not-found' || code === 'workspace-not-found' ? 404
    : code === 'unsafe-path' || code === 'torn-artifact' || code === 'corrupt-artifact' ? 409
      : 500)

export function apply(ctx, config = {}) {
  const dshHome = () => config.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const homePath = segment => (segment === undefined ? dshHome() : join(dshHome(), segment))

  const deps = {
    persistence: ctx.sessionPersistence,
    registry: ctx.workspaceRegistry,
    sessions: ctx.sessions,
    agents: ctx.agents,
    emit: (event, payload) => ctx.emit(event, payload),
    logger: ctx.logger,
    homePath,
    dshHome: dshHome()
  }

  /** Serialize mutations per session id. */
  const pending = new Map()
  const mutate = (sessionId, operation) => {
    const previous = pending.get(sessionId) ?? Promise.resolve()
    const current = previous.then(operation)
    const settled = current.catch(() => {}).finally(() => {
      if (pending.get(sessionId) === settled) pending.delete(sessionId)
    })
    pending.set(sessionId, settled)
    return current
  }

  const currentWorkspaceIdOf = async sessionId => {
    const direct = listWorkspaces(ctx.workspaceRegistry).find(workspace => workspace.sessionIds.includes(sessionId))
    if (direct !== undefined) return direct.id
    let header
    try { header = ctx.workspaceRegistry?.headers?.get?.(sessionId) } catch { header = undefined }
    const cwd = header?.cwd
    if (typeof cwd !== 'string') return undefined
    const match = listWorkspaces(ctx.workspaceRegistry).find(workspace => workspace.path === cwd)
    return match?.id
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : '/'
        let body = {}
        if (req.method === 'POST') {
          const raw = await readBody(req)
          if (raw.trim() !== '') {
            try { body = JSON.parse(raw) }
            catch { return send(res, 400, { ok: false, error: '请求体不是合法 JSON', code: 'bad-request' }) }
          }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return send(res, 400, { ok: false, error: '请求体必须是 JSON 对象', code: 'bad-request' })
        }

        if (req.method === 'GET' && path === '/workspaces') {
          const sessionId = url.searchParams.get('sessionId') ?? undefined
          return send(res, 200, {
            ok: true,
            result: {
              workspaces: listWorkspaces(ctx.workspaceRegistry),
              currentWorkspaceId: sessionId === undefined ? undefined : await currentWorkspaceIdOf(sessionId)
            }
          })
        }

        if (req.method === 'POST' && path === '/move') {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          const targetWorkspaceId = typeof body.targetWorkspaceId === 'string' ? body.targetWorkspaceId.trim() : ''
          if (sessionId === '' || targetWorkspaceId === '') {
            return send(res, 400, { ok: false, error: 'sessionId 与 targetWorkspaceId 必填', code: 'bad-request' })
          }
          const result = await mutate(sessionId, () => moveSessionToWorkspace({ sessionId, targetWorkspaceId, deps }))
          // The cache row carries the session identity ({createdAt, cwd}); refold it.
          try { await ctx.get('sessionProjectionCache')?.coldSnapshot?.(sessionId) } catch { /* best effort */ }
          try { ctx.logger?.info?.(`session-cleaner: moved ${sessionId} -> ${targetWorkspaceId}`) } catch { /* ignore */ }
          return send(res, 200, { ok: true, result })
        }

        if (req.method === 'POST' && path === '/delete') {
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (sessionId === '') return send(res, 400, { ok: false, error: 'sessionId 必填', code: 'bad-request' })
          const result = await mutate(sessionId, () => deleteSessionData({
            sessionId,
            deps,
            options: { purgeProjectionCache: config.purgeProjectionCache !== false }
          }))
          try { ctx.logger?.info?.(`session-cleaner: deleted ${sessionId} (artifact=${result.artifactRemoved ?? 'none'})`) } catch { /* ignore */ }
          return send(res, 200, { ok: true, result })
        }

        return send(res, 404, { ok: false, error: `未知接口: ${req.method} ${path}`, code: 'not-found' })
      } catch (error) {
        const code = error?.code ?? 'internal-error'
        try { ctx.logger?.warn?.(`session-cleaner: ${describe(error)}`) } catch { /* ignore */ }
        return send(res, statusFor(code), { ok: false, error: describe(error), code })
      }
    }
  }), 'session-cleaner: api routes')
}
