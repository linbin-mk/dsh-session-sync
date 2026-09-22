[English](https://github.com/linbin-mk/dsh-session-sync/blob/main/README.en.md) | 简体中文

# dsh-session-sync

[![npm 版本](https://img.shields.io/npm/v/@linbin-mk/dsh-session-sync)](https://www.npmjs.com/package/@linbin-mk/dsh-session-sync)
[![发布流水线](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml/badge.svg)](https://github.com/linbin-mk/dsh-session-sync/actions/workflows/publish.yml)
[![许可证](https://img.shields.io/npm/l/@linbin-mk/dsh-session-sync)](LICENSE)
[![Node](https://img.shields.io/node/v/@linbin-mk/dsh-session-sync)](package.json)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的第三方会话同步插件：通过一个 git 仓库，在多台电脑之间同步你已映射项目的会话，并自带 Web 设置页。

```
┌───────────── 电脑 A ─────────────┐      ┌───────────── 电脑 B ─────────────┐
│ DSH host ── session-sync 插件 ───┼─git──┼─── session-sync 插件 ── DSH host ─│
│   └─ /session-sync/*（自建 HTTP API）│    │   └─ /session-sync/*（自建 HTTP API）│
│ 浏览器 UI ── fetch（同源）        │      │ 浏览器 UI ── fetch（同源）        │
└─────────────────────────────────┘      └─────────────────────────────────┘
```

- **会话跟着你走，机器路径不跟。** 已映射项目的逻辑事件日志导出为 `projects/<key>/<id>.jsonl`；插件自有的版本化文件头记录可移植项目 key 与 fork 继承事件数，不复制 harness JSONL 后端的私有文件、压缩或行编码。导入时项目 key 解析成本机映射路径。
- **映射是双向白名单。** 只有映射过的项目会被上传；仓库里未映射项目的会话永远不会落入 DSH。
- **冲突策略：前缀合并 + 双副本。** 会话日志是只追加的事件流：一份日志是另一份的严格前缀时，更长者胜出；真正分叉时，远端尾巴原样保留在 `conflicts/<key>/<id>-<host>.jsonl` 并上报——数据绝不静默丢失。分叉时的导出永远不会覆盖仓库工件：仓库保留自己已有的一份稳定日志（互相覆盖会让它每个周期被毁掉），分叉的本地尾巴只进入冲突副本。
- **未闭合 turn 不出网。** 没有以 `turn/end` 收尾的日志，要么正在所属电脑上实时运行，要么是崩溃后等待 harness 的「中断修复」。把它导出等于发布一个截断快照：导入方加载后会被 harness 补上合成的 `step/end` + `turn/end {interrupted}` 修复尾巴，从此与本机的真实后续内容永久分叉。因此导出跳过未闭合 turn 的日志（闭合后下一周期自然推送），导入也跳过未闭合 turn 的工件（旧版本插件留下的过期快照，所属电脑会用闭合日志替换它）。
- **归档标记跟着走，归档内容退出 git。** 在一台电脑上归档的会话，通过 `projects/<key>/archived.json` 里的标记在每台电脑的会话列表中都隐藏，同时它位于 git 仓库里的 `projects/<key>/<id>.jsonl` 会在下一次同步时被删除——归档会话不再占用 git 空间。本机会话数据不受影响，只有只增标记继续传播，因此仓库里的标记只是简单并集，永远不会产生冲突。
- **导入即预热投影缓存。** 同步导入直接写持久化、绕过 live 会话存储，harness 的投影缓存不会自动折叠它；插件在每次导入后对会话做一次冷读预热（fail-soft），标题、子代理分组等列表行元数据立即可见，无需先点开会话。
- **切换电脑后的首次续聊注入一次提醒。** 每当导入给某个会话带来来自其他电脑的新事件，插件就为它武装一个一次性标记（持久化在 harness home 下，重启不丢）。该会话的用户首次发消息时——经 harness 的 `agent/pre-step` 缝检测，与 AGENTS.md 加载器同一条注入路径——一条插件 `notice` 消息会紧跟在用户消息之后折入上下文，告知大模型：本会话历史是从另一台电脑同步而来的，历史路径可能与当前电脑不符，此后一律以当前工作目录为准。标记注入即消耗：同一台电脑继续聊天不会重复注入；提醒本身是持久事件、随日志一起同步，下次再换机器时那边首次续聊会注入自己的提醒。子代理会话除外。
- **仓库只是传输介质。** 每个周期执行 fetch → 硬重置 → 导入 → 导出 → 提交 → 推送，git 合并冲突无从产生。远程命令（`ls-remote`、`fetch`、`push`）自带指数退避重试（默认最多 3 次尝试），一次瞬时的 SSH 连接损坏（如 `Bad packet length`）不再让整个周期报废；分支探测每个周期只做一次，`resetHard` 复用 fetch 的结果而不是再次探测远端。
- **定期清理 git 空间。** git 不会遗忘已删除的文件：归档删除只影响 HEAD，历史里的每个旧版本永远留在对象库里。清理功能按周期（小时）把共享历史重写到只保留最近 N 次提交（默认 200）并强推（`--force-with-lease`），被截断的提交连同它们的 blob 一起退出仓库；重放保留提交时最新树原样保留——当前所有文件一个不少，其他电脑在下一个周期自动按重写后的历史重新同步。清理在每个同步周期之后检查一次到期（同步节奏即检查粒度），设置页还有「立即清理」按钮。远端托管服务自身的对象库回收（服务端的 GC）不在客户端控制范围内。
- **同步日志保留 3 天。** 每个周期在 harness home 的 `session-sync/logs/sync-YYYY-MM-DD.jsonl` 里追加开始/成功/失败记录（含计数、冲突副本、错误与耗时），读取和写入时自动清理超出 3 天窗口的日志文件；设置页的折叠面板展示最近记录，状态行里的失败信息带上自己的发生时间，与上次成功的统计区分开。
- **自带 Web 界面。** 设置页（总开关、SSH 仓库地址、分支、同步间隔、git 空间清理、项目映射、立即同步/立即清理）+ 侧栏同步状态点。

## 为什么这个插件不需要改 harness 核心代码

harness 的 RPC 表（`apiproxy`）是编译器锁死的静态注册表——第三方包无法往里添加 `sessionSync.*` 方法。本插件改在 harness **开放的 `webServer` 路由缝**上注册自己的同源 HTTP API：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/session-sync/status` | GET | 只读同步状态视图 |
| `/session-sync/sync-now` | POST | 立即执行一个同步周期并返回最新状态 |
| `/session-sync/cleanup-now` | POST | 立即执行一次 git 空间清理并返回最新状态 |
| `/session-sync/settings` | GET | 设置视图（`writable` + 配置段） |
| `/session-sync/settings` | POST | 合并一个 patch 到设置段（host 校验） |
| `/session-sync/logs` | GET | 最近同步日志（保留窗口内，新的在前，`?limit=` 上限 500） |

浏览器端用普通 `fetch` 调用这些路由。写路由拒绝跨源请求（`Origin` 头必须指向本服务器自身 host）和畸形请求体；设置服务对每次合并做重新校验。UI 唯一还在用 harness 通用接口的是工作区列表（`workspace.list`）——那是标准且未改动的面。

## 仓库结构

```
packages/session-sync/             @linbin-mk/dsh-session-sync（host 插件）
packages/client-ui-settings-sync/  @linbin-mk/dsh-client-ui-settings-sync（浏览器插件）
```

host 包包含同步引擎（`engine.ts`、`format.ts`、`git.ts`、`settings.ts`）、服务（`index.ts`）与 HTTP 层（`api.ts`、`routes.ts`）。浏览器包含设置页、状态页脚、页面控制器与 fetch 客户端。

## 环境要求

- Node.js `^22.19 || >=24`
- DeepSeek Harness `0.1.5-rc.1`（所有 `@deepseek-ai/*` 依赖均使用 npm 发布版本，不含本机 harness 链接）
- PATH 中有 `git`，且同步远端需要 SSH key（host key 策略：`StrictHostKeyChecking=accept-new`）
- 只有从源码构建时才需要 pnpm

此版本改用插件自有的逻辑事件工件格式，并且有意不导入旧版 raw-storage 实现生成的工件。连接其他电脑前，请使用空同步仓库（或先清空旧仓库内容）。

## 安装

把两个已发布的包装进自定义 Web profile。两个包各自声明 `dsh.bundle` patch，Host 行与 Client 行会自动加入：

```sh
dsh --profile web-sync --from-default-profile web --dump-config
dsh plugin --profile web-sync add \
  @linbin-mk/dsh-session-sync \
  @linbin-mk/dsh-client-ui-settings-sync
dsh --profile web-sync
```

改为安装本地构建的 tarball：

```sh
cd dsh-session-sync
pnpm install && pnpm build
pnpm --dir packages/session-sync pack
pnpm --dir packages/client-ui-settings-sync pack

dsh plugin --profile web-sync add \
  ./linbin-mk-dsh-session-sync-0.1.3.tgz \
  ./linbin-mk-dsh-client-ui-settings-sync-0.1.3.tgz
```

从同一个 profile 移除：

```sh
dsh plugin --profile web-sync remove \
  @linbin-mk/dsh-session-sync \
  @linbin-mk/dsh-client-ui-settings-sync
```

## 组合配置

```yaml
- id: session-sync
  name: '@linbin-mk/dsh-session-sync'
  config:
    startupSyncDelayMs: 3000

# 在你的 web bundle 的浏览器插件列表中：
- id: ui-settings-sync
  name: '@linbin-mk/dsh-client-ui-settings-sync'
```

安装会自动加入上面的两行。host 插件要求 `settings` 与 `sessionPersistence` 服务；存在 `workspaceRegistry` 时，导入的会话会挂到工作区，并把仓库里的归档标记应用到本机的归档集合；存在 `sessionProjectionCache`（可选注入）时，导入完成即预热投影缓存，让列表行立刻带出标题等投影值。浏览器插件注册 `settings.section`（`sync`）设置页与 `sidebar.footer.action`（`session-sync-status`）状态点。

## 配置项

`session-sync` 设置命名空间：

| 字段 | 含义 |
|---|---|
| `enabled` | 总开关；开启时 `remote` 必填。 |
| `remote` | Git 远端地址（SSH）。凭据来自 `~/.ssh`。 |
| `branch` | 同步分支；默认 `main`。 |
| `intervalMinutes` | 自动同步间隔（分钟，最小 1，默认 5）。 |
| `mappings` | `[{ key, path }]`：可移植项目 key 与本机目录。 |
| `cleanup` | `{ enabled, periodHours, keepCommits }`：定期 git 空间清理开关、清理周期（小时，最小 1，默认 24）、保留的最近提交数量（最小 1，默认 200）。 |

节奏：启动 `startupSyncDelayMs` 后一个自动周期，之后每 `intervalMinutes` 一次，外加手动按钮；所有入口共用单飞守卫。清理在每次成功周期之后检查一次到期，外加设置页的立即清理按钮；清理与同步共用同一个工作树，通过各自的单飞守卫串行化。

## 安全姿态

- 插件不存储任何凭据：git 远端是你的 SSH 地址，key 在 `~/.ssh`。
- 机器路径永不进入仓库（导出时改写为可移植 key）。
- 写路由强制同源校验；状态与设置读取无副作用。
- 插件自己的 git 提交使用固定身份 `dsh-session-sync <dsh-session-sync@localhost>`。

## 开发

```sh
pnpm install
pnpm test        # 184 个测试：engine、format、git、log、settings、service、routes、组合、UI
pnpm typecheck
pnpm build       # 两个包的 tsc + 浏览器 bundle（lib/client.js）
```

### 关于第三方测试环境

已发布的 harness 客户端包只以浏览器 bundle 形式提供其 `/client` 运行时面（它们经 harness 模块表加载），第三方包无法在 Node 测试里导入 `SlotRegistry`、`createSnapshotStore` 或测试运行时。因此本仓库：

- 把小型快照存储引擎 vendor 进 `packages/client-ui-settings-sync/src/client/store.ts`（裁剪自 harness 的 MIT 源码并注明出处），并且
- 在 `packages/client-ui-settings-sync/tests/helpers.ts` 中用最小假件测试 slot 注册、locale 与 remote 失效路径。

真实 slot 核心行为由 harness 侧集成覆盖。

## 常见问题

- **刚发版后 `dsh plugin add` 报 404。** 全新版本在 registry 读路径上需要几分钟才可见，`dist-tags` 与 tarball 通常会先可用。稍后重试即可；不要重复发布——版本已存在，第二次必然冲突。
- **通过镜像安装报 `ERR_PNPM_FETCH_404`。** npmmirror 等镜像同步新版本有自己的节奏。给命令加 `--registry=https://registry.npmjs.org`，或等镜像同步。
- **pnpm 拒绝或询问刚发布的版本。** 这是 pnpm 的 `minimumReleaseAge` 延迟保护。放行该包或等过这个时间窗口。
- **Web GUI 起不来、或设置页里没有「同步」。** 浏览器半侧靠 harness 的模块表索引，索引键是**包名**，不是短名。确认两行都在：

  ```sh
  dsh --profile web-sync --dump-config | grep -A 2 -e session-sync -e ui-settings-sync
  ```

  Host 半侧与同步引擎此时可能完全正常，所以 `--dump-config` 看着没问题**不能**证明浏览器半侧已加载——唯一可靠的判据是浏览器控制台无错误、且设置页出现「同步」。
- **同步周期报 SSH 错误。** 插件用 `StrictHostKeyChecking=accept-new`，首次连接新主机仍需要你的 key 可用（先试 `ssh -T git@<host>`）。瞬时损坏（如 `Bad packet length`）由指数退避重试吸收；持续失败请看设置页的同步日志面板。
- **在一台电脑归档后，另一台仍能看到该会话。** 归档标记是只增并集，需要一次成功周期才会传播。确认两端都完成了至少一个周期。
- **导入的会话列表行只显示项目名、没有标题。** 投影预热是 fail-soft 的：那次预热失败时该行退回项目名，点开会话或下次导入即刷新。

## 已知限制

- 状态刷新为轮询（页脚每 60 秒 + 每次操作后）；harness 内的事件推送路径需要核心权限，故刻意不用。
- 直接编辑设置文件后，下次页面加载才会生效，不做实时推送。
- 仅支持 SSH 远端；HTTPS + token 未实现。
- 投影预热是 fail-soft 的：某次预热失败（如持久化读异常）时该行暂时退回项目名显示，点开会话或以后再次导入时会刷新。
- 冲突副本需要手动处理；页面只显示数量。
- harness 的归档集合目前没有取消归档（unarchive）路径，因此归档是单向的（只增并集）：一旦在任何一台电脑归档，会话在所有电脑上都保持隐藏，且其仓库内的会话文件会被删除、不再同步。上游加入取消归档后，归档列表格式需要引入墓碑记录，且被删除的会话内容已无法从仓库恢复。
- 清理是历史重写：本地与远端的历史提交被丢弃（最新树保留）。远端托管服务自身的对象库 GC（决定服务端占用何时回落）不在客户端控制范围内；若多台电脑几乎同时清理，`--force-with-lease` 会让后到者的强推失败并在下一周期重试，不会静默覆盖别人的新提交。
- 若 harness 上游未来把会话同步并入核心 RPC，可以换回 RPC 原生变体，引擎无需改动。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

`packages/client-ui-settings-sync/src/client/store.ts` 中的快照存储引擎裁剪自采用 MIT 许可证的 DeepSeek Harness；浏览器 bundle（`lib/client.js`）在构建期内联了同样采用 MIT 许可证的 zustand、immer 与 clsx。上述上游版权声明与许可证文本见 [NOTICE](NOTICE)。
