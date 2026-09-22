English | [简体中文](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/client-ui-settings-sync/README.md)

# @linbin-mk/dsh-client-ui-settings-sync

[![npm version](https://img.shields.io/npm/v/@linbin-mk/dsh-client-ui-settings-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-client-ui-settings-sync)
[![license](https://img.shields.io/npm/l/@linbin-mk/dsh-client-ui-settings-sync)](LICENSE)

The browser half of the dsh-session-sync plugin: the Sync settings page (`settings.section` id `sync`) and the sidebar status dot (`sidebar.footer.action` id `session-sync-status`) for the DeepSeek Harness web GUI.

All plugin data arrives through the host's own same-origin HTTP API (`/session-sync/*`, plain `fetch`) — the browser package never touches the harness RPC table. Workspace choices come from the standard `useWorkspaces` hook.

The host half is [`@linbin-mk/dsh-session-sync`](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync).

## Composition

```yaml
- id: ui-settings-sync
  name: '@linbin-mk/dsh-client-ui-settings-sync'
```

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
