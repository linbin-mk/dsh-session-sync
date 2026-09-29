[English](https://github.com/linbin-mk/dsh-session-sync/blob/main/README.en.md) | 简体中文

# dsh-session-sync

[![npm 版本](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![发布流水线](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml/badge.svg)](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml)
[![许可证](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)
[![Node](https://img.shields.io/node/v/@linbin-mk/dsh-session-sync)](package.json)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的第三方会话同步插件：通过一个 git 仓库，在多台电脑之间同步**你亲手挑的**会话，并自带 Web 界面。

```
┌───────────── 电脑 A ─────────────┐      ┌───────────── 电脑 B ─────────────┐
│ DSH host ── session-sync 插件 ───┼─git──┼─── session-sync 插件 ── DSH host ─│
│   └─ /session-sync/*（自建 HTTP API）│    │   └─ /session-sync/*（自建 HTTP API）│
│ 浏览器 UI ── fetch（同源）        │      │ 浏览器 UI ── fetch（同源）        │
└─────────────────────────────────┘      └─────────────────────────────────┘
```

- **点一下才开始同步。** 在侧栏会话行的 `...` 菜单里选「同步会话」，这个会话就加入**跨机共享的同步集合**；再次打开菜单会看到「会话同步中」，点它弹出同步日志（哪台机器、什么时候、推还是拉、多少条事件），弹窗里可以直接「关闭同步」。不需要先置顶，也不再有「项目映射」这类配置。
- **会话跟着你走，机器路径不跟。** 每个会话导出为 `workspaces/<key>/session-<id>.jsonl`；首行是插件自有的版本化文件头，记录工作区的稳定 key 而不是本机路径。导入时按工作区**名称**解析成本机路径，插件不复制 harness JSONL 后端的私有文件、压缩或行编码。
- **集合是全局一份真相。** 仓库根部的 `sync.json` 是整份快照（不是并集），每台机器把它镜像进自己的选择；谁在哪台机器上关闭同步，都会传播到所有机器。为了不让「谁改了什么」互相打架，每台机器在 harness home 下记一份锚点（`state.json`）：自己的选择变了就发布，没变就采纳仓库的。
- **首次运行只采纳、不删除。** 一台还没跑过周期的机器（没有锚点）不会把仓库里的选择当成「要关闭同步」，因此不会误删仓库产物。同一条保护也覆盖之后任何无法发布的周期：锚点只记录真正应用的选择，且只在推送成功之后记录，所以本机从未持有过的选择不会被读成「你关闭了它」，远端没接受的发布也会重试而不是被当成删除。
- **按名字落到工作区。** 每个 `workspaces/<key>/manifest.json` 记录该工作区的**显示名称**：另一台电脑上标题完全相同的那个工作区就是目的地。只有**恰好命中一个**才自动导入；一个都没命中（包括任一方改过名——改名不适配）、或者本机有多个同名工作区（harness 允许不同路径共用标题）时，这些会话留在**待匹配**里等你在本机建出同名工作区，下一个周期自动落位。**没有绑定 UI，也不写任何本地映射。**
- **不落地就不导入。** harness 里一个会话只能挂到「路径等于该会话 header 里 cwd」的工作区，而且 cwd 一旦创建就不可改、也没有跨工作区改挂的接口。所以插件在导入**之前**就完成匹配并把 cwd 写成本机工作区路径；匹配不上就原样留在仓库里等，绝不猜一个位置先塞进去。
- **冲突策略：前缀合并 + 双副本。** 会话日志是只追加的事件流：一份日志是另一份的严格前缀时，更长者胜出；真正分叉时，远端尾巴原样保留在 `conflicts/<key>/<session-id>-<host>.jsonl` 并上报——数据绝不静默丢失。分叉时的导出永远不会覆盖仓库工件。
- **未闭合 turn 不出网。** 没有以 `turn/end` 收尾的日志，要么正在所属电脑上实时运行，要么是崩溃后等待 harness 的「中断修复」。把它导出等于发布一个截断快照：导入方加载后会被 harness 补上合成的修复尾巴，从此与本机的真实后续内容永久分叉。因此导出跳过未闭合 turn 的日志，导入也跳过未闭合 turn 的工件。
- **本机会话在任何情况下都不会被删除。** 关闭同步、归档、清理，都只影响仓库里的产物和共享标记，本机那份完整保留。
- **归档标记跟着走，归档内容退出 git。** 在一台电脑上归档的会话，通过 `workspaces/<key>/archived.json` 里的标记在每台电脑的会话列表中都隐藏，同时它在仓库里的 `session-<id>.jsonl` 会在下一次同步时被删除——归档会话不再占用 git 空间。仓库里的标记是只增并集，永远不会产生冲突。
- **导入即预热投影缓存。** 同步导入直接写持久化、绕过 live 会话存储，harness 的投影缓存不会自动折叠它；插件在每次导入后对会话做一次冷读预热（fail-soft），标题、子代理分组等列表行元数据立即可见，无需先点开会话。
- **切换电脑后的首次续聊注入一次提醒。** 每当导入给某个会话带来来自其他电脑的新事件，插件就为它武装一个一次性标记（持久化在 harness home 下，重启不丢）。该会话的用户首次发消息时——经 harness 的 `agent/pre-step` 缝检测——一条插件 `notice` 消息会紧跟在用户消息之后折入上下文，告知大模型：本会话历史是从另一台电脑同步而来的，历史路径可能与当前电脑不符，此后一律以当前工作目录为准。标记注入即消耗。子代理会话除外。
- **仓库只是传输介质。** 每个周期执行 fetch → 硬重置 → 导入 → 导出 → 提交 → 推送，git 合并冲突无从产生。远程命令（`ls-remote`、`fetch`、`push`）自带指数退避重试（默认最多 3 次尝试），一次瞬时的 SSH 连接损坏不再让整个周期报废。
- **定期清理 git 空间。** git 不会遗忘已删除的文件：归档删除只影响 HEAD，历史里的每个旧版本永远留在对象库里。清理功能按周期（小时）把共享历史重写到只保留最近 N 次提交（默认 200）并强推（`--force-with-lease`），被截断的提交连同它们的 blob 一起退出仓库；重放保留提交时最新树原样保留——当前所有文件一个不少，其他电脑在下一个周期自动按重写后的历史重新同步。
- **同步日志保留 3 天。** 每个周期在 harness home 的 `session-sync/logs/sync-YYYY-MM-DD.jsonl` 里追加开始/成功/失败记录（含计数、冲突副本、错误与耗时），读写时自动清理超出 3 天窗口的日志文件；设置页的折叠面板展示最近记录。另外，**每个会话**有一份自己的同步记录（`workspaces/<key>/session-<id>.records.json`，保留最近 20 条），那是行菜单弹窗里显示的「机器 + 时间」来源，会随仓库传播，所以你能看到另一台机器什么时候拉过它。
- **自带 Web 界面。** 设置页（总开关、SSH 仓库地址、分支、同步间隔、git 空间清理、同步会话集合树、待匹配工作区、立即同步/立即清理）+ 侧栏同步状态点 + 会话行菜单项 + 同步日志弹窗。设置页的配置区仍是**草稿 + 显式保存**：改完点「保存」才写入，「撤销修改」丢弃改动，校验（必填、分支非空）就地提示。

## 为什么这个插件不需要改 harness 核心代码

harness 的 RPC 表（`apiproxy`）是编译器锁死的静态注册表——第三方包无法往里添加 `sessionSync.*` 方法。本插件改在 harness **开放的 `webServer` 路由缝**上注册自己的同源 HTTP API：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/session-sync/status` | GET | 只读同步状态视图 |
| `/session-sync/selection` | GET | 同步集合树（工作区 → 会话）+ 待匹配 |
| `/session-sync/sessions/<id>` | POST | 把会话加入同步集合 |
| `/session-sync/sessions/<id>` | DELETE | 关闭该会话的同步 |
| `/session-sync/sessions/<id>/records` | GET | 该会话的同步记录（机器 + 时间，新的在前） |
| `/session-sync/sync-now` | POST | 执行一个同步周期并返回最新状态 |
| `/session-sync/cleanup-now` | POST | 执行一次 git 空间清理并返回最新状态 |
| `/session-sync/settings` | GET | 设置视图（`writable` + 配置段） |
| `/session-sync/settings` | POST | 合并一个 patch 到设置段（host 校验） |
| `/session-sync/logs` | GET | 最近同步日志（保留窗口内，新的在前，`?limit=` 上限 500） |

浏览器端用普通 `fetch` 调用这些路由。写路由拒绝跨源请求（`Origin` 头必须指向本服务器自身 host）和畸形请求体。设置段的读写走 harness 通用的 config form（`ctx.configForms`，入口 id 就是 profile 里的 `session-sync` 行），插件自己的设置路由仍保留两个用途：`GET` 供 Host 把偏好保留在浏览器进程内的页面（非 loopback 页面，`mode: 'memory'`）只读展示配置，`POST` 是唯一带回 host 拒绝原因的写入路径。

界面本身也全部走 harness 开放的插槽，没有一处需要改核心：

| 槽 | id | 内容 |
|---|---|---|
| `settings.section` | `sync` | 同步设置页 |
| `sidebar.footer.action` | `session-sync-status` | 侧栏状态点 |
| `sidebar.workspaces.session.menu.item` | `session-sync.toggle` | 会话行 `...` 菜单项（order 500） |
| `shell.overlay` | `session-sync.dialog` | 同步日志弹窗 |

## 仓库结构

```
packages/session-sync/  @linbin-mk/dsh-session-sync（host 半边 + 浏览器半边，一个包）
```

host 包包含同步引擎（`engine.ts`、`format.ts`、`git.ts`、`settings.ts`）、选择树投影（`selection.ts`）、服务（`index.ts`）与 HTTP 层（`api.ts`、`routes.ts`）。浏览器包含设置页、集合树、会话行菜单项、同步日志弹窗、状态页脚、页面控制器与 fetch 客户端。

仓库格式（v2）：

```text
sync.json                                    跨机同步集合（整份快照）
workspaces/<key>/manifest.json               { version, key, name, updatedAt }   ← name 是匹配用的真相
workspaces/<key>/session-<id>.jsonl          会话工件
workspaces/<key>/session-<id>.records.json   该会话的同步记录（机器 + 时间，最近 20 条）
workspaces/<key>/archived.json               归档标记（只增并集）
conflicts/<key>/<session-id>-<host>.jsonl    冲突副本
```

`sync.json` 的每条记录带 `id`、`key`、`workspaceName`、`title`、`addedAt`、`addedBy`。带 `title` 不是冗余：工件头里没有标题（只有 id、createdAt、parentSession、isSeeded、origin、delegationDepth、agentPreset），而集合里包含本机还没导入的会话——不写进来，设置页就画不出完整清单。

本机状态（harness home 下的 `session-sync/`）：

```text
selection.json   { sessionIds }        本机当前的同步集合
state.json       { firstSeen, syncedIds, ownedIds, workspaceKeys }   编辑检测锚点 + 工作区→key 记忆
repo/            git 工作树
logs/            周期日志
```

`workspaceKeys` 是工作区 id → 仓库目录 key 的记忆表：key 一旦分配就不再变化，所以**改名只会重写 manifest 里的 name，不会搬动任何产物**。

## 环境要求

- Node.js `^22.19 || >=24`
- DeepSeek Harness `0.1.7-rc.2`（所有 `@deepseek-ai/*` 依赖均使用 npm 发布版本，不含本机 harness 链接）
- 两个包声明的 peer 线：`@deepseek-ai/cordis ^4.0.4`、`@deepseek-ai/schemastery ^3.18.4`、`cordis-plugin-loader ^1.0.5`、`cordis-plugin-include ^1.0.9`
- PATH 中有 `git`，且同步远端需要 SSH key（host key 策略：`StrictHostKeyChecking=accept-new`）
- 只有从源码构建时才需要 pnpm

### 0.6.0 破坏性变更：两个包合并成一个

host 半边与浏览器半边现在是**同一个包** `@linbin-mk/dsh-session-sync`：`main` 是 Host 插件，`exports["./client"]` 是 Web 客户端加载的浏览器 bundle，`dsh.client` + `dsh.bundle` 让**一行** profile 条目同时承载两半（与 harness 自己的 `@deepseek-ai/dsh-experimental-inspector` 同一形态）。`@linbin-mk/dsh-client-ui-settings-sync` 不再发布新版本。

- **升级要两步**：先 `dsh plugin --profile <name> remove @linbin-mk/dsh-client-ui-settings-sync` 把旧的那行摘掉，再 `dsh plugin --profile <name> add @linbin-mk/dsh-session-sync`。不摘旧行的话，旧包仍会注册同一批槽（`settings.section` / `sidebar.footer.action` / `sidebar.workspaces.session.menu.item` / `shell.overlay`），与新包重复。
- 顺带删掉了旧浏览器包里的 `./invariant` 空伴生导出（没有任何 patch 行引用它）。

### 0.5.0 破坏性变更：从「置顶即同步」到「逐会话显式同步」

- **同步选择换了主人。** v0.4 的选择 = 映射项目 ∩ 置顶会话，靠 harness 的置顶集合承载；v0.5 是插件自己的显式集合，入口在会话行 `...` 菜单。插件不再读写任何置顶状态。
- **项目映射整个删除。** 跨机落位改为按**工作区名称**匹配 `manifest.json` 的 `name`。
- **仓库格式升级到 v2，且不兼容 v0.4 写出的仓库。** `pinned.json` 与 `projects/` 目录不再被读取，工件头版本从 1 升到 2。**请用一个新仓库**（或清空旧仓库内容）后重新逐个添加要同步的会话；升级本身不做迁移，也不会删除任何本机会话。
- 需要 DeepSeek Harness `0.1.7-rc.2`；仍停留在 `0.1.7-alpha.1` 的 profile 无法安装本版本。

## 安装

把已发布的包装进自定义 Web profile。包声明了 `dsh.bundle` patch，**一行**会自动加入，它同时承载 Host 半边与浏览器半边：

```sh
dsh --profile web-sync --from-default-profile web --dump-config
dsh plugin --profile web-sync add @linbin-mk/dsh-session-sync
dsh --profile web-sync
```

改为安装本地构建的 tarball：

```sh
cd dsh-session-sync
pnpm install && pnpm build
pnpm --dir packages/session-sync pack

dsh plugin --profile web-sync add ./linbin-mk-dsh-session-sync-0.6.0.tgz
```

从同一个 profile 移除：

```sh
dsh plugin --profile web-sync remove @linbin-mk/dsh-session-sync
```

## 组合配置

```yaml
- id: session-sync
  name: '@linbin-mk/dsh-session-sync'
  config:
    startupSyncDelayMs: 3000
```

安装会自动加入上面的两行。host 插件要求 `settings` 与 `sessionPersistence` 服务；`workspaceRegistry` 现在是**必需的能力**（没有它就无法按名匹配或导出任何会话，插件会跳过导出并报告），存在 `sessionProjectionCache`（可选注入）时导入完成即预热投影缓存，同时设置页用它零 I/O 地读出会话标题。

## 配置项

配置就是 profile 里 `session-sync` 这一行的 Cordis Config：所有用户可改字段都是「活引用」（`.volatile()`），harness 把每次设置写入提交进这些引用并持久化到 profile patch 文档。字段表：

| 字段 | 含义 |
|---|---|
| `startupSyncDelayMs` | 启动后到首次自动周期的延迟（毫秒，默认 3000）。部署项：它不在设置页里。 |
| `enabled` | 总开关；开启时 `remote` 必填。关闭时会话行菜单项不显示。 |
| `remote` | Git 远端地址（SSH）。凭据来自 `~/.ssh`。 |
| `branch` | 同步分支；默认 `main`。 |
| `intervalMinutes` | 自动同步间隔（分钟，最小 1，默认 5）。 |
| `cleanup` | `{ enabled, periodHours, keepCommits }`：定期 git 空间清理开关、清理周期（小时，最小 1，默认 24）、保留的最近提交数量（最小 1，默认 200）。 |

**同步集合不是配置项**，它是数据：设置在设置页里只读展示，写入入口只有会话行菜单（以及设置页行尾的「关闭同步」）。

节奏：启动 `startupSyncDelayMs` 后一个自动周期，之后每 `intervalMinutes` 一次。**用户点「同步会话」会立刻触发一个周期**（单飞守卫），所以本机是即时的，对端看到它取决于对端的 `intervalMinutes`。清理在每次成功周期之后检查一次到期，外加设置页的立即清理按钮。

## 待匹配工作区

导入前先按名匹配。落不进去的会话不会消失，它们留在仓库里，并在设置页的「待匹配工作区」区列出（含该工作区下等待的会话数）。让它们落位的唯一动作是：**在本机用侧栏「添加工作区」建一个标题完全相同的工作区**，下一个周期会自动匹配并导入。改了名的工作区不会自动适配——这是刻意的，猜错位置会让会话永久挂错工作区。

## 安全姿态

- 插件不存储任何凭据：git 远端是你的 SSH 地址，key 在 `~/.ssh`。
- 机器路径永不进入仓库（导出时改写为工作区 key）。
- 写路由强制同源校验；状态与设置读取无副作用。
- 插件自己的 git 提交使用固定身份 `dsh-session-sync <dsh-session-sync@localhost>`。

## 开发

```sh
pnpm install
pnpm test        # engine、format、selection、git、log、settings、service、routes、组合、配置写入、UI
pnpm typecheck
pnpm build       # 两个包的 tsc + 浏览器 bundle（lib/client.js）
```

设计与实现契约见 [`docs/spec/session-sync-v2.md`](docs/spec/session-sync-v2.md)。

### 关于第三方测试环境

已发布的 harness 客户端包只以浏览器 bundle 形式提供其 `/client` 运行时面（它们经 harness 模块表加载），第三方包无法在 Node 测试里导入 `SlotRegistry`、`createSnapshotStore` 或测试运行时。因此本仓库：

- 把小型快照存储引擎 vendor 进 `packages/session-sync/src/client/store.ts`（裁剪自 harness 的 MIT 源码并注明出处），并且
- 在 `packages/session-sync/tests/helpers.ts` 中用最小假件测试 slot 注册、locale 与 remote 失效路径。

真实 slot 核心行为由 harness 侧集成覆盖。

## 常见问题

- **刚发版后 `dsh plugin add` 报 404。** 全新版本在 registry 读路径上需要几分钟才可见。稍后重试即可；不要重复发布。
- **通过镜像安装报 `ERR_PNPM_FETCH_404`。** 给命令加 `--registry=https://registry.npmjs.org`，或等镜像同步。
- **pnpm 拒绝或询问刚发布的版本。** 这是 pnpm 的 `minimumReleaseAge` 延迟保护。放行该包或等过这个时间窗口。
- **Web GUI 起不来、或设置页里没有「同步」。** 浏览器半侧靠 harness 的模块表索引，索引键是**包名**，不是短名。确认两行都在：

  ```sh
  dsh --profile web-sync --dump-config | grep -A 2 -e session-sync -e ui-settings-sync
  ```

  Host 半侧与同步引擎此时可能完全正常，所以 `--dump-config` 看着没问题**不能**证明浏览器半侧已加载——唯一可靠的判据是浏览器控制台无错误、且设置页出现「同步」。
- **会话行菜单里没有「同步会话」。** 三种情况：总开关没开或没填远端；该会话不属于任何工作区；本机不持有该会话。设置页的集合树能看到集合本身。
- **另一台电脑上看不到某个会话。** 先看设置页的「待匹配工作区」：多半是那台机器没有同名工作区。在那里建一个同名工作区即可。
- **同步周期报 SSH 错误。** 插件用 `StrictHostKeyChecking=accept-new`，首次连接新主机仍需要你的 key 可用（先试 `ssh -T git@<host>`）。瞬时损坏由指数退避重试吸收；持续失败请看设置页的同步日志面板。
- **在一台电脑归档后，另一台仍能看到该会话。** 归档标记是只增并集，需要一次成功周期才会传播。确认两端都完成了至少一个周期。

## 已知限制

- 状态刷新为轮询（页脚每 60 秒 + 每次操作后 + 菜单打开时定向刷新）；harness 内的事件推送路径需要核心权限，故刻意不用。
- 设置改动由 harness 推送到已打开的设置页（config form 订阅 + `settings/document-updated`），无需刷新。
- 仅支持 SSH 远端；HTTPS + token 未实现。
- **重命名工作区不适配。** 任一方改名，名称就对不上，那些会话进入待匹配；仓库侧的 key 不变，产物不会搬动。
- **本机有多个同名工作区时不自动匹配。** 会留在待匹配里，需要你自行消除歧义（harness 允许不同路径共用同一显示标题）。
- 投影预热是 fail-soft 的：某次预热失败时该行暂时退回工作区名显示，点开会话或以后再次导入时会刷新。
- 冲突副本需要手动处理；页面只显示数量与最近一次记录。
- 共享归档标记是只增并集：要让取消归档传播，需要在每个工作区的 `archived.json` 里加入墓碑记录（并升格式版本），本版本未实现。无论哪种情况，归档内容都无法从仓库恢复：标记落地时会话文件即被删除。
- 清理是历史重写：本地与远端的历史提交被丢弃（最新树保留）。若多台电脑几乎同时清理，`--force-with-lease` 会让后到者的强推失败并在下一周期重试，不会静默覆盖别人的新提交。
- 一个会话的同步记录上限 20 条（按时间保留最新），超出后最旧的记录不再显示。
- 若 harness 上游未来把会话同步并入核心 RPC，可以换回 RPC 原生变体，引擎无需改动。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

`packages/session-sync/src/client/store.ts` 中的快照存储引擎裁剪自采用 MIT 许可证的 DeepSeek Harness；浏览器 bundle（`lib/client.js`）在构建期内联了同样采用 MIT 许可证的 zustand、immer 与 clsx。上述上游版权声明与许可证文本见 [NOTICE](NOTICE)。
