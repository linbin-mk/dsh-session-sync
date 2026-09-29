# session-sync v2 设计定稿

> 状态：已对齐（2026-09-29）。本文件是实现契约，v2 的代码、测试、README 都以它为准。
> v2 **不兼容** v0.4.x 写出的仓库，也不做旧格式迁移；版本直接跳 `0.5.0`。

## 0. 目标与非目标

目标：

1. 同步不再由置顶决定。会话行 `...` 菜单出现「同步会话」，点击即把该会话加入同步集合；再次打开菜单显示「会话同步中」；点它弹窗展示该会话的同步日志（哪台机器、什么时候），并可在弹窗里关闭同步。
2. 设置页删掉「项目映射」，改为展示同步会话集合，分级：工作区 → 会话。
3. 另一台电脑安装并开启后，同步来的会话**自动注入对应工作区**，以工作区**名称**匹配。

非目标（明确不做）：

- **不适配工作区改名**：仓库里的名称与本机工作区名对不上，就是匹配不到。
- **不做本地覆盖绑定**：不提供「把仓库里的 A 绑到本机的 B」这类映射，也不写任何本地绑定表。
- **不兼容旧仓库格式**：`pinned.json`、`projects/`、置顶看门狗全部删除，无迁移路径。
- **不新增 harness RPC**：继续走开放 `webServer` 路由缝上的自建同源 HTTP API。

## 1. 术语与状态

| 术语 | 含义 |
|---|---|
| 同步标记 | 用户对单个会话的显式选择，存在全局集合里 |
| 同步集合 | 跨机唯一的一份会话清单（`sync.json`），整份快照而非并集 |
| 工作区 key | 仓库目录名，创建后**永不变** |
| 工作区 name | 匹配用的真相，写在 `manifest.json` 里，可随改名更新 |
| 我的标记 | 本机发出的那部分标记（`ownedIds`），决定本机能否把它们撤下来 |

会话在插件里的状态（派生，不额外持久化）：

| 状态 | 判定 | 菜单文案 |
|---|---|---|
| 未加入 | 本机不在集合里，且该会话不属于任何工作区之外的普通情况 | 同步会话 |
| 已加入 | 在集合里 | 会话同步中 |
| 传输中 | 集合里，且当前周期正在处理它 | 会话同步中（前置 spinner） |
| 不可用 | 本机不持有该会话，或该会话不属于任何工作区 | 菜单项不渲染 |
| 待匹配 | 仓库里有、本机找不到同名工作区 | 不进菜单（只出现在设置页） |
| 未启用 | `enabled` 关闭或无 `remote` | 菜单项不渲染 |

## 2. 仓库格式 v2

```text
sync.json                                    全局同步集合（整份快照）
workspaces/<key>/manifest.json               { version, key, name, updatedAt }
workspaces/<key>/session-<id>.jsonl          会话工件（header.workspace = <key>）
workspaces/<key>/session-<id>.records.json   每会话同步记录（有界并集）
workspaces/<key>/archived.json               归档标记（只增并集，沿用）
conflicts/<key>/<session-id>-<host>.jsonl    冲突副本
```

`sync.json`：

```jsonc
{
  "version": 2,
  "updatedAt": "2026-09-29T10:00:00.000Z",
  "host": "machine-a",
  "entries": [
    {
      "id": "<sessionId>",
      "key": "ws-3f2a1c",              // 稳定目录 key
      "workspaceName": "dsh-session-sync", // 匹配用
      "title": "置顶功能插槽点分析",       // 供各机渲染集合树，无需先导入
      "addedAt": "2026-09-29T09:59:00.000Z",
      "addedBy": "machine-a"
    }
  ]
}
```

- `entries` 是整份快照：移除必须能被表达，所以不是并集。
- 携带 `title` / `workspaceName` 的原因：artifact 的 header 不含标题（只有 id、createdAt、parentSession、isSeeded、origin、delegationDepth、agentPreset），而集合里包含本机尚未导入的会话——不写进来，设置页就无法完整渲染。

`session-<id>.records.json`：

```jsonc
{
  "version": 2,
  "records": [
    { "host": "machine-b", "at": "2026-09-29T10:20:00.000Z", "direction": "pull", "events": 12, "result": "ok" }
  ]
}
```

- 每台机器在推送/拉取后追加自己的一条记录，按 `(host, at, direction)` 去重合并，上限 20 条（保新的）。
- 弹窗按 `at` 倒序展示。

## 3. 选择与收敛

本机状态是两个文件，都在 `$DSH_HOME/session-sync/` 下：

```jsonc
// selection.json —— 本机当前的同步集合（用户点击与采纳都写它）
{ "version": 2, "sessionIds": ["..."] }

// state.json —— 编辑检测锚点；只在推送成功后写
{
  "version": 2, "firstSeen": true, "host": "machine-a", "updatedAt": "...",
  "syncedIds": ["..."],                 // 上次实际应用的选择
  "ownedIds": ["..."],                  // 本机可移除的 id
  "workspaceKeys": [ { "workspaceId": "...", "key": "ws-1a2b3c4d5e" } ]
}
```

分成两个文件是因为写入时机不同：点击在任意时刻写 `selection.json`，锚点只在周期末尾推送成功后写；合成一个文件会让一次失败推送的回滚连带丢掉用户的点击。`workspaceKeys` 是工作区 id → 仓库目录 key 的记忆表，key 一旦分配就不再变化，所以改名只重写 manifest 的 `name`，不搬动任何产物。

收敛规则（沿用 v0.4 已验证的语义，只把「置顶集合」换成插件自己的集合同步标记）：

- **首次运行只采纳、不删除**：没有基线时，本机不把仓库的集合当成「你要移除」，因此不清理任何产物。
- **本机新增即发布**：本机有、仓库没有的 id → 写进快照并推送。
- **本机移除即发布**（仅限自己拥有的 id）：`ownedIds` 里的 id 从本机集合消失 → 从仓库快照移除，并清理它的产物。
- **失败不记账**：只有推送成功之后才写基线；远端没接受的发布下轮重试，而不是被读成删除。
- 无法解析的 `sync.json`：本轮不按它收敛，也**不允许**发布（不能覆盖读不懂的选择）。

## 4. 一个周期做什么

1. `ensure` / `fetch` / `resetHard`（沿用现有 `GitRepository`）。
2. 读 `sync.json` → 集合；读本地基线与本机集合。
3. 决定本轮 selection（发布 / 采纳 / 可清理）。
4. **导入**：遍历 `workspaces/*` →
   - 读 `manifest.json` 取 `name` → 在本机工作区里按 title 精确匹配；
   - 唯一命中：把工件 header 的 `cwd` 改写成该工作区路径 → `create`/`append` → `attachSession` → 预热投影缓存 → 记一条 `pull` 记录；
   - 0 命中或 >1 命中：**不导入**，记入「待匹配」；
   - 工件未闭合 turn：跳过（沿用）。
5. **导出**：本机标记里、且本机真正持有的会话 →
   - 由会话 header 的 `cwd` 反查本机工作区（`resolveByPath`）→ 拿到 key/name；
   - 会话不属于任何工作区：跳过并在状态里报一条（菜单项本就不给入口）；
   - 写工件、更新 `manifest.json`、追加一条 `push` 记录；
   - 复用冲突策略：前缀合并 + 双副本，绝不静默丢数据。
6. 归档联动：归档 = 退出集合 + 仓库产物删除 + 标记传播（沿用，标记范围改为参与同步的工作区）。
7. 发布集合快照、清理退役产物。
8. 写回 `manifest.json` 汇总，`addAll` / `commit` / `push`。

## 5. 匹配规则（唯一裁决）

- 只用 `manifest.name` 与 `Workspace.title` 比较，**trim 后全等**；大小写敏感。
- **只有恰好命中一个工作区**才自动导入。
- 0 命中（含改名导致的失配）与多命中（harness 允许不同路径共用同一 title）一律进「待匹配」。
- 待匹配**没有**任何绑定动作：用户在本机用侧栏「添加工作区」建出同名工作区后，下一个周期自动匹配并导入。
- 待匹配不影响其余会话：它是每个会话独立的判定，不是整批阻塞。

## 6. HTTP API

| 路由 | 方法 | 用途 | 变化 |
|---|---|---|---|
| `/session-sync/status` | GET | 状态视图（含 `syncedCount`、`pending`、`lastRun`） | 改 `pinnedCount` → `syncedCount` |
| `/session-sync/selection` | GET | 集合树：工作区 → 会话 + 待匹配区 | 新增 |
| `/session-sync/sessions/:id` | POST | 把会话加入同步集合 | 新增 |
| `/session-sync/sessions/:id` | DELETE | 把会话移出集合（关闭同步） | 新增 |
| `/session-sync/sessions/:id/records` | GET | 该会话的同步记录（机器+时间） | 新增 |
| `/session-sync/sync-now` | POST | 立即同步 | 沿用 |
| `/session-sync/cleanup-now` | POST | 立即清理 git 空间 | 沿用 |
| `/session-sync/settings` | GET / POST | 设置视图与 patch 写入 | 沿用（去掉 mappings） |
| `/session-sync/logs` | GET | 周期日志 | 沿用 |

写路由继续强制同源校验；`:id` 必须是合法 `SessionId`。

## 7. 客户端

| 槽 | id | 内容 |
|---|---|---|
| `sidebar.workspaces.session.menu.item` | `session-sync.toggle` | order 500 |
| `shell.overlay` | `session-sync.dialog` | 同步日志弹窗 |
| `settings.section` | `sync` | 设置页（沿用，内容改版） |
| `sidebar.footer.action` | `session-sync-status` | 状态点（沿用） |

菜单项：

- 未启用 → 不渲染；会话不可用（不属于任何工作区、或本机不持有）→ 不渲染。
- 未加入 → 「同步会话」；已加入 → 「会话同步中」（周期在跑时前置 spinner）。
- 点击：本地乐观置为已加入 → `POST` → 立即踢一次同步周期（单飞守卫）→ 关闭菜单。
- 用 ui-primitives 的 `MenuItemButton`，与 harness 原生菜单行同款。

弹窗（`shell.overlay` + ui-primitives `Modal`）：

- 标题：会话标题；正文：记录列表（机器 / 时间 / 方向 / 事件数 / 结果），按时间倒序；
- 动作：「立即同步」「关闭同步」「关闭」；
- 「关闭同步」= 从全局集合移除；**本机已有会话文件一律保留**，仓库产物下个周期清理。

设置页：

- 删除：映射编辑器、`mappings` 字段与校验、相关文案。
- 新增「同步会话集合」树：工作区 → 会话；每行显示标题、加入时间、加入机器、最近同步（机器+时间）、状态徽标；行尾「关闭同步」。
- 新增只读「待匹配工作区」区：列出仓库里有、本机没有同名工作区的会话，附一行说明——在本机创建同名工作区后会自动同步。

## 8. 必须保持的不变式

- **本机会话永不删除**：任何路径都不删本机会话文件。
- 冲突双副本，数据绝不静默丢失。
- 未闭合 turn 不出网（导出跳过、导入跳过）。
- 切换电脑后首次续聊注入一次 `notice` 提醒（子代理会话除外）。
- 写路由同源校验；机器路径永不进入仓库。
- 清理按周期重写历史并强推，保留提交的最新树原样保留。
- 插件不存任何凭据。

## 8.5 包结构（v0.6.0 起）

host 与浏览器半边合并进**一个包** `@linbin-mk/dsh-session-sync`：`main` 是 Host 插件，`exports["./client"]` 是 Web 客户端加载的 bundle，`dsh.client` + `dsh.bundle` 让一行 profile 条目同时承载两半。源码分别位于 `src/`（host）与 `src/client/`（浏览器），构建是 `tsc -p . && tsdown`；测试共用一份 vitest 配置（组件用例自带 `// @vitest-environment jsdom`）。原独立包 `@linbin-mk/dsh-client-ui-settings-sync` 不再发布新版本，其空的 `./invariant` 伴生导出一并移除。

## 9. 影响面

- **host**：`settings.ts`（−mappings）、`format.ts`（v2 四类文件）、`engine.ts`（选择/导入/导出/记录）、`api.ts`、`routes.ts`、`index.ts`（+选择存储、+按名解析工作区、−置顶端口、−看门狗）、`log.ts`。
- **client**：`index.ts`（+2 槽）、新增 `SessionSyncMenuItem.tsx`、`SessionSyncDialog.tsx`、`SyncSection.tsx`（−映射 +树）、`controller.ts`、`api.ts`、`locales.ts`。
- **删除**：`pinned.json` 全链路、置顶端口、映射校验与 UI、30 秒看门狗。
- 版本：两个包一起跳 `0.5.0`。
