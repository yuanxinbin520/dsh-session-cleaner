/**
 * Ident-ity guard for the client bundle.
 *
 * DSH's client module system keys every boot-graph row by the PACKAGE NAME and
 * looks the bundle's factory up under exactly that key:
 *
 *   ClientModuleRegistry.reconcilePackage  -> table.set(packageName, { entry: graphRow(packageName, ...) })
 *   ClientModuleSystem.register({id})      -> factories.set(stripClientSuffix(id), ...)
 *   ClientModuleSystem.arrive(row)         -> guarded by factories.has(row.id)
 *
 * So `id` must equal package.json's `name` character for character (scope
 * included; only a trailing `/client` is normalized away). A mismatch never
 * registers the row, so `arrive` retries on the row's own URL, the bundle
 * executes a second time and throws
 *
 *   client-modules: duplicate factory registration for "<id>" (bundle executed twice without invalidate?)
 *
 * which aborts the whole web boot with `web boot: 1 entry did not activate`
 * (the desktop then shows its fatal-recovery dialog).
 *
 *   node test/verify-client-id.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The shell's frozen module table (`PLATFORM_MODULES`), i.e. everything a client bundle may require. */
const PLATFORM_SEEDS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit'
])

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const pkg = JSON.parse(read('package.json'))
const name = pkg.name
const client = read('lib/client.js')

let failed = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

console.log(`package name: ${name}\n`)

const registrations = [...client.matchAll(/__ModuleLoader__\.load\(\s*\{/g)]
check('lib/client.js registers exactly one module', registrations.length === 1, `found ${registrations.length}`)

const id = /__ModuleLoader__\.load\(\s*\{\s*id:\s*(['"])([^'"]+)\1/.exec(client)?.[2]
check('module id equals the package name', id === name, `id=${JSON.stringify(id)} name=${JSON.stringify(name)}`)

check(
  'registration uses the factory form `factory: (require) =>`',
  /__ModuleLoader__\.load\(\s*\{\s*id:\s*(['"])[^'"]+\1\s*,\s*factory:\s*\(?\s*require\s*\)?\s*=>/.test(client)
)

const patch = read('cordis.patch.yml')
check(
  'cordis.patch.yml inserts this package by name',
  [`name: "${name}"`, `name: '${name}'`, `name: ${name}`].some(line => patch.includes(line))
)

// package.json must declare a ./client export, or DSH never sees the bundle at all.
check('./client export points at lib/client.js', pkg.exports?.['./client']?.default === './lib/client.js')
check('dsh.client.platform is "web"', pkg.dsh?.client?.platform === 'web')

const required = [...client.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)].map(match => match[2])
const foreign = [...new Set(required)].filter(specifier => !specifier.startsWith('./') && !specifier.startsWith('../') && !PLATFORM_SEEDS.has(specifier))
check(
  'every bare require is a platform seed word',
  foreign.length === 0,
  foreign.length === 0 ? undefined : `not in PLATFORM_MODULES: ${foreign.join(', ')} (declare dsh.client.external only for rows that provide them)`
)

console.log(failed === 0 ? '\nclient bundle identity OK' : `\n${failed} check(s) failed`)
if (failed > 0) process.exit(1)
