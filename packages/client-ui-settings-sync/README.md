[English](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/client-ui-settings-sync/README.en.md) | 简体中文

# @linbin-mk/dsh-client-ui-settings-sync

[![npm 版本](https://img.shields.io/npm/v/@linbin-mk/dsh-client-ui-settings-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-client-ui-settings-sync)
[![许可证](https://img.shields.io/npm/l/@linbin-mk/dsh-client-ui-settings-sync)](LICENSE)

dsh-session-sync 插件的浏览器半边：DeepSeek Harness Web GUI 的会话同步设置页（`settings.section` id `sync`）与侧栏状态点（`sidebar.footer.action` id `session-sync-status`）。

设置段走 harness 通用的 config form（`ctx.configForms.get('session-sync')`：读取、订阅推送，写入是带修订号围栏的 `mutate`），因此不碰 harness 的 RPC 表；状态、手动同步/清理与日志经 host 自建的同源 HTTP API（`/session-sync/*`，普通 `fetch`）传输。Host 把偏好保留在浏览器进程内的页面（非 loopback，`mode: 'memory'`）只读展示配置、禁用全部写入控件；config form 把 host 的拒绝压成 `false`，此时页面再用插件的 `POST /session-sync/settings` 取回拒绝原因。工作区选项来自标准的 `useWorkspaces` hook。

host 半边见 [`@linbin-mk/dsh-session-sync`](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)。

## 组合配置

```yaml
- id: ui-settings-sync
  name: '@linbin-mk/dsh-client-ui-settings-sync'
```

要求 DeepSeek Harness `0.1.7-rc.2`（`@deepseek-ai/cordis ^4.0.4`），并 peer 依赖 Host 半边 `@linbin-mk/dsh-session-sync ^0.4.0`。

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

## v2（0.5）浏览器半边

v2 起会话同步不再由置顶决定：会话行 `...` 菜单里出现本插件的条目，设置页改为只读的同步会话集合。本包现在注册四个槽：

| 槽 | id | order | 内容 |
|---|---|---|---|
| `settings.section` | `sync` | 30 | 设置页（`enabled` / `remote` / `branch` / `intervalMinutes` / `cleanup` 仍是草稿-保存，`mappings` 已删除） |
| `sidebar.footer.action` | `session-sync-status` | 0 | 状态点（名称改为 `syncedCount`） |
| `sidebar.workspaces.session.menu.item` | `session-sync.toggle` | 500 | 「同步会话」/「会话同步中」 |
| `shell.overlay` | `session-sync.dialog` | 0 | 该会话的同步记录弹窗 |

- 菜单项：已加入 → 「会话同步中」，点击经 apply 闭包里的 observable 向弹窗提出请求；未加入 → 「同步会话」，点击先落本地乐观状态再 `POST /session-sync/sessions/<id>` 并关闭菜单（host 顺带立刻跑一轮）。插件未配置（`status.configured === false`）或集合里该会话 `present === false`（本机不持有）时整条不渲染。
- 弹窗：`GET /session-sync/sessions/<id>/records`（新→旧）列出机器 / 时间 / 方向 / 事件数 / 冲突，带加载与可重试的错误态，动作为「立即同步」「关闭同步」「关闭」。`shell.overlay` 本身点击穿透，弹窗经 ui-primitives 的 `Modal`（自己的全屏层设 `pointer-events: auto`）重新接收指针事件。
- 设置页：只读的「同步会话集合」树（工作区 → 会话；同名 0 个 / 多个分别给出警告徽标）与只读的「待匹配工作区」区（**没有**任何绑定 UI：在本机建同名工作区即自动匹配）。
- 选择集合在插件启动时就读一次（行菜单在设置页从未打开时也要能判定文案），此后每次变更、`settings/document-updated`（同命名空间）与 `connection/reset` 都会刷新。
- 本机不再使用 `useWorkspaces`：树上的 `matched` / `matches` 由 host 的选择视图给出。
- `shell.overlay` 由 ui-layout 声明，而本包不依赖它，因此 `src/client/slot-contract.ts` 原样重述了该槽的 `SlotMap` 声明（仅类型，运行期不依赖）；host 路由字面量同理在 `src/client/api.ts` 重述（浏览器 bundle 的纯净性门禁禁止跨插件值导入）。
