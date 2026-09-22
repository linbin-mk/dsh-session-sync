English | [简体中文](https://github.com/linbin-mk/dsh-session-sync/blob/main/README.md)

# dsh-session-sync

[![npm version](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![publish workflow](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml/badge.svg)](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml)
[![license](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)
[![node](https://img.shields.io/node/v/@linbin-mk/dsh-session-sync)](package.json)

A third-party session-sync plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): it keeps the sessions of your mapped projects in sync across machines through one git repository, and ships its own web settings page.

```
┌───────────── machine A ─────────────┐      ┌───────────── machine B ─────────────┐
│ DSH host ── session-sync plugin ────┼─git──┼─── session-sync plugin ── DSH host ──│
│   └─ /session-sync/* (own HTTP API) │      │   └─ /session-sync/* (own HTTP API) │
│ browser UI ── fetch (same origin)   │      │ browser UI ── fetch (same origin)    │
└─────────────────────────────────────┘      └─────────────────────────────────────┘
```

- **Sessions follow you, machine paths do not.** Mapped projects export their logical event logs into `projects/<key>/<id>.jsonl`; a plugin-owned, versioned header stores the portable project key and fork-inherited event count. It never copies the harness JSONL backend's private files, compression, or row encoding. On import the key resolves to that machine's mapped path.
- **Mappings are a bidirectional whitelist.** Only mapped projects are uploaded; pulled sessions of unmapped projects never land in DSH.
- **Conflict policy: prefix merge plus dual copies.** Session logs are append-only event streams: when one log is a strict prefix of the other, the longer wins; a true divergence preserves the remote tail at `conflicts/<key>/<id>-<host>.jsonl` and reports it — no data is silently dropped. A divergent export never overwrites the repo artifact: the repo keeps the one stable log it already holds (alternating overwrites would destroy it every cycle), and the divergent local tail travels only into the conflict copy.
- **Open-turn policy: mid-turn logs never cross the wire.** A log ending without a closing `turn/end` is either live on its owning machine right now or crashed and awaiting the harness's interrupted-turn repair. Exporting it would publish a truncated snapshot whose importer later has the harness repair with synthetic `step/end` + `turn/end {interrupted}` closers, permanently diverging that machine's copy from the real continuation. Exports therefore skip mid-turn logs (the closed log ships on a later cycle), and imports skip mid-turn artifacts (stale snapshots from older plugin versions; the owning machine replaces them with its closed log).
- **Archive marks travel, archived content retires from git.** A session archived on one machine is hidden from every machine's session list via its `projects/<key>/archived.json` mark, and its repo artifact (`projects/<key>/<id>.jsonl`) is deleted on the next sync — archived sessions stop consuming git space. The local copy of the session is never touched; only the grow-only mark keeps travelling, so the repo list is a plain union that can never conflict.
- **Imports pre-warm the projection cache.** The sync import writes persistence directly, bypassing the live session store, so the harness projection cache never folds it on its own; the plugin runs one cold-read warm-up per import (fail-soft), and list rows show their title, subagent grouping, and other projection values immediately — no need to open the session first.
- **First chat after a machine switch gets one notice.** Whenever an import adds foreign events to a session, the plugin arms a one-shot mark (persisted under the harness home, so a restart keeps it). On the first user message of that session — detected through the harness's `agent/pre-step` seam, the same injection path the AGENTS.md loader uses — a plugin `notice` message folds in right after the user prompt, telling the model that this session's history was synced from another machine, that historical paths may not exist locally, and that the current working directory is authoritative from here on. The mark is consumed on injection: continuing on the same machine never re-injects, while the notice itself is a durable event that travels with the log — and the next machine switch arms its own notice for its own first chat. Subagent sessions are excluded.
- **The repository is only a transport medium.** Every cycle runs fetch → hard reset → import → export → commit → push, so git merge conflicts cannot arise. Remote-touching commands (`ls-remote`, `fetch`, `push`) retry with exponential backoff (3 attempts by default), so one transient SSH corruption (e.g. `Bad packet length`) no longer blanks a cycle; the branch probe runs once per cycle, and `resetHard` trusts the fetch outcome instead of probing again.
- **Periodic git-space cleanup.** Git never forgets deleted files: archive deletion only changes HEAD, while every historical version stays in the object store forever. The cleanup rewrites the shared history down to the newest N commits (default 200) on a configurable period (in hours) and force-pushes (`--force-with-lease`); dropped commits leave the repository together with their blobs. The kept commits replay onto the new root, so the newest tree — every current file — is preserved exactly, and other machines re-sync from the rewritten history on their next cycle. Cleanup is checked once after each completed cycle (the sync cadence is the granularity), and the settings page also has a clean-now button. The hosting server's own object-store GC is outside the client's control.
- **Sync log with a 3-day window.** Every cycle appends start/success/failure records (counters, conflict copies, errors, duration) to `session-sync/logs/sync-YYYY-MM-DD.jsonl` under the harness home; reads and writes prune files outside the 3-day window. The settings page shows the recent records in a collapsible panel, and the failure line carries its own timestamp so it can never read as part of the last successful run.
- **Web surface included.** A settings page (master switch, SSH remote, branch, cadence, git-space cleanup, project mappings, sync-now/clean-now) plus a sidebar status dot.

## Why this plugin needs no harness core patches

The harness RPC table (`apiproxy`) is a static, compiler-locked registry — a third-party package cannot add `sessionSync.*` methods to it. This plugin instead registers its own same-origin HTTP API on the harness's **open `webServer` route seam**:

| Route | Method | Purpose |
|---|---|---|
| `/session-sync/status` | GET | Read-only sync status view |
| `/session-sync/sync-now` | POST | Run one cycle, answer the fresh view |
| `/session-sync/cleanup-now` | POST | Run one git-space cleanup, answer the fresh view |
| `/session-sync/settings` | GET | Settings view (`writable` + section) |
| `/session-sync/settings` | POST | Merge a patch into the settings section (host validates) |
| `/session-sync/logs` | GET | Recent cycle-log records (within the window, newest first, `?limit=` up to 500) |

The browser half calls these routes with plain `fetch`. Write routes refuse cross-origin requests (the `Origin` header must name this server's own host) and malformed bodies; the settings service re-validates every merged section. The only data the UI still reads from the generic harness API is the workspace list (`workspace.list`) — a standard, unchanged surface.

## Repository layout

```
packages/session-sync/             @linbin-mk/dsh-session-sync (host plugin)
packages/client-ui-settings-sync/  @linbin-mk/dsh-client-ui-settings-sync (browser plugin)
```

The host package holds the sync engine (`engine.ts`, `format.ts`, `git.ts`, `settings.ts`), the service (`index.ts`), and the HTTP surface (`api.ts`, `routes.ts`). The browser package holds the settings page, the status footer, the page controller, and the fetch client.

## Requirements

- Node.js `^22.19 || >=24`
- DeepSeek Harness `0.1.5-rc.1` (all `@deepseek-ai/*` dependencies use published npm versions; no local harness links)
- `git` on PATH and an SSH key for the sync remote (host key checking: `StrictHostKeyChecking=accept-new`)
- pnpm, but only when building from source

This release writes a new plugin-owned logical-event artifact format and intentionally does not import artifacts produced by the earlier raw-storage implementation. Start it with an empty sync repository (or clear the old repository contents) before connecting another computer.

## Install

Install the two published packages into a custom Web profile. Each package declares its own `dsh.bundle` patch, so the Host and Client plugin rows are added automatically:

```sh
dsh --profile web-sync --from-default-profile web --dump-config
dsh plugin --profile web-sync add \
  @linbin-mk/dsh-session-sync \
  @linbin-mk/dsh-client-ui-settings-sync
dsh --profile web-sync
```

To install locally built tarballs instead:

```sh
cd dsh-session-sync
pnpm install && pnpm build
pnpm --dir packages/session-sync pack
pnpm --dir packages/client-ui-settings-sync pack

dsh plugin --profile web-sync add \
  ./linbin-mk-dsh-session-sync-0.1.1.tgz \
  ./linbin-mk-dsh-client-ui-settings-sync-0.1.1.tgz
```

Remove both from the same profile:

```sh
dsh plugin --profile web-sync remove \
  @linbin-mk/dsh-session-sync \
  @linbin-mk/dsh-client-ui-settings-sync
```

## Composition

```yaml
- id: session-sync
  name: '@linbin-mk/dsh-session-sync'
  config:
    startupSyncDelayMs: 3000

# in the browser roster of your web bundle:
- id: ui-settings-sync
  name: '@linbin-mk/dsh-client-ui-settings-sync'
```

The install adds the two rows above automatically. The host plugin requires the `settings` and `sessionPersistence` services; with a `workspaceRegistry` present, imported sessions attach to workspaces and the repo's archived-session marks are applied to this machine's registry; with a `sessionProjectionCache` present (optional injection), imports pre-warm the projection cache so list rows carry their title and other projection values right away. The browser plugin registers the `settings.section` (`sync`) page and the `sidebar.footer.action` (`session-sync-status`) status dot.

## Configuration

The `session-sync` settings namespace:

| Field | Meaning |
|---|---|
| `enabled` | Master switch; `remote` is required while enabled. |
| `remote` | Git remote URL (SSH). Credentials come from `~/.ssh`. |
| `branch` | Branch to synchronize; default `main`. |
| `intervalMinutes` | Automatic cadence in minutes (minimum 1, default 5). |
| `mappings` | `[{ key, path }]`: the portable project key and the local directory. |
| `cleanup` | `{ enabled, periodHours, keepCommits }`: the git-space cleanup switch, the period between cleanups (hours, minimum 1, default 24), and the number of newest commits to keep (minimum 1, default 200). |

Timing: one automatic cycle `startupSyncDelayMs` after startup, then every `intervalMinutes`, plus the manual button. All entries share one single-flight guard. The cleanup is checked once after each successful cycle (plus the clean-now button); cleanup and sync drive the same worktree and serialize through their own single-flight guards.

## Security posture

- No credentials are stored by the plugin: the git remote is your SSH URL and the key lives in `~/.ssh`.
- Machine paths never enter the repository (export rewrites them to the portable key).
- Write routes enforce a same-origin check; status and settings reads are side-effect free.
- The plugin's own git commits use the fixed identity `dsh-session-sync <dsh-session-sync@localhost>`.

## Development

```sh
pnpm install
pnpm test        # 184 tests: engine, format, git, log, settings, service, routes, composition, UI
pnpm typecheck
pnpm build       # tsc for both packages + the browser bundle (lib/client.js)
```

### About the third-party test setup

The published harness client packages ship their `/client` runtime surfaces only as browser bundles (they are loaded through the harness module table), so a third-party package cannot import `SlotRegistry`, `createSnapshotStore`, or the test runtime in Node tests. This repo therefore:

- vendors the small snapshot-store engine into `packages/client-ui-settings-sync/src/client/store.ts` (trimmed from the harness MIT source, with attribution), and
- exercises slot registration, locale, and remote invalidation against minimal fakes in `packages/client-ui-settings-sync/tests/helpers.ts`.

Real-slot-core behavior is covered by the harness-side integration.

## Troubleshooting

- **`dsh plugin add` 404s right after a release.** A brand-new version takes minutes to appear on the registry read path, while `dist-tags` and the tarball usually resolve first. Retry later; do not republish — the version exists, so a second attempt always conflicts.
- **`ERR_PNPM_FETCH_404` through a mirror.** Mirrors such as npmmirror sync new versions on their own schedule. Add `--registry=https://registry.npmjs.org` to that command, or wait for the mirror.
- **pnpm refuses or queries a just-published version.** That is pnpm's `minimumReleaseAge` delay. Allow the package through, or wait out the window.
- **The web GUI will not boot, or the Sync page is missing.** The browser half is indexed in the harness module table by **package name**, not by a short name. Confirm both rows are present:

  ```sh
  dsh --profile web-sync --dump-config | grep -A 2 -e session-sync -e ui-settings-sync
  ```

  The host half and the sync engine can look perfectly healthy at the same time, so a clean `--dump-config` does **not** prove the browser half loaded — the only reliable evidence is a browser console with no errors and a visible Sync page.
- **A cycle reports an SSH error.** The plugin uses `StrictHostKeyChecking=accept-new`, so a first connection to a new host still needs a working key (try `ssh -T git@<host>` first). Transient corruption (e.g. `Bad packet length`) is absorbed by the backoff retries; for persistent failures read the sync-log panel on the settings page.
- **A session archived on one machine is still visible on another.** Archive marks are a grow-only union and need one successful cycle to travel. Confirm both machines completed at least one cycle.
- **Imported list rows show only the project name, with no title.** Projection pre-warm is fail-soft: when that warm-up fails the row falls back to the project name until the session is opened or a later import refreshes it.

## Known limitations

- Status refresh is polling (page footer every 60 s, plus after every action); the harness-hosted push-event path needs core access and is deliberately avoided.
- Edits made directly to the settings file are picked up on the next page load, not pushed live.
- SSH remotes only; HTTPS + token remotes are not implemented.
- Projection pre-warm is fail-soft: when a warm-up fails, the row falls back to the project name until the session is opened or a later import refreshes it.
- Conflict copies need manual attention; the page shows only their count.
- The harness archive set has no unarchive path yet, so archiving is one-way (grow-only union): once archived anywhere, a session stays hidden everywhere and its repo artifact is deleted — archived content cannot be recovered from the repository. When upstream adds unarchive, the archive list format will need tombstones.
- Cleanup is a history rewrite: local and remote history commits are dropped (the newest tree is preserved). The hosting server's object-store GC — which decides when its own storage shrinks — is outside the client's control; when two machines clean up at nearly the same time, `--force-with-lease` rejects the later push and the next cycle retries, so a newer commit is never silently clobbered.
- If the harness upstream ever merges session sync into the core RPC surface, an RPC-native variant could replace the HTTP API without changing the engine.

## License

MIT — see [LICENSE](LICENSE).

The vendored snapshot-store engine in `packages/client-ui-settings-sync/src/client/store.ts` is trimmed from DeepSeek Harness (MIT), and the browser bundle (`lib/client.js`) inlines zustand, immer, and clsx (all MIT) at build time. The upstream copyright notices and license text are reproduced in [NOTICE](NOTICE).
