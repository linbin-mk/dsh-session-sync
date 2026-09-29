English | [简体中文](https://github.com/linbin-mk/dsh-session-sync/blob/main/README.md)

# dsh-session-sync

[![npm version](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![publish workflow](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml/badge.svg)](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml)
[![license](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)
[![node](https://img.shields.io/node/v/@linbin-mk/dsh-session-sync)](package.json)

A third-party session-sync plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): it syncs **the sessions you picked by hand** across machines through one git repository, and ships its own web UI.

```
┌───────────── machine A ─────────────┐      ┌───────────── machine B ─────────────┐
│ DSH host ── session-sync plugin ────┼─git──┼─── session-sync plugin ── DSH host ──│
│   └─ /session-sync/* (own HTTP API) │      │   └─ /session-sync/* (own HTTP API) │
│ browser UI ── fetch (same origin)   │      │ browser UI ── fetch (same origin)    │
└─────────────────────────────────────┘      └─────────────────────────────────────┘
```

- **One click starts the sync.** Pick "Sync session" from the sidebar session row's `...` menu and that session joins the **cross-machine shared sync set**; open the menu again and it reads "Session syncing" — click that to pop the sync log (which machine, when, push or pull, how many events), and the dialog can close the sync right there. No pinning first, and no "project mappings" configuration of any kind.
- **Sessions follow you, machine paths do not.** Every session exports to `workspaces/<key>/session-<id>.jsonl`; the first line is the plugin's own versioned file header, recording the workspace's stable key instead of a local path. On import the workspace **name** resolves to this machine's path, and the plugin never copies the harness JSONL backend's private files, compression, or row encoding.
- **The set is one global source of truth.** `sync.json` at the repository root is a whole-set snapshot (not a union), and every machine mirrors it into its own selection; closing the sync on any machine propagates to all of them. To keep "who changed what" from fighting itself, each machine keeps an anchor (`state.json`) under the harness home: when its own selection changed it publishes, and when it did not it adopts the repository's.
- **A machine that never synced only adopts, never deletes.** A machine that has not yet run a cycle (no anchor) does not read the repository's selection as "close the sync", so it cannot wipe repo artifacts by mistake. The same guard covers every later cycle that cannot publish: the anchor records only the selection that actually landed, and only after the push succeeded, so a selection this machine never held is never read as "you closed it", and a publication the remote did not accept is retried instead of being read as a removal.
- **Placement is by name.** Each `workspaces/<key>/manifest.json` records that workspace's **display name**: the workspace on another machine whose title is exactly that name is the destination. Only **exactly one match** imports automatically; with no match (including when either side was renamed — renames are not adapted to), or when this machine has several workspaces with that same name (the harness allows different paths to share a title), those sessions stay in **waiting for a match** until you create a same-named workspace locally, and the next cycle places them automatically. **There is no binding UI and no local mapping is written.**
- **No landing, no import.** In the harness a session can only attach to the workspace whose path equals the `cwd` in that session's header, and a cwd cannot be changed once created — there is no cross-workspace re-attach API either. So the plugin completes the match **before** importing and writes this machine's workspace path as the cwd; when nothing matches, the session stays in the repository as-is and waits — it never guesses a location and shoves it in first.
- **Conflict policy: prefix merge plus dual copies.** Session logs are append-only event streams: when one log is a strict prefix of the other, the longer wins; on a true divergence the remote tail is preserved verbatim at `conflicts/<key>/<session-id>-<host>.jsonl` and reported — data is never silently dropped. A divergent export never overwrites the repo artifact.
- **Mid-turn logs never cross the wire.** A log that does not end with `turn/end` is either running live on its owning machine right now or crashed and awaiting the harness's interrupted-turn repair. Exporting it would publish a truncated snapshot: once imported, the harness patches in its synthetic repair tail, and that copy forks permanently from the real continuation back home. Exports therefore skip logs with an open turn (the closed log ships on a later cycle), and imports skip artifacts with an open turn.
- **A local session is never deleted, under any circumstance.** Closing the sync, archiving, cleanup — all of them only touch the repository's artifacts and shared marks, and the local copy is kept intact.
- **Archive marks travel, archived content retires from git.** A session archived on one machine is hidden from every machine's session list by the mark in `workspaces/<key>/archived.json`, and its repo `session-<id>.jsonl` is deleted on the next sync — archived sessions stop consuming git space. The repo mark is a grow-only union and can never conflict.
- **Imports pre-warm the projection cache.** The sync import writes persistence directly, bypassing the live session store, so the harness projection cache never folds it on its own; the plugin runs one cold-read warm-up per import (fail-soft), and list-row metadata such as the title and the subagent grouping is visible immediately — no need to open the session first.
- **The first chat after a machine switch gets one notice.** Whenever an import brings a session new events from another machine, the plugin arms a one-shot mark for it (persisted under the harness home, so a restart keeps it). On that session's first user message — detected through the harness's `agent/pre-step` seam — a plugin `notice` message folds into the context right after the user message, telling the model that this session's history was synced from another machine, that historical paths may not match the current machine, and that the current working directory is authoritative from here on. The mark is consumed on injection. Subagent sessions are excluded.
- **The repository is only a transport medium.** Every cycle runs fetch → hard reset → import → export → commit → push, so git merge conflicts cannot arise. Remote-touching commands (`ls-remote`, `fetch`, `push`) retry with exponential backoff (3 attempts by default), so one transient SSH corruption no longer blanks a whole cycle.
- **Periodic git-space cleanup.** Git never forgets deleted files: archive deletion only changes HEAD, while every historical version stays in the object store forever. The cleanup rewrites the shared history down to the newest N commits (default 200) on a period (in hours) and force-pushes (`--force-with-lease`); the truncated commits leave the repository together with their blobs. The kept commits replay so the newest tree is preserved exactly — every current file is still there — and other machines re-sync from the rewritten history on their next cycle.
- **Sync logs keep a 3-day window.** Every cycle appends start/success/failure records (counters, conflict copies, errors, duration) to `session-sync/logs/sync-YYYY-MM-DD.jsonl` under the harness home, and reads and writes prune log files outside the 3-day window; the settings page shows the recent records in a collapsible panel. In addition, **each session** has its own sync records (`workspaces/<key>/session-<id>.records.json`, newest 20) — the source of the "machine + time" in the session-row dialog — and they travel with the repository, so you can see when another machine pulled it.
- **Web surface included.** The settings page (master switch, SSH remote, branch, sync cadence, git-space cleanup, the synced-sessions tree, the waiting-for-a-match workspaces, Sync now/Clean now) plus the sidebar sync status dot, the session-row menu item, and the sync-log dialog. The settings page's configuration area is still **draft-and-save**: edits are written only when you press Save, Reset drops them, and validation (required, non-blank branch) is named beside the field.

## Why this plugin needs no harness core patches

The harness RPC table (`apiproxy`) is a static, compiler-locked registry — a third-party package cannot add `sessionSync.*` methods to it. This plugin instead registers its own same-origin HTTP API on the harness's **open `webServer` route seam**:

| Route | Method | Purpose |
|---|---|---|
| `/session-sync/status` | GET | Read-only sync status view |
| `/session-sync/selection` | GET | Session-set tree (workspace → session) + waiting-for-a-match |
| `/session-sync/sessions/<id>` | POST | Add the session to the sync set |
| `/session-sync/sessions/<id>` | DELETE | Close the sync for that session |
| `/session-sync/sessions/<id>/records` | GET | That session's sync records (machine + time, newest first) |
| `/session-sync/sync-now` | POST | Run one sync cycle, answer the fresh state |
| `/session-sync/cleanup-now` | POST | Run one git-space cleanup, answer the fresh state |
| `/session-sync/settings` | GET | Settings view (`writable` + section) |
| `/session-sync/settings` | POST | Merge a patch into the settings section (host validates) |
| `/session-sync/logs` | GET | Recent sync logs (within the window, newest first, `?limit=` up to 500) |

The browser half calls these routes with plain `fetch`. Write routes refuse cross-origin requests (the `Origin` header must name this server's own host) and malformed bodies. The settings section reads and writes through the harness's shared config form (`ctx.configForms`, addressed by the profile entry id `session-sync`), and the plugin's own settings routes keep two jobs: `GET` lets a page whose preferences the Host keeps inside the browser process (a non-loopback page, `mode: 'memory'`) display the configuration read-only, and `POST` is the only write path that carries the host's refusal reason.

The UI itself also rides entirely on the harness's open slots — nothing needs a core patch:

| Slot | id | Content |
|---|---|---|
| `settings.section` | `sync` | Sync settings page |
| `sidebar.footer.action` | `session-sync-status` | Sidebar status dot |
| `sidebar.workspaces.session.menu.item` | `session-sync.toggle` | Session row `...` menu item (order 500) |
| `shell.overlay` | `session-sync.dialog` | Sync-log dialog |

## Repository layout

```
packages/session-sync/             @linbin-mk/dsh-session-sync (host plugin)
packages/client-ui-settings-sync/  @linbin-mk/dsh-client-ui-settings-sync (browser plugin)
```

The host package holds the sync engine (`engine.ts`, `format.ts`, `git.ts`, `settings.ts`), the selection-tree projection (`selection.ts`), the service (`index.ts`), and the HTTP surface (`api.ts`, `routes.ts`). The browser package holds the settings page, the session tree, the session-row menu item, the sync-log dialog, the status footer, the page controller, and the fetch client.

Repository format (v2):

```text
sync.json                                    Cross-machine sync set (whole-snapshot)
workspaces/<key>/manifest.json               { version, key, name, updatedAt }   ← name is the source of truth for matching
workspaces/<key>/session-<id>.jsonl          Session artifact
workspaces/<key>/session-<id>.records.json   That session's sync records (machine + time, newest 20)
workspaces/<key>/archived.json               Archive marks (grow-only union)
conflicts/<key>/<session-id>-<host>.jsonl     Conflict copies
```

Every `sync.json` entry carries `id`, `key`, `workspaceName`, `title`, `addedAt`, `addedBy`. The `title` is not redundant: the artifact header has no title (only id, createdAt, parentSession, isSeeded, origin, delegationDepth, agentPreset), while the set includes sessions this machine has not imported yet — without it, the settings page could not draw the full list.

Machine-local state (`session-sync/` under the harness home):

```text
selection.json   { sessionIds }        This machine's current sync set
state.json       { firstSeen, syncedIds, ownedIds, workspaceKeys }   Edit-detection anchor + workspace→key memory
repo/            git worktree
logs/            cycle logs
```

`workspaceKeys` is the workspace-id → repo-directory-key table: once a key is assigned it never changes, so **a rename only rewrites the `name` in the manifest and moves no artifact**.

## Requirements

- Node.js `^22.19 || >=24`
- DeepSeek Harness `0.1.7-rc.2` (all `@deepseek-ai/*` dependencies use published npm versions; no local harness links)
- The peer line both packages declare: `@deepseek-ai/cordis ^4.0.4`, `@deepseek-ai/schemastery ^3.18.4`, `cordis-plugin-loader ^1.0.5`, `cordis-plugin-include ^1.0.9`
- `git` on PATH and an SSH key for the sync remote (host key checking: `StrictHostKeyChecking=accept-new`)
- pnpm, but only when building from source

### 0.5.0 breaking change: from "pinning is syncing" to explicit per-session sync

- **The selection changed hands.** The v0.4 selection was *mapped project ∩ pinned session*, carried by the harness pin set; v0.5 is the plugin's own explicit set, entered from the session row's `...` menu. The plugin no longer reads or writes any pin state.
- **Project mappings are deleted outright.** Cross-machine placement now matches a workspace **name** against the `manifest.json` `name`.
- **The repository format is upgraded to v2 and is not compatible with repositories written by v0.4.** `pinned.json` and the `projects/` directory are no longer read, and the artifact header version goes from 1 to 2. **Start from a new repository** (or clear the old repository's contents) and add the sessions you want to sync one by one; the upgrade itself performs no migration and deletes no local session.
- DeepSeek Harness `0.1.7-rc.2` is required; a profile still on `0.1.7-alpha.1` cannot install this version.

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
  ./linbin-mk-dsh-session-sync-0.5.0.tgz \
  ./linbin-mk-dsh-client-ui-settings-sync-0.5.0.tgz
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

The install adds the two rows above automatically. The host plugin requires the `settings` and `sessionPersistence` services; `workspaceRegistry` is now a **required capability** (without it there is no matching by name and no session can be exported — the plugin skips exports and reports it), and with a `sessionProjectionCache` present (an optional injection) an import pre-warms the projection cache as soon as it completes, while the settings page also uses it to read session titles with zero I/O.

## Configuration

Configuration is the Cordis Config of the `session-sync` profile row: every user-editable field is a live reference (`.volatile()`), and the harness commits each settings write into those references and persists it into the profile patch document. The fields:

| Field | Meaning |
|---|---|
| `startupSyncDelayMs` | Delay between startup and the first automatic cycle, in milliseconds (default 3000). A deployment choice: it has no settings-page row. |
| `enabled` | Master switch; `remote` is required while enabled. While off, the session-row menu item is not rendered. |
| `remote` | Git remote URL (SSH). Credentials come from `~/.ssh`. |
| `branch` | Branch to synchronize; default `main`. |
| `intervalMinutes` | Automatic sync cadence in minutes (minimum 1, default 5). |
| `cleanup` | `{ enabled, periodHours, keepCommits }`: the periodic git-space cleanup switch, the period between cleanups (hours, minimum 1, default 24), and the number of newest commits to keep (minimum 1, default 200). |

**The sync set is not a configuration field** — it is data: the settings page displays it read-only, and the only write entry points are the session row menu (plus "Close sync" at the end of a settings-page row).

Timing: one automatic cycle `startupSyncDelayMs` after startup, then every `intervalMinutes`. **Clicking "Sync session" fires a cycle immediately** (single-flight guard), so this machine is instant, while when the other side sees it depends on that side's `intervalMinutes`. Cleanup checks for expiry once after each successful cycle, plus the settings page's Clean now button.

## Waiting for a matching workspace

Matching by name happens before every import. Sessions that cannot land do not disappear: they stay in the repository and are listed in the settings page's "Workspaces waiting for a match" section (with the number of sessions waiting under that workspace). The only action that makes them land is **creating a workspace with exactly that title on this machine through the sidebar's "Add workspace"**; the next cycle matches and imports them automatically. A renamed workspace is not adapted to — deliberately, since guessing a location would permanently attach a session to the wrong workspace.

## Security posture

- No credentials are stored by the plugin: the git remote is your SSH URL and the key lives in `~/.ssh`.
- Machine paths never enter the repository (export rewrites them to the workspace key).
- Write routes enforce a same-origin check; status and settings reads are side-effect free.
- The plugin's own git commits use the fixed identity `dsh-session-sync <dsh-session-sync@localhost>`.

## Development

```sh
pnpm install
pnpm test        # engine, format, selection, git, log, settings, service, routes, composition, config writes, UI
pnpm typecheck
pnpm build       # tsc for both packages + the browser bundle (lib/client.js)
```

The design and implementation contract is in [`docs/spec/session-sync-v2.md`](docs/spec/session-sync-v2.md).

### About the third-party test setup

The published harness client packages ship their `/client` runtime surfaces only as browser bundles (they are loaded through the harness module table), so a third-party package cannot import `SlotRegistry`, `createSnapshotStore`, or the test runtime in Node tests. This repo therefore:

- vendors the small snapshot-store engine into `packages/client-ui-settings-sync/src/client/store.ts` (trimmed from the harness MIT source, with attribution), and
- exercises slot registration, locale, and remote invalidation against minimal fakes in `packages/client-ui-settings-sync/tests/helpers.ts`.

Real-slot-core behavior is covered by the harness-side integration.

## Troubleshooting

- **`dsh plugin add` 404s right after a release.** A brand-new version takes a few minutes to become visible on the registry read path. Retry later; do not republish.
- **`ERR_PNPM_FETCH_404` through a mirror.** Add `--registry=https://registry.npmjs.org` to that command, or wait for the mirror to sync.
- **pnpm refuses or queries a just-published version.** That is pnpm's `minimumReleaseAge` delay. Allow the package through, or wait out the window.
- **The web GUI will not boot, or the settings page has no "Session Sync" entry.** The browser half is indexed in the harness module table by **package name**, not by a short name. Confirm both rows are present:

  ```sh
  dsh --profile web-sync --dump-config | grep -A 2 -e session-sync -e ui-settings-sync
  ```

  The host half and the sync engine may be perfectly healthy at this moment, so a clean `--dump-config` does **not** prove the browser half loaded — the only reliable evidence is a browser console with no errors and a "Session Sync" entry in the settings page.
- **There is no "Sync session" in the session row menu.** Three cases: the master switch is off or no remote is set; the session does not belong to any workspace; this machine does not hold the session. The settings page's session tree still shows the set itself.
- **A session is not visible on another machine.** Look at "Workspaces waiting for a match" on the settings page first: most likely that machine has no workspace with the same name. Create a same-named workspace there.
- **A sync cycle reports an SSH error.** The plugin uses `StrictHostKeyChecking=accept-new`, so a first connection to a new host still needs a working key (try `ssh -T git@<host>` first). Transient corruption is absorbed by the backoff retries; for persistent failures read the sync-log panel on the settings page.
- **A session archived on one machine is still visible on another.** Archive marks are a grow-only union and need one successful cycle to travel. Confirm both machines completed at least one cycle.

## Known limitations

- Status refresh is polling (the footer every 60 s, plus after every action, plus a targeted refresh when the menu opens); the harness-hosted push-event path needs core access and is deliberately avoided.
- Settings edits are pushed by the harness to an already-open settings page (config-form subscription + `settings/document-updated`), so no refresh is needed.
- SSH remotes only; HTTPS + token remotes are not implemented.
- **Renaming a workspace is not adapted to.** If either side is renamed the names no longer match and those sessions go to waiting for a match; the repo-side key does not change and no artifact is moved.
- **Several local workspaces with the same name do not match automatically.** They stay in waiting for a match and you have to disambiguate yourself (the harness allows different paths to share one display title).
- Projection pre-warm is fail-soft: when a warm-up fails, that row temporarily falls back to the workspace name and refreshes when the session is opened or a later import runs.
- Conflict copies need manual attention; the page shows only their count and the most recent record.
- The shared archive marks are a grow-only union: propagating an unarchive needs a tombstone record in each workspace's `archived.json` (plus a format version bump), which this release does not implement. Either way, archived content is unrecoverable from the repository: the session file is deleted as soon as the mark lands.
- Cleanup is a history rewrite: local and remote history commits are dropped (the newest tree is preserved). When several machines clean up at nearly the same time, `--force-with-lease` makes the later force-push fail and retry on the next cycle, so someone else's newer commit is never silently clobbered.
- One session's sync records are capped at 20 (newest kept by time); once the cap is exceeded the oldest records are no longer shown.
- If the harness upstream ever merges session sync into the core RPC surface, an RPC-native variant could replace it without changing the engine.

## License

MIT — see [LICENSE](LICENSE).

The vendored snapshot-store engine in `packages/client-ui-settings-sync/src/client/store.ts` is trimmed from DeepSeek Harness (MIT), and the browser bundle (`lib/client.js`) inlines zustand, immer, and clsx (all MIT) at build time. The upstream copyright notices and license text are reproduced in [NOTICE](NOTICE).
