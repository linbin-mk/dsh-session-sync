English | [简体中文](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/session-sync/README.md)

# @linbin-mk/dsh-session-sync

[![npm version](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![license](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)

The host half of the dsh-session-sync plugin: a git-backed automatic session-sync service (`ctx.sessionSync`) for DeepSeek Harness.

See the [repository README](https://github.com/linbin-mk/dsh-session-sync#readme) for the architecture, composition, and installation. This package exports:

- `SessionSyncService` (default): the cordis service — live configuration of the profile row, timers, single-flight cycles, and the `session-sync/completed` event.
- The engine (`compareLogs`, `runSyncCycle`), the repo format helpers, `GitRepository`/`GitError`, and the configuration contract (`Config`/`ConfigInput`, `SESSION_SYNC_NAMESPACE`, `readSettings`, `validateSessionSyncSettings`).
- The switch notice (`SWITCH_NOTICE_TEXT`, `createSwitchNoticeMessage`, `withSwitchNotice`): the one-shot `notice` under this package's own message source kind, injected into the first chat after a machine switch.
- The HTTP surface (`registerSessionSyncRoutes`, route paths, wire types) registered on the harness `webServer` seam when one is mounted.

The browser half is [`@linbin-mk/dsh-client-ui-settings-sync`](https://www.npmjs.com/package/@linbin-mk/dsh-client-ui-settings-sync).

## Composition

```yaml
- id: session-sync
  name: '@linbin-mk/dsh-session-sync'
  config:
    startupSyncDelayMs: 3000
```

`startupSyncDelayMs` in `config` is a deployment choice; `enabled`, `remote`, `branch`, `intervalMinutes`, `mappings`, and `cleanup` are the live fields the settings page writes, persisted by the harness settings service into the profile patch document. Requires the `settings` and `sessionPersistence` services; a `workspaceRegistry` is optional (imported sessions attach to workspaces when present, and the repo's per-project `archived.json` marks are applied to the registry's archive set so sessions archived on other machines stay hidden here). A `webServer` is optional too — without one the plugin runs headless and simply serves no web routes. The switch notice listens on the harness `agent/pre-step` event (`dsh-agent`/`dsh-llm` peers): a deployment without agent services simply never fires an injection.

## Repository format

```text
manifest.json                    { "version": 1, "projects": [...] }
projects/<key>/session-<id>.jsonl
projects/<key>/archived.json     { "version": 1, "sessionIds": [...] }  — grow-only union
conflicts/<key>/<stem>-<host>.jsonl
```

Each session artifact starts with a `dsh-session-sync` versioned header containing the portable project key, the current public Session header fields, and `inheritedEventCount`; each remaining line is one logical `SessionEvent`. It never embeds a persistence backend's physical row encoding. Artifacts from the earlier raw-storage implementation are rejected rather than migrated.

Archive lists are convergent grow-only unions: the harness archive set has no unarchive path, so every machine unions the repo's marks into its own registry and unions its own marks back. An archived session's `session-<id>.jsonl` is deleted from the repo (its local copy is untouched), so archived sessions stop consuming git space; only the mark keeps travelling.

## HTTP API

| Route | Method | Purpose |
|---|---|---|
| `/session-sync/status` | GET | Read-only status view |
| `/session-sync/sync-now` | POST | Run one cycle, answer the fresh view |
| `/session-sync/cleanup-now` | POST | Run one git-space cleanup, answer the fresh view |
| `/session-sync/settings` | GET | `{ writable, settings }` (read-only display for a memory-mode page) |
| `/session-sync/settings` | POST | Merge a patch (host validates, answers `{ ok: true }` or `400 { error }`) |
| `/session-sync/logs` | GET | Recent cycle-log records |

Write routes enforce a same-origin check and reject malformed bodies.

## Configuration

The Cordis Config of the `session-sync` profile row: `startupSyncDelayMs` (a deployment choice, default 3000) plus the user-editable `enabled`, `remote` (SSH URL), `branch` (default `main`), `intervalMinutes` (default 5), `mappings: [{ key, path }]`, and `cleanup`. The settings page reads and writes these fields through the harness configuration form (`ctx.configForms.get('session-sync')`), and every write persists into the profile patch document. See the [repository README](https://github.com/linbin-mk/dsh-session-sync#configuration) for the full table.

## Development

```sh
pnpm test        # engine / format / git / settings / service / routes / Loader composition
pnpm typecheck
pnpm build       # tsc → lib
```

## License

MIT — see [LICENSE](LICENSE).
