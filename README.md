# dsh-session-cleaner

[中文说明](README.zh-CN.md) | English

A deliberately small [DeepSeek Harness](https://github.com/deepseek-ai) plugin that adds exactly two
actions to a Session's `…` menu, below the shipped **Rename / Archive** rows:

| Menu row | Order | What it does |
| --- | --- | --- |
| **Move to another workspace…** | 500 | A real cross-workspace move: rewrites the session's `cwd`, relocates the artifact, swaps workspace accounting |
| **Thoroughly delete session…** | 600 | Permanently deletes the session and every derived artifact, behind a confirmation dialog |

The shipped rows occupy `pin` (100) / `rename` (200) / `fork` (300) / `archive` (400); this plugin
registers at 500 and 600, and the first row carries `separatorBefore`, so both appear as their own
group at the bottom of the menu.

## Config switches

**Settings → Plugins → Plugin configuration** shows one more card from this plugin: **config switches**. It does one small thing — it writes a patch fragment into the active profile's `cordis.patch.yml` and can toggle it at any time.

- **Hot by design**: DSH watches the profile patch layer (`patchReload: live`) and recomposes within about a second, so no restart is involved — and it is not limited to new sessions; a running session's tool set follows the change too.
- **One switch = one YAML fragment**: the fragment may start with `- insert:` or `- id:`; the plugin derives the row ids from the fragment's `id:` lines and expresses on/off as `- id: <row>` + `disabled: true|false` rows inside its own block. A fragment that carries an `id` can also disable any existing row of the profile.
- **Card actions**: enable / disable, view the fragment, delete, add (name + optional id + fragment). Every write backs up `cordis.patch.yml` to `cordis.patch.yml.bak-<timestamp>` and replaces the file atomically; hand-written rows outside the managed blocks are preserved verbatim.
- **On disk**: state in `<DSH_HOME>/config-switches/switches.json`, patch in `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`.
- **Bundled example**: `DBX MCP 工具` mounts `@deepseek-ai/dsh-mcp-client` on the host layer (global tools), so every mode — standard included — gets the `mcp__dbx__*` tools; it costs roughly 28K tokens of tool definitions per turn, so turn it off when unused.

## Install

```
# from npm — recommended, and it needs no GitHub access
dsh plugin --profile web add @beiwen/dsh-session-cleaner

# straight from GitHub, pinned to a release tag
dsh plugin --profile web add github:yuanxinbin520/dsh-session-cleaner#v0.1.2

# over HTTPS — use this when SSH port 22 is blocked on your network
dsh plugin --profile web add https://github.com/yuanxinbin520/dsh-session-cleaner.git
```

> The npm package is published under the author's npm scope as **`@beiwen/dsh-session-cleaner`**. The
> unscoped name `dsh-session-cleaner` on npm belongs to an unrelated package, so always use the full
> scoped spec (or a GitHub spec) — a bare `dsh-session-cleaner` would install someone else's plugin.

If a `github:` install fails with `ssh: connect to host github.com port 22: Connection refused`, use the
HTTPS form above, or route SSH over port 443 by adding this to `~/.ssh/config`:

```
Host github.com
  HostName ssh.github.com
  Port 443
```

On Windows behind a TLS-inspecting proxy, `git` may instead fail with
`SSL certificate problem: unable to get local issuer certificate`. Point just GitHub at the Windows
certificate store with:

```
git config --global 'http.https://github.com/.sslBackend' schannel
```

(the broader `git config --global http.sslBackend schannel` works too), or use the npm spec above, which
skips git entirely.

The **desktop** profile is managed exclusively by the Electron app, so `dsh plugin --profile desktop`
refuses; install it from **Settings → Plugins** instead (paste `@beiwen/dsh-session-cleaner`, with
the registry set to the npm mirror if GitHub is unreachable), or let the plugin manager run
`install_bundle @beiwen/dsh-session-cleaner`. A profile restart (or a page refresh for the client
half) activates it.

Requirements: DSH `>= 0.2.0-rc.1` (tested on `0.2.0-rc.2`), Node `>= 22.15` (uses the built-in
`node:zlib` Zstandard API — no dependencies, no build step).

## What "thoroughly delete" removes

The confirmation dialog states the scope up front, and the result view reports what was removed:

| Data | Handling |
| --- | --- |
| Session log directory (`$DSH_HOME/sessions/<project>/session-<id>/`) | Removed entirely, including every generation (v4/v3/v2/v1) plus temp/backup files |
| Live session / agent | `cancel` + `dispose`, dropped from the agent registry, `session/disposed` broadcast so the client drops the row immediately |
| Workspace membership | Removed from every workspace's `sessionIds` |
| Archive / pin markers | Removed from `archivedSessionIds` and `pinnedSessionIds` |
| Projection cache (per session) | `$DSH_HOME/storages/session_projcache/sessions/<id>.json` (and `.lock`/`.tmp`) deleted |
| Projection cache (legacy aggregate) | Row deleted from `storages/session_projcache.json`'s `tables.sessions`, after writing a `.bak` |

The `attachments/` and `cache/` trees are content-addressed and shared between sessions, so nothing
there belongs to a single session.

Safety boundaries:

- A directory is only deleted when the artifact's **header line proves the id**; otherwise the plugin
  reports `existed: false` and leaves it untouched (junk or corrupt directories are never guessed at).
- The directory must be exactly `<sessions>/<project>/<session>`, and neither child level may be a
  symlink/junction (re-checked immediately before the destructive call).
- Session ids are validated against path traversal (`../evil` → HTTP 400).
- Deletion locates the session by reading **only the header frame**, so a truncated log is still
  deletable; the move path decodes the whole log and refuses to rewrite a truncated one.

## Move semantics

DSH derives workspace membership from the immutable `cwd` in the session header, so a registry-only
edit would be reverted by the next reconciliation. A move is therefore a real migration:

1. Source/target directories are validated; an existing target artifact is never overwritten.
2. The full multi-frame log is decoded and the header's `cwd` rewritten, with the format generation
   (`v3`/`v4`) kept in sync with the filename.
3. The artifact is published atomically (old file hidden first; a failure restores it).
4. A **live** session is not torn down: its in-memory header and writer handle are retargeted in place,
   so later events land in the new file.
5. Workspace accounting is swapped (detach from the old workspace, attach to the target). Any failure
   rolls the whole move back.
6. The old directory is cleaned up and the projection cache refolded.

No page refresh is needed after moving an open session.

## Host API

The host half registers a prefix route on `ctx.webServer`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/session-cleaner/api/workspaces?sessionId=…` | Workspace list + the session's current workspace |
| POST | `/session-cleaner/api/move` | `{ sessionId, targetWorkspaceId }` |
| POST | `/session-cleaner/api/delete` | `{ sessionId }` |
| GET | `/session-cleaner/api/switches` | Switch list + target profile and patch path |
| POST | `/session-cleaner/api/switches/toggle` | `{ id, enabled }` |
| POST | `/session-cleaner/api/switches/add` | `{ id?, name, description?, insert }` |
| POST | `/session-cleaner/api/switches/remove` | `{ id }` |

Same-origin `fetch`, no extra auth header; mutations are serialized per session id.

## Development

```
npm run check                    # syntax check both halves
node test/verify-artifacts.mjs   # decode -> re-encode -> decode round-trip over real logs
node test/verify-ops.mjs         # delete / move / truncated log / path safety on a temp fixture
node test/verify-switches.mjs    # switch engine: block composition, idempotence, disabled-only flips
```

`test/verify-artifacts.mjs` is the test that protects the move path: DSH's `.jsonl.zstd` files are
**concatenated frames, one per durable batch** (one measured log was 9.9 MB / 7189 frames / 35.6 MB
decoded). Any decoder that reads only the first frame silently reduces a log to its header line, so
this suite asserts a byte-identical round-trip. Both suites are self-contained: without a DSH install
the ops suite builds its own synthetic 2001-frame log, so CI needs no Harness.

## Known limitations

- Deleting the session you currently have open removes its row; the view can stay on an empty
  conversation until you refresh.
- If the host rewrites the aggregate `session_projcache.json` while running, a pruned row may
  reappear; the per-session files are unaffected (cleaning while DSH is stopped is the safest).
- Requires a `sessionPersistence` backend exposing `locate()`; without it the plugin errors out
  instead of deleting blindly.
- No batch operations (use a session-manager style plugin for bulk work).

## License

MIT — see [LICENSE](LICENSE).
