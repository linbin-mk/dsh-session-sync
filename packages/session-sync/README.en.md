English | [简体中文](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/session-sync/README.md)

# @linbin-mk/dsh-session-sync

[![npm version](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![license](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)

The host half of the dsh-session-sync plugin: a git-backed automatic session-sync service (`ctx.sessionSync`) for DeepSeek Harness.

See the [repository README](https://github.com/linbin-mk/dsh-session-sync#readme) for the architecture, composition, and installation, and [`docs/spec/session-sync-v2.md`](../../docs/spec/session-sync-v2.md) for the implementation contract. This package exports:

- `SessionSyncService` (default): the cordis service — live configuration of the profile row, timers, single-flight cycles, the same-origin HTTP routes, and the `session-sync/completed` event.
- The engine (`decideSelectionSync`, `assignWorkspaceKey`, `foldTitle`, `compareLogs`, `runSyncCycle`), the repo format helpers (`parseSelection`/`serializeSelection`, `parseManifest`/`serializeManifest`, `parseRecords`/`mergeRecords`/`serializeRecords`, `parseState`/`serializeState`, `parseLocalSelection`/`serializeLocalSelection`), `GitRepository`/`GitError`, and the configuration contract (`Config`/`ConfigInput`, `SESSION_SYNC_NAMESPACE`, `readSettings`, `validateSessionSyncSettings`).
- The selection-tree projection (`buildSelectionView`, `SelectionTreeInput`): the grouping rules behind the settings page's "Synced sessions" tree, pure functions.
- The switch notice (`SWITCH_NOTICE_TEXT`, `createSwitchNoticeMessage`, `withSwitchNotice`): one `notice` message under this package's own source kind, injected into the first chat after a machine switch.
- The HTTP surface (`registerSessionSyncRoutes`, route constants, `parseSessionRoute`, wire types), registered on the harness's open route seam when a `webServer` is mounted.

The browser half lives **in this same package**: `exports["./client"]` is the bundle the Web client loads (`lib/client.js`), declared by `dsh.client`. It used to be the separate `@linbin-mk/dsh-client-ui-settings-sync`, merged here in v0.6.0; that package receives no further releases — on upgrade, remove its old row first with `dsh plugin --profile <name> remove @linbin-mk/dsh-client-ui-settings-sync`.

## Composition

```yaml
- id: session-sync
  name: '@linbin-mk/dsh-session-sync'
  config:
    startupSyncDelayMs: 3000
```

`startupSyncDelayMs` in `config` is a deployment choice; `enabled`, `remote`, `branch`, `intervalMinutes`, and `cleanup` are the live fields the settings page writes, persisted by the harness settings service into the profile patch document. Requires DeepSeek Harness `0.1.7-rc.2` (peers: `@deepseek-ai/cordis ^4.0.4`, `@deepseek-ai/schemastery ^3.18.4`, `cordis-plugin-loader ^1.0.5`, `cordis-plugin-include ^1.0.9`). Requires the `settings` and `sessionPersistence` services; `workspaceRegistry` is the placement capability (matching by name, resolving a workspace from a cwd, and applying archive marks all need it, and without it both export and import are skipped and reported); `sessionProjectionCache` is optional (pre-warmed after an import, and the settings page also uses it to read titles with zero I/O). A `webServer` is optional too — without one the plugin runs headless and simply serves no web routes. The switch notice listens on the harness `agent/pre-step` event (`dsh-agent`/`dsh-llm` peers): a deployment without agent services simply never fires an injection.

## Repository format v2

```text
sync.json                                    Cross-machine sync set (whole-snapshot, replaces v1's pinned.json)
workspaces/<key>/manifest.json               { version, key, name, updatedAt }   ← name is the source of truth for matching
workspaces/<key>/session-<id>.jsonl          Session artifact
workspaces/<key>/session-<id>.records.json   That session's sync records (machine + time, newest 20)
workspaces/<key>/archived.json               { "version": 1, "sessionIds": [...] }  grow-only union
conflicts/<key>/<session-id>-<host>.jsonl
```

Each session artifact starts with a `dsh-session-sync` versioned header (version 2) containing the stable workspace key, the current public Session header fields, and `inheritedEventCount`; each remaining line is one logical `SessionEvent`. It never embeds any persistence backend's physical row encoding. v1 artifacts (the `project` field, the `projects/` directory, `pinned.json`) are rejected outright, with no migration.

Every `sync.json` entry carries `id`, `key`, `workspaceName`, `title`, `addedAt`, `addedBy`: the artifact header has no title, while the set includes sessions this machine has not imported yet — so the title has to travel with the snapshot for the settings page to draw the full list offline.

Selection convergence: the snapshot is whole rather than a union, so "close sync" can propagate. Each machine keeps `selection.json` (its own set) and `state.json` (the anchor: the selection it last actually applied, the ids this machine owns, and the workspace→key memory) under the harness home. A local set that differs from the anchor is a local edit, so it publishes; an equal one means the repository changed, so it adopts. The anchor is written only after a successful push, and the first cycle only adopts, never cleans up.

Placement: before importing, the `manifest.json` `name` is matched exactly against local workspace titles; **exactly one hit** imports, and that workspace's path is written into the artifact header's `cwd` (the harness only allows attachment when the cwd equals the workspace path, and it cannot be changed after creation). Zero hits or several hits put that workspace's sessions into the waiting-for-a-match list.

Archive lists stay a convergent grow-only union: every machine unions the repository's marks into its own archive set and unions its own marks back. An archived session's `session-<id>.jsonl` is deleted from the repository (its local copy is untouched); only the mark keeps travelling.

## HTTP API

| Route | Method | Purpose |
|---|---|---|
| `/session-sync/status` | GET | Read-only status view |
| `/session-sync/selection` | GET | Session-set tree (workspace → session) + waiting-for-a-match |
| `/session-sync/sessions/<id>` | POST | Add the session to the sync set and fire a cycle immediately |
| `/session-sync/sessions/<id>` | DELETE | Close the sync for that session |
| `/session-sync/sessions/<id>/records` | GET | That session's sync records (machine + time, newest first) |
| `/session-sync/sync-now` | POST | Run one cycle, answer the fresh state |
| `/session-sync/cleanup-now` | POST | Run one git-space cleanup, answer the fresh state |
| `/session-sync/settings` | GET | `{ writable, settings }` (read-only display for a memory-mode page) |
| `/session-sync/settings` | POST | Merge a patch (host validates, answers `{ ok: true }` or `400 { error }`) |
| `/session-sync/logs` | GET | Recent sync logs |

The session routes hang off a `prefix` registration (`/session-sync/sessions`) because a session id is not a fixed path segment. Write routes enforce a same-origin check and reject malformed bodies; a session id is shape-checked against `session-…` before it reaches any path.

## Configuration

The Cordis Config of the `session-sync` profile row: `startupSyncDelayMs` (a deployment choice, default 3000) plus the user-editable `enabled`, `remote` (SSH URL), `branch` (default `main`), `intervalMinutes` (default 5), and `cleanup`. v2 removed `mappings`: what synchronizes is the plugin's own explicit set, cross-machine placement goes by workspace name, and a machine carries no per-project configuration at all. The settings page reads and writes these fields through the harness configuration form (`ctx.configForms.get('session-sync')`), and every write persists into the profile patch document. See the [repository README](https://github.com/linbin-mk/dsh-session-sync#readme) for the full table.

## The browser half

`src/client/` is the Web client half: the settings page (`settings.section`, id `sync`), the sidebar status dot (`sidebar.footer.action`, id `session-sync-status`), the session row menu entry (`sidebar.workspaces.session.menu.item`, id `session-sync.toggle`, order 500), and the sync-records dialog (`shell.overlay`, id `session-sync.dialog`).

The settings section travels the harness's generic config form (`ctx.configForms.get('session-sync')`: reads, pushed subscriptions, revision-fenced `mutate` writes), so it never touches the harness RPC table; status, the selection tree, manual sync/cleanup, and per-session records travel the plugin's own same-origin HTTP API (`/session-sync/*`, plain `fetch`). A Host that keeps preferences in the browser process (a non-loopback page, `mode: 'memory'`) renders the configuration read-only and disables every write control; the config form collapses a Host refusal to `false`, and the page then asks `POST /session-sync/settings` for the reason. Workspace choices come from the standard `useWorkspaces` hook.

`lib/client.js` is built by `tsdown.config.ts` into a CJS closure factory (`window.__ModuleLoader__.load`), with CSS Modules inlined as a `<style data-plugin>` tag at build time. The build carries a purity gate: platform modules (`react`, `ui-slots`, `ui-primitives`, …) stay external, and a cross-plugin value import fails the build.

**Test setup.** The published harness client packages expose their `/client` runtime only as a browser bundle, so a third-party package cannot import `SlotRegistry` or the test runtime from Node. This package therefore vendors the small snapshot-store engine into `src/client/store.ts` (trimmed from the harness MIT source, attributed in [NOTICE](NOTICE)) and exercises slot registration, locale, and remote invalidation against minimal fakes in `tests/helpers.ts` and `tests/ui-primitives.tsx`; the real slot core is covered by harness-side integration. Component specs declare `// @vitest-environment jsdom` and share one vitest config with the host specs.

## Development

```sh
pnpm test        # engine / format / selection / git / log / settings / service / routes / Loader composition
pnpm typecheck
pnpm build       # tsc → lib
```

## License

MIT — see [LICENSE](LICENSE).
