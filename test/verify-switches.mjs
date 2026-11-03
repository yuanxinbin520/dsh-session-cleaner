/**
 * Config-switch engine verification (no DSH needed, no network, no deps).
 *
 * Builds a throw-away `DSH_HOME` with one profile whose patch file already
 * carries the user's own lines, then exercises the whole surface: defaults,
 * on/off round trips (including idempotent re-apply), add, remove, marker
 * hygiene, and the rejections that keep a bad fragment out of the boot graph.
 *
 *   node test/verify-switches.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addSwitch,
  beginOf,
  composePatch,
  defaultSwitches,
  endOf,
  listSwitches,
  removeSwitch,
  renderBlock,
  resolvePaths,
  setSwitch,
  updateSwitch
} from '../lib/switches.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-switches-'))
const dshHome = path.join(root, '.dsh')
const profile = 'desktop'
const profileDir = path.join(dshHome, 'profiles', profile)
fs.mkdirSync(profileDir, { recursive: true })

const USER_PATCH = [
  '# hand-written by the user: stays exactly where it is',
  '- insert:',
  '    - id: session-cleaner',
  '      name: "@beiwen/dsh-session-cleaner"',
  '- id: dsh-market',
  '  disabled: false',
  ''
].join('\n')
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), USER_PATCH, 'utf8')

const options = { dshHome, profile }
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const read = () => fs.readFileSync(patchPath, 'utf8')

let passed = 0
let failed = 0
const check = (label, condition, detail) => {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); return }
  failed += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `: ${detail}`}`)
}
const throws = async (label, code, run) => {
  try { await run() } catch (error) {
    check(label, error?.code === code, `code=${error?.code} message=${error?.message}`)
    return
  }
  check(label, false, 'did not throw')
}
/** Every managed block is well formed: marker pair, insert row, one row per entry. */
const blockShape = (text, id) => {
  const lines = text.split('\n')
  const begin = lines.indexOf(beginOf(id))
  const end = lines.indexOf(endOf(id))
  if (begin < 0 || end < 0 || end <= begin) return 'markers missing'
  const body = lines.slice(begin + 1, end)
  if (body[0] !== '- insert:') return `first line is ${JSON.stringify(body[0])}`
  const disabled = body.filter(line => line.startsWith('  disabled: ')).length
  const entries = body.filter(line => line.startsWith('    - id: ')).length
  if (disabled !== entries) return `${entries} entries but ${disabled} disabled rows`
  return null
}

console.log(`workspace: ${root}\n`)

const paths = resolvePaths(options)
check('paths resolve under DSH_HOME', paths.patchPath === patchPath && paths.switchesDir === path.join(dshHome, 'config-switches'))

const initial = listSwitches(options)
check('defaults: one shipped switch, off', initial.switches.length === 1 && initial.switches[0].id === 'mcp-dbx' && initial.switches[0].enabled === false)
check('defaults derived rows from the fragment', JSON.stringify(initial.switches[0].rows) === JSON.stringify(['mcp-dbx-global']))
check('listing does not touch the patch file', read() === USER_PATCH)

const switchedOn = await setSwitch(options, 'mcp-dbx', true)
const afterOn = read()
check('toggle on returns the switch', switchedOn.enabled === true)
check('on: user lines intact', afterOn.startsWith(USER_PATCH.trimEnd()))
check('on: block shape', blockShape(afterOn, 'mcp-dbx') === null, blockShape(afterOn, 'mcp-dbx'))
check('on: disabled row is false', afterOn.includes('- id: mcp-dbx-global\n  disabled: false'))
check('on: fragment entry nested under insert', afterOn.includes('    - id: mcp-dbx-global\n      name: "@deepseek-ai/dsh-mcp-client"'))
check('on: JS expression kept verbatim', afterOn.includes('!!js process.env.USERPROFILE'))

const afterOnBytes = read()
await setSwitch(options, 'mcp-dbx', true)
check('re-applying on is a no-op', read() === afterOnBytes)

await setSwitch(options, 'mcp-dbx', false)
const afterOff = read()
check('off: block kept, row flipped', afterOff.includes('- id: mcp-dbx-global\n  disabled: true'))
check('off: only one managed block', afterOff.split(beginOf('mcp-dbx')).length === 2)
check('off: user lines intact', afterOff.startsWith(USER_PATCH.trimEnd()))

const added = await addSwitch(options, {
  name: '示例开关',
  description: 'test fragment',
  insert: '- id: example-row\n  name: "@example/plugin"\n  config:\n    flag: true'
})
const afterAdd = read()
check('add: generated id when omitted', /^switch-[a-z0-9]+$/.test(added.id), added.id)
const occurrences = (text, needle) => text.split(needle).length - 1
check('add: second block appended', occurrences(afterAdd, '- insert:') === 3, `got ${occurrences(afterAdd, '- insert:')}`)
check('add: new block available in the listing', listSwitches(options).switches.some(sw => sw.id === added.id))

await setSwitch(options, added.id, true)
check('add: toggled on', read().includes('- id: example-row\n  disabled: false'))

const updated = await updateSwitch(options, added.id, {
  name: '示例开关（已改）',
  insert: '- id: example-row\n  name: "@example/plugin"\n  config:\n    flag: false'
})
const afterUpdate = read()
check('update: keeps the same id and on/off state', updated.id === added.id && updated.enabled === true)
check('update: name replaced', updated.name === '示例开关（已改）')
check('update: fragment replaced in the patch', afterUpdate.includes('flag: false') && !afterUpdate.includes('flag: true'))
check('update: row still toggled on', afterUpdate.includes('- id: example-row\n  disabled: false'))
check('update: second row id derived from the new fragment', JSON.stringify(updated.rows) === JSON.stringify(['example-row']))
check('update: description kept when omitted', updated.description === 'test fragment')
check('update: user lines intact', afterUpdate.startsWith(USER_PATCH.trimEnd()))
check('update: listing reflects the new name', listSwitches(options).switches.some(sw => sw.id === added.id && sw.name === '示例开关（已改）'))

await removeSwitch(options, added.id)
check('remove: block gone', !read().includes('example-row'))
check('remove: remaining switch survives', read().includes(beginOf('mcp-dbx')))
await removeSwitch(options, 'mcp-dbx')
check('remove: user patch restored byte for byte', read() === USER_PATCH)

check('composePatch strips managed blocks but keeps plugin rows', (() => {
  const text = `${USER_PATCH}${renderBlock(defaultSwitches()[0])}\n`
  const next = composePatch(text, [])
  return next === `${USER_PATCH.trimEnd()}\n`
})())

check('composePatch drops the template empty-list literal', (() => {
  // A freshly initialized profile seeds the layer with `[]`, which cannot sit
  // alongside list items; the composed document must stay valid YAML.
  const template = '# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n'
  const next = composePatch(template, [defaultSwitches()[0]])
  return next.includes('- insert:') && !next.split('\n').includes('[]')
})())

throws('rejects a fragment without a list item', 'bad-request', () => addSwitch(options, { name: 'x', insert: 'id: nope' }))
throws('rejects a fragment without ids', 'bad-request', () => addSwitch(options, { name: 'x', insert: '- name: "@x/y"' }))
throws('rejects tab indentation', 'bad-request', () => addSwitch(options, { name: 'x', insert: '- id: y\n\tname: "@x/y"' }))
throws('rejects an unsafe id', 'bad-request', () => setSwitch(options, '../escape', true))
throws('rejects updating an unknown switch', 'switch-not-found', () => updateSwitch(options, 'not-there', { name: 'x' }))
throws('rejects an update without ids in the fragment', 'bad-request', () => updateSwitch(options, 'mcp-dbx', { insert: '- name: "@x/y"' }))
throws('rejects a missing switch', 'switch-not-found', () => setSwitch(options, 'not-there', true))

fs.writeFileSync(path.join(dshHome, 'config-switches', 'switches.json'), '{not json', 'utf8')
throws('reports a corrupt state file', 'switch-state-corrupt', () => listSwitches(options))

console.log(`\n${passed} passed, ${failed} failed`)
fs.rmSync(root, { recursive: true, force: true })
if (failed > 0) process.exit(1)
