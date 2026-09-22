[English](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/session-sync/README.en.md) | 简体中文

# @linbin-mk/dsh-session-sync

[![npm 版本](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![许可证](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)

dsh-session-sync 插件的 host 半边：DeepSeek Harness 的 git 后端自动会话同步服务（`ctx.sessionSync`）。

架构、组合与安装见[仓库 README](https://github.com/linbin-mk/dsh-session-sync#readme)。本包导出：

- `SessionSyncService`（默认导出）：cordis 服务——设置命名空间、定时器、单飞周期与 `session-sync/completed` 事件。
- 引擎（`compareLogs`、`runSyncCycle`）、仓库格式工具、`GitRepository`/`GitError`、设置契约（`SESSION_SYNC_NAMESPACE`、schema、校验）。
- 切换提醒（`SWITCH_NOTICE_TEXT`、`createSwitchNoticeMessage`、`withSwitchNotice`）：为「切换电脑后首次续聊」注入一次插件 `notice` 消息。
- HTTP 面（`registerSessionSyncRoutes`、路由路径、wire 类型），挂载 `webServer` 时注册到 harness 的开放路由缝。

浏览器半边见 [`@linbin-mk/dsh-client-ui-settings-sync`](https://www.npmjs.com/package/@linbin-mk/dsh-client-ui-settings-sync)。

## 组合配置

```yaml
- id: session-sync
  name: '@linbin-mk/dsh-session-sync'
  config:
    startupSyncDelayMs: 3000
```

要求 `settings` 与 `sessionPersistence` 服务；`workspaceRegistry` 可选（存在时导入的会话会挂到工作区，仓库里每个项目的 `archived.json` 标记也会应用到本机归档集合，让其他电脑上归档的会话在本机同样隐藏）。`webServer` 同样可选——没有它时插件以 headless 运行，只是不提供 Web 路由。切换提醒监听 harness 的 `agent/pre-step` 事件（`dsh-agent`/`dsh-llm` 依赖）：没有 agent 服务的部署只是永远不会触发注入。

## 仓库格式

```text
manifest.json                    { "version": 1, "projects": [...] }
projects/<key>/session-<id>.jsonl
projects/<key>/archived.json     { "version": 1, "sessionIds": [...] }  —— 只增并集
conflicts/<key>/<stem>-<host>.jsonl
```

每个会话工件的首行是版本化 `dsh-session-sync` 文件头，包含可移植项目 key、当前公开 Session header 字段和 `inheritedEventCount`；其余每行是一条逻辑 `SessionEvent`。它不嵌入任何持久化后端的物理行编码。旧版 raw-storage 实现生成的工件会被拒绝，不做迁移。

归档列表是收敛的只增并集：harness 的归档集合没有取消归档路径，因此每台电脑都把仓库中的标记并入自己的归档集合，并把自己的标记并回仓库。已归档会话的 `session-<id>.jsonl` 会从仓库中删除（本机副本不受影响），归档会话不再占用 git 空间，只有标记继续传播。

## HTTP API

| 路由 | 方法 | 用途 |
|---|---|---|
| `/session-sync/status` | GET | 只读状态视图 |
| `/session-sync/sync-now` | POST | 执行一个周期并返回最新状态 |
| `/session-sync/settings` | GET | `{ writable, settings }` |
| `/session-sync/settings` | POST | 合并 patch（host 校验，返回 `{ ok: true }` 或 `400 { error }`） |

写路由强制同源校验并拒绝畸形请求体。

## 配置项

`session-sync` 设置命名空间：`enabled`、`remote`（SSH 地址）、`branch`（默认 `main`）、`intervalMinutes`（默认 5）、`mappings: [{ key, path }]`。完整表格见[仓库 README](https://github.com/linbin-mk/dsh-session-sync#readme)。

## 开发

```sh
pnpm test        # engine / format / git / settings / service / routes / Loader 组合
pnpm typecheck
pnpm build       # tsc → lib
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
