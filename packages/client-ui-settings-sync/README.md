[English](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/client-ui-settings-sync/README.en.md) | 简体中文

# @linbin-mk/dsh-client-ui-settings-sync

[![npm 版本](https://img.shields.io/npm/v/@linbin-mk/dsh-client-ui-settings-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-client-ui-settings-sync)
[![许可证](https://img.shields.io/npm/l/@linbin-mk/dsh-client-ui-settings-sync)](LICENSE)

dsh-session-sync 插件的浏览器半边：DeepSeek Harness Web GUI 的会话同步设置页（`settings.section` id `sync`）与侧栏状态点（`sidebar.footer.action` id `session-sync-status`）。

插件数据全部经 host 自建的同源 HTTP API（`/session-sync/*`，普通 `fetch`）传输——浏览器包完全不碰 harness 的 RPC 表。工作区选项来自标准的 `useWorkspaces` hook。

host 半边见 [`@linbin-mk/dsh-session-sync`](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)。

## 组合配置

```yaml
- id: ui-settings-sync
  name: '@linbin-mk/dsh-client-ui-settings-sync'
```

## 开发

```sh
pnpm test        # controller、设置页、状态页脚、slot 注册
pnpm typecheck
pnpm build       # tsc（类型）+ tsdown（node 半边 + lib/client.js 浏览器 bundle）
```

测试基于最小假件（`tests/helpers.ts`）与 vendor 的快照存储引擎运行——因为已发布的 harness 客户端包只以浏览器 bundle 提供其 `/client` 运行时；详见[仓库 README](https://github.com/linbin-mk/dsh-session-sync#readme)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

`src/client/store.ts` 中的快照存储引擎裁剪自采用 MIT 许可证的 DeepSeek Harness；浏览器 bundle（`lib/client.js`）在构建期内联了同样采用 MIT 许可证的 zustand、immer 与 clsx。上游版权声明与许可证文本见 [NOTICE](NOTICE)。
