[English](https://github.com/linbin-mk/dsh-session-sync/blob/main/packages/session-sync/README.en.md) | 简体中文

# @linbin-mk/dsh-session-sync

[![npm 版本](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![许可证](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)

dsh-session-sync 插件的 host 半边：DeepSeek Harness 的 git 后端自动会话同步服务（`ctx.sessionSync`）。

架构、组合与安装见[仓库 README](https://github.com/linbin-mk/dsh-session-sync#readme)，实现契约见 [`docs/spec/session-sync-v2.md`](../../docs/spec/session-sync-v2.md)。本包导出：

- `SessionSyncService`（默认导出）：cordis 服务——读 profile 行的活配置、定时器、单飞周期、同源 HTTP 路由与 `session-sync/completed` 事件。
- 引擎（`decideSelectionSync`、`assignWorkspaceKey`、`foldTitle`、`compareLogs`、`runSyncCycle`）、仓库格式工具（`parseSelection`/`serializeSelection`、`parseManifest`/`serializeManifest`、`parseRecords`/`mergeRecords`/`serializeRecords`、`parseState`/`serializeState`、`parseLocalSelection`/`serializeLocalSelection`）、`GitRepository`/`GitError`、配置契约（`Config`/`ConfigInput`、`SESSION_SYNC_NAMESPACE`、`readSettings`、`validateSessionSyncSettings`）。
- 选择树投影（`buildSelectionView`、`SelectionTreeInput`）：设置页「同步会话集合」的分组规则，纯函数。
- 切换提醒（`SWITCH_NOTICE_TEXT`、`createSwitchNoticeMessage`、`withSwitchNotice`）：为「切换电脑后首次续聊」注入一次本包自有 source kind 的 `notice` 消息。
- HTTP 面（`registerSessionSyncRoutes`、路由常量、`parseSessionRoute`、wire 类型），挂载 `webServer` 时注册到 harness 的开放路由缝。

浏览器半边**在同一个包里**：`exports["./client"]` 是 Web 客户端加载的 bundle（`lib/client.js`），由 `dsh.client` 声明。合并前它是独立的 `@linbin-mk/dsh-client-ui-settings-sync`，v0.6.0 起并入本包，那个包不再发布新版本——升级时记得先把旧行 `dsh plugin --profile <name> remove @linbin-mk/dsh-client-ui-settings-sync` 摘掉。

## 组合配置

```yaml
- id: session-sync
  name: '@linbin-mk/dsh-session-sync'
  config:
    startupSyncDelayMs: 3000
```

`config` 里的 `startupSyncDelayMs` 是部署项；`enabled`、`remote`、`branch`、`intervalMinutes`、`cleanup` 是设置页可写的活字段，写入由 harness 的 settings 服务落到 profile patch 文档。要求 DeepSeek Harness `0.1.7-rc.2`（peer：`@deepseek-ai/cordis ^4.0.4`、`@deepseek-ai/schemastery ^3.18.4`、`cordis-plugin-loader ^1.0.5`、`cordis-plugin-include ^1.0.9`）。要求 `settings` 与 `sessionPersistence` 服务；`workspaceRegistry` 是落位能力（按名匹配、按 cwd 反查、归档标记应用都要它，缺少时导出与导入都会被跳过并报告）；`sessionProjectionCache` 可选（导入后预热；设置页也用它零 I/O 读标题）。`webServer` 同样可选——没有它时插件以 headless 运行，只是不提供 Web 路由。切换提醒监听 harness 的 `agent/pre-step` 事件（`dsh-agent`/`dsh-llm` 依赖）：没有 agent 服务的部署只是永远不会触发注入。

## 仓库格式 v2

```text
sync.json                                    跨机同步集合（整份快照，替代 v1 的 pinned.json）
workspaces/<key>/manifest.json               { version, key, name, updatedAt }   ← name 是匹配用的真相
workspaces/<key>/session-<id>.jsonl          会话工件
workspaces/<key>/session-<id>.records.json   该会话的同步记录（机器 + 时间，最近 20 条）
workspaces/<key>/archived.json               { "version": 1, "sessionIds": [...] }  只增并集
conflicts/<key>/<session-id>-<host>.jsonl
```

每个会话工件的首行是版本化 `dsh-session-sync` 文件头（版本 2），包含稳定工作区 key、当前公开 Session header 字段和 `inheritedEventCount`；其余每行是一条逻辑 `SessionEvent`。它不嵌入任何持久化后端的物理行编码。v1（`project` 字段、`projects/` 目录、`pinned.json`）的工件会被明确拒绝，不做迁移。

`sync.json` 的每条记录带 `id`、`key`、`workspaceName`、`title`、`addedAt`、`addedBy`：工件头没有标题，而集合里包含本机尚未导入的会话，所以标题必须随快照走，设置页才能离线画出完整清单。

选择收敛：快照是整份而非并集，因此「关闭同步」可以传播。每台机器在 harness home 下维护 `selection.json`（本机集合）与 `state.json`（锚点：上次实际应用的选择、本机拥有的 id、工作区→key 记忆）。本机集合与锚点不一致就是本机编辑，于是发布；一致就是仓库变了，于是采纳。锚点只在推送成功后写入，且首次周期只采纳、不清理。

落位：导入前用 `manifest.json` 的 `name` 与本机工作区标题精确匹配，**恰好命中一个**才导入，并把该工作区路径写进工件 header 的 `cwd`（harness 要求 cwd 与工作区路径一致才允许挂载，且创建后不可改）。零命中或多命中都会把该工作区下的会话放进待匹配列表。

归档列表仍是收敛的只增并集：每台电脑都把仓库中的标记并入自己的归档集合，并把自己的标记并回仓库。已归档会话的 `session-<id>.jsonl` 会从仓库中删除（本机副本不受影响），只有标记继续传播。

## HTTP API

| 路由 | 方法 | 用途 |
|---|---|---|
| `/session-sync/status` | GET | 只读状态视图 |
| `/session-sync/selection` | GET | 同步集合树（工作区 → 会话）+ 待匹配 |
| `/session-sync/sessions/<id>` | POST | 把会话加入同步集合，并立刻触发一个周期 |
| `/session-sync/sessions/<id>` | DELETE | 关闭该会话的同步 |
| `/session-sync/sessions/<id>/records` | GET | 该会话的同步记录（机器 + 时间，新的在前） |
| `/session-sync/sync-now` | POST | 执行一个周期并返回最新状态 |
| `/session-sync/cleanup-now` | POST | 执行一次 git 空间清理并返回最新状态 |
| `/session-sync/settings` | GET | `{ writable, settings }`（供 memory 模式的页面只读展示） |
| `/session-sync/settings` | POST | 合并 patch（host 校验，返回 `{ ok: true }` 或 `400 { error }`） |
| `/session-sync/logs` | GET | 最近同步日志 |

会话路由挂在一条 `prefix` 注册（`/session-sync/sessions`）上，因为会话 id 不是固定路径段。写路由强制同源校验并拒绝畸形请求体；会话 id 在进入任何路径前先按 `session-…` 形状校验。

## 配置项

`session-sync` 这一行 profile 条目的 Cordis Config：`startupSyncDelayMs`（部署项，默认 3000）与用户可改的 `enabled`、`remote`（SSH 地址）、`branch`（默认 `main`）、`intervalMinutes`（默认 5）、`cleanup`。v2 已删除 `mappings`：同步范围是插件自己的显式集合，跨机落位靠工作区名称，机器上不再有任何按项目的配置。设置页通过 harness 的 config form 读写这些字段（`ctx.configForms.get('session-sync')`），写入持久化在 profile patch 文档里。完整表格见[仓库 README](https://github.com/linbin-mk/dsh-session-sync#readme)。

## 浏览器半边

`src/client/` 是 Web 客户端那一半：设置页（`settings.section` id `sync`）、侧栏状态点（`sidebar.footer.action` id `session-sync-status`）、会话行菜单项（`sidebar.workspaces.session.menu.item` id `session-sync.toggle`，order 500）与同步记录弹窗（`shell.overlay` id `session-sync.dialog`）。

设置段的读写走 harness 通用的 config form（`ctx.configForms.get('session-sync')`：读取、订阅推送，写入是带修订号围栏的 `mutate`），因此不碰 harness 的 RPC 表；状态、集合树、手动同步/清理与每会话记录经 host 自建的同源 HTTP API（`/session-sync/*`，普通 `fetch`）传输。Host 把偏好保留在浏览器进程内的页面（非 loopback，`mode: 'memory'`）只读展示配置、禁用全部写入控件；config form 把 host 的拒绝压成 `false`，此时页面再用插件的 `POST /session-sync/settings` 取回拒绝原因。工作区选项来自标准的 `useWorkspaces` hook。

`lib/client.js` 由 `tsdown.config.ts` 打成 CJS 闭包工厂（`window.__ModuleLoader__.load`），CSS Modules 在构建期内联为 `<style data-plugin>`；构建带一条纯度门：平台模块（`react`、`ui-slots`、`ui-primitives` 等）保持 external，跨插件值导入直接构建失败。

**测试环境说明**：已发布的 harness 客户端包只以浏览器 bundle 形式提供其 `/client` 运行时面，第三方包无法在 Node 测试里导入 `SlotRegistry` 或测试运行时。因此本包把小型快照存储引擎 vendor 进 `src/client/store.ts`（裁剪自 harness 的 MIT 源码并注明出处，见 [NOTICE](NOTICE)），并在 `tests/helpers.ts` 与 `tests/ui-primitives.tsx` 中用最小假件测试 slot 注册、locale 与 remote 失效路径；真实 slot 核心行为由 harness 侧集成覆盖。组件用例自带 `// @vitest-environment jsdom`，与 host 用例共用一份 vitest 配置。

## 开发

```sh
pnpm test        # engine / format / selection / git / log / settings / service / routes / Loader 组合
pnpm typecheck
pnpm build       # tsc → lib
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
