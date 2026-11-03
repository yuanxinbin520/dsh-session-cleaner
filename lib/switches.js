/**
 * dsh-session-cleaner — Config switches engine.
 *
 * A "config switch" is one named fragment of the profile's user patch layer
 * (`<DSH_HOME>/profiles/<profile>/cordis.patch.yml`) that the user can turn on
 * and off from 设置 → 插件 → 插件配置 without restarting DSH: the profile patch
 * layer is hot-reloaded (`patchReload: "live"`), so a rewritten block re-composes
 * the boot graph about a second later.
 *
 * Representation inside the patch file — one managed block per switch:
 *
 *   # >>> dsh-switch:mcp-dbx (managed by @beiwen/dsh-session-cleaner)
 *   - insert:
 *       - id: mcp-dbx-global
 *         name: "@deepseek-ai/dsh-mcp-client"
 *   - id: mcp-dbx-global
 *     disabled: false
 *   # <<< dsh-switch:mcp-dbx
 *
 * The `- insert:` row (no top-level `id`) pushes the fragment's entries into the
 * boot include; the rows below it then address those entries by id, so flipping
 * `disabled` is enough to turn a switch on or off. Both halves come from the
 * loader's patch semantics, and dshmarket writes its toggles the same way.
 *
 * Switch definitions themselves are user data, not plugin code:
 * `<DSH_HOME>/config-switches/switches.json`. Every mutation is serialized,
 * written atomically, and only ever rewrites the managed blocks — the rest of
 * the patch file belongs to the user.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Marker line opening one managed block. */
export const beginOf = id => `# >>> dsh-switch:${id} — managed by @beiwen/dsh-session-cleaner; edits inside are overwritten`

/** Marker line closing one managed block. */
export const endOf = id => `# <<< dsh-switch:${id}`

/** The switch the plugin ships as an example: the DBX MCP server on the host layer. */
export const DBX_MCP_INSERT = [
  '- id: mcp-dbx-global',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: dbx',
  '    transport: stdio',
  "    command: !!js process.env.USERPROFILE + '\\\\.dbx\\\\bin\\\\dbx-mcp.exe'"
].join('\n')

/** Switch ids become file names and comment text, so keep them boring. */
const SWITCH_ID = /^[a-z0-9][a-z0-9-]*$/
/** Profile ids are directory names under `<DSH_HOME>/profiles`. */
const PROFILE_ID = /^[A-Za-z0-9._-]+$/

const fail = (message, code) => Object.assign(new Error(message), { code })

/** Resolve every path the engine touches for one profile. */
export const resolvePaths = ({ dshHome, profile }) => {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') throw fail('dshHome 缺失', 'bad-request')
  const name = typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : 'desktop'
  if (!PROFILE_ID.test(name)) throw fail(`profile 名称不合法: ${name}`, 'bad-request')
  const switchesDir = join(dshHome, 'config-switches')
  return {
    profile: name,
    switchesDir,
    statePath: join(switchesDir, 'switches.json'),
    patchPath: join(dshHome, 'profiles', name, 'cordis.patch.yml')
  }
}

/** The switch set a fresh install starts with (all off: nothing enters the boot graph unasked). */
export const defaultSwitches = () => [{
  id: 'mcp-dbx',
  name: 'DBX MCP 工具',
  description: '把 DBX 的 MCP 服务挂到宿主层，所有模式（含标准模式）都能用 dbx_* 工具，代价是每轮多约 28K tokens 的工具定义。',
  enabled: false,
  rows: ['mcp-dbx-global'],
  insert: DBX_MCP_INSERT
}]

/** Validate one switch record; throws on anything the renderer cannot trust. */
export const normalizeSwitch = (raw, { requireId = true } = {}) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw fail('开关定义必须是对象', 'bad-request')
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (requireId && !SWITCH_ID.test(id)) throw fail(`开关 id 不合法: ${id || '(空)'}（只允许小写字母、数字和连字符）`, 'bad-request')
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name === '') throw fail('开关名称不能为空', 'bad-request')
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const insert = typeof raw.insert === 'string' ? raw.insert.replace(/\r\n/g, '\n').replace(/\s+$/, '') : ''
  if (insert === '') throw fail('开关片段不能为空', 'bad-request')
  const lines = insert.split('\n')
  if (lines.some(line => line.includes('dsh-switch:'))) throw fail('开关片段里不能出现插件标记', 'bad-request')
  if (lines.some(line => line.startsWith('\t'))) throw fail('开关片段不能用制表符缩进', 'bad-request')
  if (lines.some(line => line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('-'))) {
    throw fail('开关片段必须是 YAML 列表项（以 "- " 开头，续行缩进）', 'bad-request')
  }
  if (!lines[0].startsWith('- ')) throw fail('开关片段第一行必须是列表项（以 "- " 开头）', 'bad-request')
  const rows = rowsOf(insert)
  if (rows.length === 0) throw fail('开关片段里没有可开关的行：每一段都需要一个 id', 'bad-request')
  return {
    id,
    name,
    description,
    enabled: raw.enabled === true,
    rows,
    insert
  }
}

/** Every entry id declared inside an insert fragment, in order. */
const rowsOf = insert => {
  const ids = []
  const pattern = /^\s*(?:-\s+)?id:\s*['"]?([A-Za-z0-9_][A-Za-z0-9_.:-]*)/gm
  let match
  while ((match = pattern.exec(insert)) !== null) ids.push(match[1])
  return [...new Set(ids)]
}

/** Render one managed block for a switch. */
export const renderBlock = sw => {
  const entries = sw.insert.split('\n').map(line => (line === '' ? '' : `    ${line}`)).join('\n')
  const rows = sw.rows.map(row => `- id: ${row}\n  disabled: ${sw.enabled ? 'false' : 'true'}`).join('\n')
  return [beginOf(sw.id), '- insert:', entries, rows, endOf(sw.id)].join('\n')
}

/** Remove the managed blocks from a patch document, keeping the user's own lines. */
export const stripBlocks = (text, ids = null) => {
  const wanted = ids === null ? null : new Set(ids)
  const kept = []
  let skipping = null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (skipping === null) {
      const begin = trimmed.match(/^# >>> dsh-switch:([^\s—-]+)/)
      if (begin !== null && (wanted === null || wanted.has(begin[1]))) { skipping = begin[1]; continue }
      kept.push(line)
      continue
    }
    if (trimmed === endOf(skipping)) skipping = null
  }
  return kept.join('\n')
}

/** Rewrite the patch document so every switch in `switches` owns exactly one fresh block. */
export const composePatch = (text, switches) => {
  let base = stripBlocks(text).replace(/\s+$/, '')
  const blocks = switches.map(renderBlock)
  if (blocks.length === 0) return base === '' ? '' : `${base}\n`
  // The profile template seeds this layer with an empty-list literal (`[]`).
  // A document cannot hold both that and list items, so drop it while blocks
  // are present; leaving it in would make the whole patch layer invalid YAML.
  base = base.replace(/\n?[ \t]*\[\][ \t]*$/, '').replace(/\s+$/, '')
  return `${base === '' ? '' : `${base}\n\n`}${blocks.join('\n\n')}\n`
}

/** Write a file atomically: temp file beside it, then rename over the target. */
export const writeAtomic = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** Read the switch state, falling back to the shipped defaults when the file is absent. */
export const readState = statePath => {
  if (!existsSync(statePath)) return { version: 1, switches: defaultSwitches() }
  let parsed
  try { parsed = JSON.parse(readFileSync(statePath, 'utf8')) }
  catch { throw fail(`开关配置不是合法 JSON: ${statePath}`, 'switch-state-corrupt') }
  const raw = Array.isArray(parsed?.switches) ? parsed.switches : []
  const switches = raw.map(item => normalizeSwitch(item, { requireId: true }))
  return { version: 1, switches }
}

/** Persist switch state atomically. */
export const writeState = (statePath, switches) => {
  writeAtomic(statePath, `${JSON.stringify({ version: 1, switches }, null, 2)}\n`)
}

/** Apply the full switch set to one profile patch file. */
export const syncPatch = ({ patchPath }, switches) => {
  const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const next = composePatch(current, switches)
  if (next !== current) writeAtomic(patchPath, next)
  return next
}

/** Serialize mutations so two clicks cannot interleave a read and a write. */
const queue = new Map()

/** Run `operation` after every earlier operation on the same state file settled. */
const serialize = (key, operation) => {
  const previous = queue.get(key) ?? Promise.resolve()
  const current = previous.then(operation)
  const settled = current.catch(() => {}).finally(() => {
    if (queue.get(key) === settled) queue.delete(key)
  })
  queue.set(key, settled)
  return current
}

/** List switches plus the profile they target. */
export const listSwitches = options => {
  const paths = resolvePaths(options)
  const state = readState(paths.statePath)
  return { ...paths, switches: state.switches }
}

/** Turn one switch on or off, then re-compose the patch file. */
export const setSwitch = (options, id, enabled) => {
  const paths = resolvePaths(options)
  if (typeof id !== 'string' || !SWITCH_ID.test(id)) throw fail(`开关 id 不合法: ${id ?? '(空)'}`, 'bad-request')
  return serialize(paths.statePath, () => {
    const state = readState(paths.statePath)
    const target = state.switches.find(sw => sw.id === id)
    if (target === undefined) throw fail(`没有这个开关: ${id}`, 'switch-not-found')
    target.enabled = enabled === true
    syncPatch(paths, state.switches)
    writeState(paths.statePath, state.switches)
    return target
  })
}

/** Add (or replace) one switch definition and re-compose the patch file. */
export const addSwitch = (options, raw) => {
  const paths = resolvePaths(options)
  const sw = normalizeSwitch(raw, { requireId: (raw?.id ?? '') !== '' })
  const draft = { ...sw }
  if (draft.id === '') draft.id = `switch-${Date.now().toString(36)}`
  if (!SWITCH_ID.test(draft.id)) throw fail(`开关 id 不合法: ${draft.id}`, 'bad-request')
  return serialize(paths.statePath, () => {
    const state = readState(paths.statePath)
    const index = state.switches.findIndex(item => item.id === draft.id)
    if (index >= 0) state.switches[index] = draft
    else state.switches.push(draft)
    syncPatch(paths, state.switches)
    writeState(paths.statePath, state.switches)
    return draft
  })
}

/** Remove one switch and its managed block. */
export const removeSwitch = (options, id) => {
  const paths = resolvePaths(options)
  if (typeof id !== 'string' || !SWITCH_ID.test(id)) throw fail(`开关 id 不合法: ${id ?? '(空)'}`, 'bad-request')
  return serialize(paths.statePath, () => {
    const state = readState(paths.statePath)
    const remaining = state.switches.filter(sw => sw.id !== id)
    if (remaining.length === state.switches.length) throw fail(`没有这个开关: ${id}`, 'switch-not-found')
    syncPatch(paths, remaining)
    writeState(paths.statePath, remaining)
    return { id }
  })
}
