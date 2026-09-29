English | [简体中文](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/client-ui-settings-sync/README.md)

# @linbin-mk/dsh-client-ui-settings-sync

[![npm version](https://img.shields.io/npm/v/@linbin-mk/dsh-client-ui-settings-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-client-ui-settings-sync)
[![license](https://img.shields.io/npm/l/@linbin-mk/dsh-client-ui-settings-sync)](LICENSE)

The browser half of the dsh-session-sync plugin: the Sync settings page (`settings.section` id `sync`) and the sidebar status dot (`sidebar.footer.action` id `session-sync-status`) for the DeepSeek Harness web GUI.

The settings section rides the harness's shared configuration form (`ctx.configForms.get('session-sync')`: reads plus a subscription for pushed updates, writes as revision-fenced `mutate`), so it never touches the harness RPC table; status, manual sync/cleanup, and the cycle log travel through the host's own same-origin HTTP API (`/session-sync/*`, plain `fetch`). A page the Host keeps process-local (non-loopback, `mode: 'memory'`) displays the section read-only and disables every write control; because the shared form flattens a Host refusal into `false`, the page then asks the plugin's `POST /session-sync/settings` for the refusal message. Workspace choices come from the standard `useWorkspaces` hook.

The host half is [`@linbin-mk/dsh-session-sync`](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync).

## Composition

```yaml
- id: ui-settings-sync
  name: '@linbin-mk/dsh-client-ui-settings-sync'
```

Requires DeepSeek Harness `0.1.7-rc.2` (`@deepseek-ai/cordis ^4.0.4`), and peer-depends on the host half `@linbin-mk/dsh-session-sync ^0.4.0`.

## Development

```sh
pnpm test        # controller, section, footer, slot registration
pnpm typecheck
pnpm build       # tsc (types) + tsdown (node half + lib/client.js browser bundle)
```

The tests run against minimal fakes (`tests/helpers.ts`) and a vendored snapshot-store engine because the published harness client packages ship their `/client` runtime only as browser bundles; see the [repository README](https://github.com/linbin-mk/dsh-session-sync#readme).

## License

MIT — see [LICENSE](LICENSE).

The snapshot-store engine in `src/client/store.ts` is trimmed from DeepSeek Harness (MIT), and the browser bundle (`lib/client.js`) inlines zustand, immer, and clsx (all MIT) at build time. The upstream copyright notices and license text are reproduced in [NOTICE](NOTICE).

## The v2 (0.5) browser half

Since v2, syncing is no longer driven by pins: the session row's `...` menu gains this plugin's entry, and the settings page shows the sync selection read-only. This package registers four slots:

| Slot | id | order | Content |
|---|---|---|---|
| `settings.section` | `sync` | 30 | The settings page (`enabled` / `remote` / `branch` / `intervalMinutes` / `cleanup` keep their draft-and-save behaviour; `mappings` is gone) |
| `sidebar.footer.action` | `session-sync-status` | 0 | The status dot (now naming `syncedCount`) |
| `sidebar.workspaces.session.menu.item` | `session-sync.toggle` | 500 | "Sync session" / "Session syncing" |
| `shell.overlay` | `session-sync.dialog` | 0 | That session's sync-records dialog |

- The menu entry: a selected session reads "Session syncing" and raises a records request through the apply-closure observable; an unselected one reads "Sync session", lands an optimistic local delta, `POST`s `/session-sync/sessions/<id>`, and closes the menu (the host starts a cycle with the request). Nothing renders while the plugin is unconfigured (`status.configured === false`) or for a selected session this machine does not hold (`present === false`).
- The dialog: `GET /session-sync/sessions/<id>/records` (newest first) lists machine / time / direction / event count / conflict outcome, with a loading state and a retryable error state, and offers 立即同步 / 关闭同步 / 关闭. `shell.overlay` is click-through, so the surface opts back into pointer events through the ui-primitives `Modal` (its own full-viewport layer sets `pointer-events: auto`).
- The settings page: the read-only workspace → session tree (with a warning badge for 0 namesakes and for several) and the read-only pending-workspaces section — deliberately **no** binding UI: creating a same-named local workspace is what makes them sync.
- The selection is read once at client start (the row menu must label itself while the settings page was never opened) and refreshed after every mutation, on `settings/document-updated` (same namespace), and on `connection/reset`.
- The page no longer consumes `useWorkspaces`: the tree's `matched` / `matches` come from the host's selection view.
- `shell.overlay` is declared by ui-layout, which this package does not depend on, so `src/client/slot-contract.ts` restates that one `SlotMap` declaration (types only, nothing at runtime); the host route literals are restated in `src/client/api.ts` for the same reason (the browser bundle's purity gate forbids cross-plugin value imports).
