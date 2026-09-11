# DSH 接入能力验证结论

> M1 阶段（接入原型）的实测报告，对应 `docs/开发规划.md` 第 4 节 INT-01 ~ INT-06。
> 本文只记录**已实测**的事实。未测的内容一律标注"未验证"，不做推测。
> 每条结论都标注了证据来源：`web` = 用户在 Web UI 手动触发，`headless` = 一次性任务自动触发，`源码` = 官方仓库代码。

## 1. 测试环境

| 项目 | 值 |
|---|---|
| 宿主 | 官方 npm 包 `@deepseek-ai/dsh`，版本 `0.1.5-rc.1`（2026-09-10 发布） |
| 启动方式 | `npx @deepseek-ai/dsh --profile web\|headless --patch <overlay> ...` |
| 参考源码 | `reference/deepseek-harness` @ `c291e7961a515f6d7af9304e7fd1d257929aef26`（版本 `0.1.5-rc.2`） |
| 操作系统 | Windows |
| Node | v22.22.2 |
| 探针插件 | `src/host/studio-probe.mjs`，经 `src/host/cordis.yml` 覆盖层挂载 |
| 测试日期 | 2026-09-11 |

**版本差异提示：** npm 上的 `0.1.5-rc.1` 与源码 master 的 `0.1.5-rc.2` 相差一个 RC，已确认在 CLI 参数上存在差异（见 §5.1）。后续结论应绑定具体版本复核。

## 2. 结论摘要

| 能力 | 状态 | 依据 |
|---|---|---|
| 本地插件加载进官方宿主 | ✅ 可用 | `web` + `headless` 两种 profile 均加载成功 |
| 抓取调用开始 / 结束 / 耗时 | ✅ 可用 | 共 12 次真实调用，毫秒级耗时 |
| 区分成功与失败 | ✅ 可用（有条件） | `isError` 可得，但**必须从返回值判断，不能靠异常**（见 §4.3） |
| 会话身份 | ✅ 可用 | `session.id` 稳定可读 |
| 真实并发计数 | ✅ 可用 | 实测并发达 4，按会话分桶后计数正确 |
| 子代理活动识别 | ✅ 可用 | 子代理开启独立会话，可区分（见 §4.5） |
| 结果元数据 | ✅ 可用 | `result.meta` 按工具类型给出结构化字段 |
| **调用取消** | ✅ **可用** | 两种形态实测：进入时已中止 + 执行中取消，均以结果返回而非抛异常（见 §4.8） |
| PTC / `run_code` 的 parent 父子关联 | ⚠️ 未验证 | 子代理场景下 `hasParent` 恒为 `false` |
| **插件名册**（已安装插件列表） | ✅ **可用** | `ctx.loader.entries()` 实测 89 条，含条目 id、模块标识、存活阶段、禁用表达式 |
| **工具名册** | ✅ **可用** | `ctx.tools.schemas()` 实测 25 个工具 |
| 工具 → 插件**精确**运行时归属 | ❌ 不可得 | 注册表无 owner、schema 无归属、fiber 不可枚举、补丁无排序、无注册观察扩展点（见 §4.6.3） |
| 工具 → 插件**映射依据** | ✅ 有官方生成依据 | 官方生成式工具目录 `docs/tool-catalog.zh.md`，对本次 25 个工具 **100% 覆盖**（见 §4.6.4） |
| **插件卸载清理** | ✅ **可用** | 实测卸载 fiber 后，`tools/execute` 包装层与自定义监听器**全部消失**（见 §4.7） |
| **Web UI 面板挂载点** | ✅ **可用** | 四个官方 slot 全部注册成功并实际渲染，选项形式为 `{name, id}`（见 §4.9） |
| 客户端 bundle 热重载 | ✅ **可用** | 编辑后 rev 自动由 nonce 变为内容哈希，旧 rev 立即 404（见 §4.9.4） |
| **插件 3D 资源送达浏览器** | ✅ **已解决** | 走 `workspaceFiles` Remote 服务，13.20 MB 大文件实测可读、magic 校验通过（见 §4.9.3） |

## 3. 三个可用的接入点

### 3.1 `tools/execute` —— 调用生命周期与耗时（推荐主数据源）

```ts
'tools/execute'(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
```

实测输出：

```json
{"kind":"call-start","callId":"call_00_...","name":"read","session":"session-...","hasParent":false,
 "rootCallId":"call_00_...","concurrent":1,"argumentsPreview":"{\"file_path\":\"...\"}"}
{"kind":"call-end","callId":"call_00_...","name":"read","session":"session-...",
 "ok":true,"isError":false,"durationMs":14,"concurrentAfter":3}
```

- 开始与结束在**同一词法生命周期**内，耗时可靠，无需跨事件配对。
- 约束：包装层必须 `await next()` 并**原样返回**；抛错必须原样 `throw`。可视化逻辑不得改变执行结果。

### 3.2 `tools/result` —— 不可变权威结果

```ts
'tools/result'(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

实测：带 `callId`，可与 `tools/execute` 精确配对。`meta` 按工具类型变化：

| 工具 | `meta` 字段 |
|---|---|
| `glob` | `shape`, `paths`, `truncated`, `total` |
| `read` | `path`, `offset`, `lines`, `totalLines`，`lang`（按扩展名条件出现） |
| `pwsh` | 无 |
| `subagent` | 无 |

信息面板可直接复用这些展示元数据，不必解析工具原始输出。

### 3.3 `session/event` —— 持久可回放事实

信封（实测）：`{ type, seq, time, data }`，部分事件另有 `sourceEventSeqs`、`surfaceOp`。

| 事件 | `data` 字段 |
|---|---|
| `tool/call` | `turn`, `step`, `callId`, `name`, `arguments` |
| `tool/result`（成功） | `turn`, `step`, `message`, `meta?` |
| `tool/result`（失败） | `turn`, `step`, `message`, `error` |
| `turn/start` | `turn` |
| `turn/end` | `turn`, `reason` |
| 其他（本次观测到） | `permission/preset`、`sandbox/mode`、`approval/policy`、`agent/inbox/spliced`、`step/start`、`step/end`、`system/message`、`user/message`、`assistant/message`、`request/header`、`request/context`、`session/title`、`session/title-llm-request`、`subagent/catalog`、`subagent/descriptor` |

## 4. 关键发现

### 4.1 ⚠️ `tool/result` 会话事件里没有 `callId`

最重要的一条，**推翻了原设计里"用 session/event 单一数据源重建调用记录"的假设**。

- `tool/call` 带 `callId`
- `tool/result` 的 data 只有 `turn` / `step` / `message` / `meta` / `error`，**不含 callId**

同一步内可能有多次调用（实测 step 1 出现过 2 次、4 次），按 `turn` + `step` 匹配必然歧义。

**决定：** 调用记录的权威来源采用 **`tools/execute` + `tools/result`**（都带 `callId`，可精确配对）。`session/event` 退为**会话身份、轮次边界与持久回放**的补充来源。

### 4.2 事件到达顺序稳定

```
session/event tool/call  →  tools/execute 开始  →  tools/execute 结束  →  tools/result  →  session/event tool/result
      (seq 26)                  (+2ms)               (调用耗时)            (+1ms)            (+1ms, seq 27)
```

副作用（已利用）：`tool/call` 比 `tools/execute` 早到，因此可以在 `tools/execute` 里用 `callId` 反查会话 id。

### 4.3 ⚠️ 工具失败**不抛异常**，靠返回值表达

实测一次读取不存在文件的调用：

```
call-end  → {"name":"read","ok":true,"isError":false,"durationMs":8}   ← 如果用 try/catch 判断
result    → {"name":"read","isError":true,"errorMessage":"cannot read \"L:\\__probe_not_exist__.txt\": not found"}
```

`await next()` **正常 resolve**，失败信息在返回值的 `isError` / `error.message` 里。只有真正的异常（取消、崩溃）才会 throw。

**影响：** 只靠 `tools/execute` 的 try/catch 判断成败是错的，**必须检查 `result.isError`**。若照旧实现，3D 场景会把所有失败显示成成功——这正是产品文档"风险一：沦为视觉玩具"的典型触发路径。

### 4.4 并发由**工具执行模式**决定，不由"是否同一步"决定

**反例（串行）** `web`：同一步（step 1）内两次 `glob`，串行执行，第二次在第一次结束 4ms 后启动，`concurrent` 恒为 1。

**正例（并行）** `headless`：同一步内 4 次 `read`，真实并行：

| 调用 | 开始 | 结束 | 耗时 |
|---|---|---|---|
| `read(README.md)` | 行 2 | 行 1 | 14 ms |
| `read(package.json)` | 行 1 | 行 2 | 17 ms |
| `read(开发规划.md)` | 行 3 | 行 3 | 26 ms |
| `read(manifest.json)` | 行 4 | 行 4 | 39 ms |

并发计数实测序列：`1 → 2 → 3 → 4 → 3 → 2 → 1 → 0`。**结束顺序与开始顺序不同，证明确实并行。**

官方工具文档亦印证：执行模式形成 exclusive barrier 与 rolling-pool 并行运行。

**对 3D 工作室的含义：** 活动强度必须由**真实并发计数**驱动，不能假定"同一步即同时工作"。本次 4 次 `read` 应表现为 4 个员工同时忙碌；而两次 `glob` 应表现为**依次忙碌**。

### 4.5 子代理 = 独立会话，不是 parent/child token

实测用 `subagent` 工具派子代理：

```
父会话 session-f3dddb39-…   call-start subagent          concurrent:1
父会话 session-f3dddb39-…   （subagent 在飞）
子会话 1568c48c-…           session-opened (agent/inbox/spliced)
子会话 1568c48c-…           call-start read               concurrent:1
子会话 1568c48c-…           call-end   read               concurrentAfter:0
父会话 session-f3dddb39-…   call-end   subagent 2132ms     concurrentAfter:0
```

三个要点：

1. **子代理开启独立会话**，`session.id` 不同。子会话 id 实测**不带 `session-` 前缀**（父会话带），不要假设前缀。
2. **子代理内部的调用 `hasParent` 仍为 `false`**，`rootCallId` 等于自身。所以"嵌套"在本场景下**不是 parent token 关系**，而是**跨会话**关系。
3. 因此 **`inFlight` 必须按会话分桶**。首版探针用单一全局 Map，把父会话的 `subagent` 与子会话的 `read` 混算成 `concurrent:2`；改为按会话分桶后正确显示为两个会话各 1。

**对产品文档的修正：** "嵌套调用"有两种完全不同的形态——(a) 子代理 = **独立会话**；(b) PTC 模式 transport 子分发 = **parent token**。二者必须区别对待。规划第 30.5 节"避免跨会话串线"在此得到实证。

### 4.6 工具 → 插件归属：名册可得，精确归属不可得（最高风险项）

产品文档标注的最高技术风险。已用**实测 + 源码**双重确认，结论分三层。

#### 4.6.1 ✅ 插件名册：权威可得

`ctx.loader.entries()` 实测返回 **89 个条目**，每条含：

```json
{"entryId":"tool-fs-search","moduleName":"@deepseek-ai/dsh-tool-fs-search","fiberState":2,"disabled":null}
{"entryId":"tool-bash","moduleName":"@deepseek-ai/dsh-tool-bash","fiberState":null,
 "disabled":{"__jsExpr":"process.platform === 'win32'"}}
{"entryId":"studio-probe","moduleName":"file:///L:/Toolfolk%20for%20DSH/src/host/studio-probe.mjs","fiberState":2,"disabled":null}
```

- `entryId` = `cordis.yml` 里的条目 id，即**插件身份**
- `moduleName` = 精确模块标识（本地插件是 `file://` URL）
- `fiberState` = 存活阶段；`null` 表示无存活根 fiber
- `disabled` = 行自带的 `!!js` 禁用表达式原文（如 **win32 上 `tool-bash` 被禁用、`tool-pwsh` 启用**）

这正是产品文档要求的"**已安装插件列表**"，与工具列表是两件事，现已分别可取得（文档 30.4 要求二者分开处理）。

#### 4.6.2 ✅ 工具名册：可得（需声明 inject）

`ctx.tools.schemas()` 实测返回 **25 个工具**：

```
skill, job_output, job_list, job_kill, web_search, web_fetch, exit_plan_mode,
todo_write, send_message, interrupt_agent, list_agents, get_goal, create_goal,
update_goal, glob, grep, read, write, edit, workflow, ralph, subagent,
subagent_fork, read_image, pwsh
```

**前置条件（踩过）**：不声明 `export const inject = ['tools']` 就访问 `ctx.tools` 会得到
`cannot get property "tools" without inject`。

工具 schema 的字段只有 `name / description / parameters` —— **没有归属字段**。

#### 4.6.3 ❌ 运行时精确归属：四条路都验证过，走不通

| 路径 | 结果 |
|---|---|
| 工具注册表 | `register()` 只执行 `layer.tools.insert(name, definition)`，按 **agent 作用域**分层，**无 owner/plugin 字段** |
| 工具 schema | 实测字段仅 `name / description / parameters`，无归属 |
| Fiber 内省 | `Fiber` 原型链暴露 `parent / inject / runtime / uid / ctx / config / state / dispose / store / inertia / _hooks / _disposables / context / _error / _runner / _store / entry`——**全部为私有或与工具身份无关**；且注册产生的 effect 标签统一是 `tools.register()`，**不携带工具名** |
| 补丁排序 | `PatchOptions` 权威类型只有 `id / insert / name / config / group / disabled / inject / intercept / isolate`，**没有 `before` / `after` / 任何排序字段**。且插件并行加载（`Promise.allSettled`），"列表靠前"不等于"更早注册"——排序本身也解决不了问题 |

**另外确认：工具服务的官方扩展点只有五个**——`tools/pre-execute`、`ctx.tools.guard()`、`tools/execute`、`tools/post-execute`、`tools/result`。**不存在注册观察扩展点。**

结论：**在官方支持的机制下，运行时无法直接查得"这个工具属于哪个插件"。**

#### 4.6.4 ✅ 出路：官方**生成式**工具目录（不是猜名字）

`reference/deepseek-harness/docs/tool-catalog.zh.md` 有一张官方的「**工具包映射**」表，把模型可见工具名与背后的插件包对应起来。

**这张表不是靠命名约定猜的。** 官方文档明确说明：生成器 `scripts/gen-tool-catalog.ts` 会在真实上下文中**启动每个工具插件并读取 `ctx.tools.schemas()`**，因为工具 schema 无法通过静态分析完全确定（运行时展开的枚举、拼接的描述、配置决定的名称、原始 JSON Schema 的 MCP 工具）。完整性由 `verify-tool-catalog` 守卫，跑在 `doc-sync` 门禁里。

**本次实测注册的 25 个工具与官方目录的对应关系——100% 覆盖，零猜测：**

| 工具包（官方目录） | 本机实测注册的工具名 |
|---|---|
| `@deepseek-ai/dsh-tool-fs` | `read`、`write`、`edit`、`read_image` |
| `@deepseek-ai/dsh-tool-fs-search` | `glob`、`grep` |
| `@deepseek-ai/dsh-tool-pwsh` | `pwsh` |
| `@deepseek-ai/dsh-tool-goal` | `create_goal`、`get_goal`、`update_goal` |
| `@deepseek-ai/dsh-plan-mode` | `exit_plan_mode` |
| `@deepseek-ai/dsh-tool-jobs` | `job_list`、`job_output`、`job_kill` |
| `@deepseek-ai/dsh-tool-skill` | `skill` |
| `@deepseek-ai/dsh-tool-subagent` | `subagent`、`subagent_fork`（别名） |
| `@deepseek-ai/dsh-tool-subagent-control` | `interrupt_agent`、`list_agents`、`send_message` |
| `@deepseek-ai/dsh-tool-todo` | `todo_write` |
| `@deepseek-ai/dsh-tool-workflow` | `workflow` |
| `@deepseek-ai/dsh-tool-ralph` | `ralph` |
| `@deepseek-ai/dsh-tool-web` | `web_search`、`web_fetch` |

**三条必须遵守的官方约束**（直接决定实现方式）：

1. **工具注册名可以是加载时配置的**。例如 `tool-subagent` 的名称由加载时 `toolName` 决定（默认 `subagent`），`subagent_fork` 是随产品发布的别名。**因此映射表必须在运行时与实际注册名求交，不能硬编码。**
2. 目录反映的是**默认配置**；部署可能以不同名称或额外名称提供某个包。
3. 目录只覆盖 `packages/*/tool-*` 下随产品发布的工具，`examples/` 里的演示工具不在范围内。

#### 4.6.5 决定：三层求交，缺失即诚实报告

```
插件名册（ctx.loader.entries()）        ← 权威：装了哪些插件
        ∩
工具名册（ctx.tools.schemas()）         ← 权威：当前注册了哪些工具
        ∩
官方工具包映射（tool-catalog 生成产物）  ← 权威：工具名 ↔ 插件包
        ↓
      员工归属
```

1. **员工 = 插件条目**，身份与工位由 `entryId` / `moduleName` 生成。
2. **工具 → 员工**用官方工具包映射求交，**不是名称推测**。映射表按 DSH 版本随包交付，启动时与运行时实际注册名校验。
3. **三层任一缺失即报"未归属"**，并注明缺在哪一环（工具未注册 / 包未安装 / 不在官方目录中）——不猜、不伪装。这是产品文档 30.4 的硬要求，也是"风险一：沦为视觉玩具"的防线。
4. **基础设施插件不生成普通员工工位**：按 `entryId` 建立名单（`storage-*`、`session-*`、`sandbox-*`、`typert-*` 等），不再靠名字猜。

**对产品文档的补充建议：** 把「官方生成式工具目录」写入第 30.4 节作为工具归属的设计依据。原节只提到"优先通过稳定标识、注册信息和明确元数据确认归属"，没有指出这张官方目录的存在——它是这个问题唯一可行的权威解。

#### 4.6.6 表达方案：「外包人员」（用户 2026-09-11 提出）

产品文档要求"无法确认归属时显示未归属状态，不能伪装成已识别插件"。但一个灰色的"未归属"格子会被用户读成**故障**，而不是**设计**。

改用「**外包人员**」这一称谓，把一个像 bug 的状态变成产品的正常世界观——而且它与文档第 5 节已有的映射（安装=入职、卸载=离职、禁用=离岗）是同一套语言，不需要新造概念。

**三条判定出口**（同一张图的实现口径）：

| 情况 | 归属结果 | 权威性 |
|---|---|---|
| 工具名命中官方工具包映射 | 具名员工工位 | 权威（查表） |
| 未命中，但**非官方插件只有一个** | 该插件具名工位 | 权威（**排除法**确定） |
| 未命中，且**非官方插件多于一个** | 外包组工位 | 兜底（标注未登记） |

**关键约束：外包必须是"组"，不能是"个人"。**

若把所有认不出的调用都堆到同一个"外包员工"身上，这个工位的负载数字就是**假的**——它反映的是好几个插件的合计工作量，却表现为一个人的忙碌程度。这直接违反产品文档第 23 节的第二原则「任何动画都应该代表真实系统状态」。

因此：
- **外包组 = 团队，不是个人**。视觉上宜为一排散座 / 共享工区，而非一张独立工位。
- 标签须写明（例如「外包 · 未登记」），不能只靠颜色区分——产品文档 29.4 明确要求"不能只靠颜色区分"。
- 具名员工与外包组在场景里**应当看得出来不是同一类**，但都要保持"温暖微缩工作室"的柔和基调，不做成故障态（不给红色、不做闪烁）。

**白捡的收益：** 外包区的忙碌程度是一个**原本完全不可见**的信号——它反映了当前装了多少非官方插件、以及它们有多活跃。现在它变成一个能一眼看出来的状态，而不是只能翻插件列表才知道。

**注意：** 第三方插件本身在 `ctx.loader.entries()` 中**是有名有姓的**（有 `entryId` 与 `moduleName`）。所以它们的**工位**建得出来，名字就用条目 id；缺的只是"哪些调用算它的"。因此「外包」的准确落点是**"这一笔调用算不到任何人头上"**，而不是"凡是第三方插件都算外包"。

### 4.7 ✅ 插件卸载清理：官方自动清理承诺成立（INT-06）

**为什么必须验**：官方教程承诺「通过 `ctx` 注册的任何东西——事件监听、工具、定时器——在插件卸载时都会被自动清理」，这是本项目所有注册逻辑的设计前提。而我们的插件包装的是 `tools/execute`，**位于每一次工具调用的热路径上**；如果卸载后包装层残留，会随每次启停不断叠加，改变调用链结构——这将直接违反产品文档 30.2「不能让可视化处理阻塞或改变工具执行结果」的硬约束。规划 M5 也明确要求「连续打开/关闭工作室 20 次，观察器、定时器和 GPU 资源无累计残留」。

**测试方法**（可复现，不需要模型）：

1. 挂载两个插件：`studio-probe`（被测对象）与 `probe-unload-test`（测试驱动）。
2. 驱动在启动约 2.5 秒后执行三步：
   - **阶段一**：用公开 API `ctx.tools.execute(ToolExecutionInput)` 发起一次**合成工具调用**，并用 `ctx.emit()` 发一次自定义事件 `studio-probe/echo`。
   - **阶段二**：从 `ctx.loader.entries()` 找到 `studio-probe` 条目，程序化卸载其 fiber。
   - **阶段三**：再次发起合成调用与合成事件。
3. 对比两个阶段中 `studio-probe` 的输出是否出现。

**关键设计点**：合成调用会完整穿越 `tools/pre-execute → guards → tools/execute → tools/post-execute → tools/result`，所以包装层一定会经过；且阶段三的调用**确实返回成功**（`ok:true, durationMs:2`），排除了"因为调用失败所以没日志"的假阳性。

**实测结果**：

| 阶段 | `tools/execute` 包装层 | 自定义监听器 |
|---|---|---|
| before（卸载前） | ✅ 触发：`call-start` / `call-end` / `result` | ✅ 触发：`echo count:1` |
| after（卸载后） | ❌ **无任何输出** | ❌ **无任何输出** |

卸载过程本身也正常：`fiber.state` 由 `2`（active）变为 `4`，`dispose()` 无异常。**证明不是"卸载失败所以没输出"，而是卸载成功且注册物全部随之释放。**

**结论**：官方自动清理承诺经实测成立，覆盖 `ctx.on()` 监听器与 `tools/execute` 包装层。**多轮启停不会导致包装层叠加**，「不改变工具执行结果」这条约束在反复开关后仍然成立。

**已验证的边界与未验证部分**：

- ✅ 已验证：直接卸载 Cordis fiber 的路径。
- ⚠️ 未验证：用户在 **DSH 设置界面禁用插件**的入口。它走的应当是同一条底层释放路径，但严格说该入口本身尚未实测。
- ⚠️ 未验证：`ctx.effect()` 中定时器的清理（本测试只覆盖了监听器与包装层；不过两者同为 fiber 所有，机制一致）。

**回归手段**：测试驱动保留在 `src/host/probe-unload-test.mjs`，覆盖层在 `src/host/cordis-unload-test.yml`。以后新增任何注册逻辑，用同一手法即可回归验证。

### 4.8 ✅ 调用取消：两种形态，且都**不抛异常**（INT-04 收尾）

官方契约见 `.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.zh.md`，定义了 `TOOL_ABORTED` 与 `TOOL_ABORTED_BEFORE_DISPATCH` 两个码。实测两种形态与契约完全一致。

**测试方法**：用 `probe-cancel-test.mjs` 通过合成调用构造（见 §4.7 的手法），场景 A 传入**已中止**的信号，场景 B 发起长任务后中途 abort。

#### 4.8.1 场景 A：进入时已中止 → 流水线被短路

```
[cancel-test] phase  A-aborted-at-entry
[studio-probe] result  probe-cancel-entry  isError:true  "tool call aborted before dispatch"
                       ↑ 只有 result，没有 call-start
[cancel-test] scenario-A  returned:true  durationMs:0  signalAborted:true
```

实测确认：

- 错误消息为 `tool call aborted before dispatch`（`error.message` 不含 `Error: ` 前缀，前缀只在模型可见文本上）
- **`tools/execute` 包装层完全没有被调用**——没有 `call-start`。这与契约「跳过 pre-execute、审批、tools/execute、post-execute 和工具主体」一致
- **仍然发布且只发布一次 `tools/result`**，因此表现为一次**孤立结束**
- 不抛异常，`durationMs` 为 0（物化后立即短路）

#### 4.8.2 场景 B：执行中取消 → 主体已启动，协作式快速停稳

```
[studio-probe] call-start  probe-cancel-mid  pwsh  "Start-Sleep -Seconds 5; ..."
[cancel-test]  abort-fired  atMs:400
[studio-probe] call-end    ok:false  isError:true  cancelled:true  signalAborted:true  durationMs:421
[studio-probe] result      "tool call aborted"
```

**关键数字：abort 在 400 ms 触发，421 ms 即返回——没有等满脚本的 5 秒。**

契约要求「注册表不与工具 promise 竞速，会等主体完全停稳」，指的是**不丢弃 promise**，而非**必须等满任务时长**。实测说明 `pwsh` 工具是**协作式**的（直接终止子进程），因此主体迅速停稳。

**对 3D 场景的直接含义**：取消能快速生效，员工不会在"已取消"之后继续忙数秒。**但此结论只对实现了协作式取消的工具成立**——契约明确警告「不协作的同进程实现可能让注册表无限期保持等待」。

#### 4.8.3 状态引擎必须处理的差异

| 形态 | `call-start`（tools/execute） | `call-end`（tools/execute） | `result`（tools/result） |
|---|---|---|---|
| A 进入时已中止 | ❌ | ❌ | ✅ |
| B 执行中取消 | ✅ | ✅ | ✅ |

**不能假设每个 `result` 都配一个 `call-end`。** 状态引擎必须能处理"孤立结束"，并且遇到时应尝试判定是否为 `ABORTED_BEFORE_DISPATCH`（依据错误消息），而不是当成异常或失败。

#### 4.8.4 取消必须与失败分开统计

三种终止都以 `isError: true` 的结果返回，**只看 `isError` 无法区分**。产品文档 30.5 第 3 条要求「调用取消、执行失败和正常完成分别记录，取消不能计为成功」。

实测可行的判定依据（探针已采用）：

- `exec.signal.aborted` —— 取消时由注册表融合后的信号为已中止
- 错误消息匹配 `/aborted/i`（两个码的模型可见文本都含 `aborted`）

两者取或即可把取消从失败中分离出来。**注意：若照旧只判断 `isError`，取消会被计入失败，且会污染成功率统计。**

**合成调用的已知局限**：合成调用不经过 `session/event`，因此其 `session` 字段为 `unknown`。需要会话身份的验证仍需真实模型调用。

### 4.9 ✅ Web UI 挂载点：四个官方 slot 全部可用（INT-03 完成）

**验证载体**：新建包 `packages/studio-panel/`（`package.json` + `src/host.mjs` + `lib/client.js` + `cordis.yml` 覆盖层）。

#### 4.9.1 客户端插件的完整契约（实测确认）

| 环节 | 要求 | 实测 |
|---|---|---|
| 声明 | `package.json` 声明 `dsh.client`（`platform: 'web'`），`exports['./client']` 指向**已构建**的 bundle | ✅ |
| 扫描 | 宿主扫描 Loader 条目，由**最近归属的 package manifest** 提供浏览器模块 id | ✅ 行 id = **包名** `dsh-studio-panel` |
| bundle 格式 | **闭包工厂**：`window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 返回导出 | ✅ |
| 依赖 | 外部依赖经注入的 require 解析；外壳提供冻结的 `PLATFORM_MODULES` | ✅ **React 实测 v18.3.1** |
| 注册 | 与宿主插件同形：`inject` + `apply(ctx)`，用 `ctx.slots.inject` / `ctx.slots.register` | ✅ `apply()` 被官方 Cordis 调用 |
| 提供 | `/plugins/??<包名>/client.js&rev=<rev>`；`sourceMappingURL` 自动改写为同 combo 的 `.map` | ✅ 200 / `text/javascript` |
| 鉴权 | 需**会话 cookie**（先访问 `/?token=…`），仅在 query 里带 token 无效 | ✅ |

**关键结论：`lib/client.js` 是手写的，M1 阶段不需要任何打包链路。** 直接产出上述闭包工厂格式即可，省掉 tsdown / lightningcss 一整套。

#### 4.9.2 四个 slot 实测结果（全部成功）

用户在界面中的目视回报：

```
✓ slot 注册成功：shell.overlay（选项形式 #1）
✓ slot 注册成功：conversation.input.dock（选项形式 #1）
✓ slot 注册成功：conversation.composer.dock（选项形式 #1）
✓ slot 注册成功：sidebar.footer.action（选项形式 #1）
```

**四个 slot 均以选项形式 #1 —— `{ name, id }` —— 注册成功**（截图确认卡片在四处都真实渲染）。注意 `id` 而非 `key`：实测报错明确要求 `list slot "X" requires options.id`。

| slot | 界面上出现的位置 | 适合承载 |
|---|---|---|
| `shell.overlay` | **整个应用最顶部的整条横幅**（覆盖层级最高） | **主 3D 场景**（可全屏、不挤占既有布局） |
| `conversation.input.dock` | 输入框上方整条 | 紧凑状态条 / 任务进度 |
| `conversation.composer.dock` | 输入区附近整条 | 同上 |
| `sidebar.footer.action` | 左侧栏底部、**「设置」上方** | 开关入口 / 角标（官方 `ui-cordis` 也用这一席位） |

**建议的双 slot 组合**（承接产品文档 §30.7 与 §30.8）：

- **`shell.overlay` = 3D 工作室本体**——覆盖层最高，不改变宿主既有布局，符合"用户应该在 3 秒内看懂谁正在工作"。
- **`sidebar.footer.action` = 开关入口**——正是"提供 3D 关闭或降级展示路径"最自然的位置；关闭时只停渲染、不停采集（见 §4.10）。

#### 4.9.3 ✅ 已解决：插件 3D 资源经 **Remote 层**送达浏览器

**问题**：实测 `fetch('/assets/3d/v2/console.glb')` → **HTTP 404**。宿主不暴露项目文件系统，438,286 面、13.20 MiB 的 `studio.glb` 一度**没有任何路径能到达浏览器**。

**走不通的方案**（已排除）：

| 方案 | 排除原因 |
|---|---|
| 插件自建前缀路由 | `ctx.webServer.register({kind:'prefix', …})` 确实存在，但 catch-all 回退席位**已被 `dsh-host-frontend-static` 占用**（"席位只有一个所有者"）；且**桌面端不开放 Web 服务**（走 `dsh-app://`），不通用 |
| 内联进 client bundle | 13.20 MiB 二进制 → 约 17.6 MiB JS，体积代价大且每次改资源都要重建 bundle |

**正解：复用官方的 `workspaceFiles` Remote 服务**（`packages/api/workspace-files`，界面左侧文件浏览用的就是它）。

| 方法 | 返回 |
|---|---|
| `stat(sessionId, path, signal)` | `{ absolutePath, version, bytes? }` |
| `readAll(sessionId, path, signal)` | 完整原始字节，**base64 编码** |
| `readBytes(sessionId, path, range, signal)` | 字节窗口，base64 —— 适合只取头部验证 |

**实测结果（全部通过）：**

```
· stat 原始返回：{ok:boolean, value:object}     ← Remote 返回是 { ok, value } 信封
✓ stat studio.glb：13.20 MB（上限 32 MB）
✓ studio.glb 前 4 字节 magic="glTF"（13.20 MiB 大文件可读）
✓ GLB 经 Remote 取回：0.49 MB，magic="glTF"，耗时 26 ms
```

**为什么这是最优解：**

1. **两端通用。** 走 Remote 层而非 HTTP —— Web 走 HTTP、桌面走分帧字节管道，同一套 API。**桌面端的资源问题一并解决**，满足产品文档 §30.11 对两端一致性的要求。
2. **无需构建期处理。** 资源保持原文件形态，不改 bundle、不做内联。
3. **`stat` 报出的 13.20 MB 与 manifest 记录的 13,844,600 字节完全一致**，可作为完整性校验的锚点。

**三个必须记住的实现约束（都踩过）：**

1. **`maxFileBytes` 默认 32 MiB**（`packages/api/workspace-files/src/index.ts:187`）。`studio.glb` 13.20 MiB 在限内；**超限时 `readAll` 直接失败，不截断**。该值可配置，插件必须优雅处理失败。
2. **Remote 返回值是 `{ ok, value }` 信封，必须先解包。** 直接取 `.data` / `.bytes` 会什么也拿不到（实测症状：`stat` 报"未报告字节数"、`readAll` 报"缺 data 字段"）。
3. **`sessionId` 只能用 `sessions.list.current`，且必须重试。** 插件 `apply()` 在启动瞬间运行时，`sessions.list` 快照为 `{ ids: [], byId: {}, current: undefined, phase: 'pending' }` —— **会话列表尚未加载完**。实测第 2 次（约 2 秒后）才拿到 id。`uiSession.adapter.current` 在无会话时返回的是 `{key,hooks,keyedHooks,props}` 空占位组件，不可用。

**性能参考：** 0.49 MB 用时 26 ms（约 19 MB/s）。按此推算 `studio.glb` 13.20 MiB 约需 **0.7–1 秒**（含 base64 解码）。对一次性加载可接受，但 3D 层应提供加载态反馈。

**与产品文档的对应：** §30.11 的「模型、纹理、动画资源在 Web 与桌面的打包和加载方式」已由本节给出可行方案；§30.8 的「资源加载失败」降级路径需要按上述约束 1、3 设计。

#### 4.9.4 ✅ HMR：改客户端 bundle 无需重启宿主

实测：编辑 `lib/client.js` 后——

| | rev | 形态 |
|---|---|---|
| 启动时 | `9098b20f72fba316-44` | 进程 nonce + 序号 |
| 编辑后 | `ad00b4e7b54f` | **内容哈希** |

宿主自动重哈希 → 图重组合 → 旧 rev 立即 **404**、新 rev 200。与官方文档描述一致（"初始逐插件 revision 使用进程 nonce…HMR 只哈希被报告为已变化的产物"）。

**实际意义**：3D / React 的迭代闭环很短——改完刷新即见效，不必反复重启宿主。

### 4.10 ⚠️ 一条坏掉的 npx 缓存树会同时打断工具分发与会话恢复（M2→M3 实测）

用 `src/host/studio-bridge.mjs` + `src/host/bridge-selftest.mjs` 实测过程中，先撞上一个**宿主级故障**，它一度被误判成"工具注册在 agent 作用域层"。先把故障记清楚，因为它比结论本身更重要。

**发现 0（根因，最重要）：`--cache` 指向项目 `tmp/npm-cache` 会毁掉整条工具链。**

症状：agent 一开始调工具就崩 `dsh: UNKNOWN: Cannot read properties of undefined (reading 'prepare')`；同时 Web UI 恢复旧会话报 `agent-presets: refusing to compose an unscoped context`。

根因：`ctx.tools[TOOL_RUNTIME_SCHEDULER]`（`packages/core/agent-loop/src/tool-calls.ts:170`）取不到值。该键是 `@deepseek-ai/dsh-tools` 导出的 **`unique symbol`**，**只有同一个模块实例才相等**。两棵 npx 缓存树实测对比：

| npx 缓存树 | `dsh-tools` 副本 | `dsh-agent-loop` 副本 | 符号 |
|---|---:|---:|---|
| 默认 npm 缓存 | **1** | **1** | 单一 |
| 项目 `tmp/npm-cache` | **5** | **2** | **5 个互不相同的符号** |

npm 的嵌套安装把 `dsh-tools` 复制到每个依赖包自己的 `node_modules` 下；`dsh-agent-loop` 从 `dsh-base/node_modules/` 解析到副本 B，而工具服务由副本 A 提供 → 符号失配。更糟的是 `healProfilesModuleFallback` 会把 profile 的 `node_modules/@deepseek-ai/*` **软链到当次使用的 npx 缓存树**，于是这一次 `--cache` 选择把用户家目录的 profile 也一起带坏了（软链 mtime 与启动时刻一致）。

**修复：用默认 npm 缓存启动（不要 `--cache` 指向项目 tmp）。** 同一任务随即 `exit=0` 并正确返回文件名，无需改任何代码。

**对照组（排除自有代码）**：去掉本插件、用同一棵坏树跑同一任务，崩溃**完全相同**；换回默认缓存树后，带插件与不带插件都正常。

**发现 1（真实调用已跑通）**：修好模块树后，用真实 agent 任务（`--profile headless`，真实家目录）实测：

```
stats {started:1, success:1} · mode catalog · runtimeTools 4
员工 tool-fs  desk 1  status working/idle  started 1  success 1  lastOutcome success · read
```

即 **真实成功调用 → 归属到 tool-fs → 落到 1 号工位**，整条数据通路（事件 → 引擎 → 快照）在真实宿主上成立。web profile 下工具插件随会话的 agent 启动才加载，所以刚打开工作室可能是空的——客户端会说明这一点，不是故障。

**发现 2（基础设施会伪装成员工）**：官方目录把 `run_code` 映到 `@deepseek-ai/dsh-tools`——那是**工具注册表本体**，不是工具提供者。它随基础包在启动时就已加载，于是插件-only 归属会凭空造出一个 `tools` 工位，而它其实是工位本身。已加 `INFRASTRUCTURE_MODULES` 黑名单排除（`src/shared/employee-resolver.mjs`）。

**发现 3（归属语义，实测纠正过一次）**：`catalog ∩ loader.entries()` 是**权威基线**；`ctx.tools.schemas()` **只用来提升置信度，不能当过滤条件**：
- 工具名命中运行时名册 → 置信度 `catalog`（运行时确认）；
- 未命中 → 置信度 `catalog-plugin`（**仍归属**，因为运行时名册覆盖不到 agent 平面的工具）。

**为什么纠正**：最初把"运行时名册里没有该工具名"当作不归属的理由。真实调用推翻了它——一次成功的 `read` 调用，全局名册只有 4 个工具且不含 `read`（agent 用的 `read` 注册在 agent 作用域层，全局视图看不到），于是这笔调用被错记成「外包」，而它明明是 `tool-fs` 干的。**宁可降一档置信度，也不能把干活的员工记成外包。**
注意这条与发现 0 无关：模块树修好之后，全局名册**依然**不含 agent 平面的工具（`tools: 4` 里没有 `read`），所以"名册不做过滤"是必须的独立结论。

**发现 4（合成调用的边界）**：`ctx.tools.execute({name:'read'})` 在**没有 agent 活动**的进程里返回 `isError:true, error:"unknown tool \"read\""`。信号预先 abort 时返回 `tool call aborted before dispatch`，且**只产生孤立结果**（`tools/execute` 未被调用），与 §4.8.1 一致，桥接的 `call-result-only` 分支实测被走到。

**发现 5（桥接清理路径实测）**：插件退出时快照的 `connection` 由 `connected` 落为 `disconnected`，员工状态随之变为 `unknown`——§5 用例 6 的"断开不把员工判成完成/待机"在真实宿主里成立。

**发现 6 ⚠️（web profile 下工具插件不进 loader 名册 → 3D 完全不动，用户实测发现）**

用户在 Web UI 里发了消息、确实产生了调用，但 3D 里工位一点变化都没有。宿主侧快照显示：

```
stats {started:2, success:2} · session-04107b2c-…（真实会话）
attribution {mode:'catalog-plugin', runtimeToolCount:0, employeeCount:0}
stations [null,null,null,null,null,null]
员工 unassigned  desk null  ok 2      ← 全部落「外包」，一个工位都没有
```

原因：**web profile 下工具插件不在 `ctx.loader.entries()` 里**（159 条 0 条命中目录），
而当时的归属要求"插件必须在 loader 名册里"。headless 下同一份代码能解出 12 个员工，web 下 0 个。
员工没有工位 → 客户端 `applyState` 把所有工位设成待机 → **工作状态再怎么变，3D 都不动**。

修复两条，缺一不可：
1. **归属只认官方目录**（员工身份 = 插件包名 moduleName）。一笔真实调用本身就是"该插件在岗"的证据，
   不再要求 loader 名册里有它；loader 只用来拿显示名与提升置信度。**空工位仍只给已安装的插件**
   （目录里列着但没装的包不该出现在工作室里）。
2. **调用发现的员工要能落座**：`assignmentFrom(state, seenKeys)` 把「名册 ∪ 调用发现」一起排序分配，
   并在调用发生的当帧重算，不等 5 秒定时刷新。

**发现 7（短调用会被轮询整段错过）**：工具调用常常只有十几毫秒（实测 `read` 12ms），
客户端 1 秒轮询会**完全看不到**这段工作状态，工位看起来永远不动。已改为 500ms 轮询 +
「刚结束的真实活动保留 1.5 秒工作面」的展示平滑（只延长已发生的活动，不制造未发生的活动）。

**发现 8 ⚠️（会话视图必须用 `props.sessionId`，猜会话会一直看错房间）**

`conversation.view` 是 **session 作用域**，宿主通过 `SessionStandardProps` 注入 **`sessionId`**
（`ui-session/src/client/index.ts:112-116` 的声明合并）；轨迹视图正是用它取本会话数据
（`ui-trajectory/src/client/index.ts` 注册时写 `inject: (sessionId: SessionId) => …`）。

工作室视图早期**忽略了这个属性**，改用 `ctx.sessions.list` 的 `current || ids[0]` 去猜——
很可能一直在渲染**别的会话**：用户明明在对话里调用了工具，工作室却永远一片待机。
这是"从来没工作过"的第三个独立原因（前两个是发现 3 的归属过滤、发现 6 的 web 名册）。
已改为优先用 `props.sessionId`，并把 `sessionId` 放进 `useEffect` 依赖（会话切换需重新挂载）。

**发现 9 ⚠️（动画幅度小到看不见——资产问题，别再从控制链路找）**

用户实测："面板已经显示 working，但根本没有任何员工动作。" 面板诊断同时证明控制链路全通
（`匹配工位 6/6`、出现过 `工位动作：0:working`）。直接量 GLB 得到真因：

| 剪辑 | 四元数最大偏移（相对初始姿态） | 换算 |
|---|---:|---|
| Idle | 0.017 | ≈2° |
| **Working（旧）** | **0.0175** | **≈2°——与待机同量级，必然看不见** |
| Error | 0.050 | ≈5.7°（所以故障态看得见） |

已改 `scripts/asset-kit-v2.mjs`：双臂在键盘上方交替起落（**负 X 是抬手方向**，避免手沉进桌面）
+ 躯干前倾 + 低头；**Working 0.0175 → 0.125（≈14°）**，Idle 呼吸同步放大到约 2 倍。

**量幅度的口径**：以"相对初始姿态的最大偏移、沿整段时长采样取峰值"为准。
不要用 accessor 的 min/max 差值——两者定义不同（我第一版据此算错了角度并误报给用户）。

**已加回归门禁**：`scripts/verify-assets.mjs` 要求 `Working`/`Error` 的幅度 ≥ **0.04**，否则失败。
原来只断言"动作确实影响了节点"（阈值 `1e-5` ≈ 0.0006°），2° 也能通过——这正是它当初溜过去的原因。
门禁首次运行即抓到我拍的 0.05 恰好压在 Error 实测值 0.050 上，按实测校准为 0.04。

**改 GLB 不需要重建 bundle、不需要重启宿主**：客户端每次挂载都经 Remote 重新读盘，
退出并重新进入「工作室」视图即可生效。

**附带修正（展示层）**：
- **员工只在工具被调用时工作**，纯聊天不会产生任何工位动作。面板空状态写明这一点，
  否则用户会以为"我明明对话了"却没人干活是故障。
- **`document.hidden` 为真时改为降频 1fps 而不是完全停**：内置浏览器可能把页面误判为后台，
  原来的直接 `return` 会让画面彻底冻住（只剩解析时画的那一帧）。
- **渲染诊断全部做成可复制文字**：帧数、`document.hidden`、匹配工位数、各剪辑轨道数、
  **示例轨道名**、每个工位当前动作。本环境读不了图，文字是唯一验证通道。

**仍未验证**：
- **渲染效果**：本环境禁止启动浏览器，必须由用户目视（3D 房间、工位动作、文字面板）。
- **桌面端**：无桌面环境。
- `~/.dsh` 的 profile 曾被改坏过一次（发现 0），现已随模块树修复恢复；若再出现同类崩溃，先按 §5.6 检查缓存树。

### 4.11 ✅ 模型自身的活动可观测（思维流 / 撰写 / 派活 / token）

**需求来源（用户 2026-09-11）**：只显示插件员工太少，希望把**模型自己的**读取、编写、思维流也体现出来。

**实测确认的两个数据源**（都是官方事件，只读订阅，不改调用链）：

1. **实时增量：`agent/assistant-stream`**——宿主 Cordis 事件，`agent` 作用域，`mode: emit`。
   官方自己也订阅它（`packages/api/session-controller/src/history.ts:54`、`packages/bundle/headless/src/index.ts:113`）。
   **实测根上下文的插件能收到全部 agent 的帧**（headless 真实任务验证）：
   ```
   {"kind":"assistant-stream-online","frameKeys":["type","attemptId","revision","index","time","chunk"],"chunkType":"block-start"}
   ```
   `frame.chunk` 是 `StreamChunk`：
   | chunk.type | 含义 | 工作室里的说法 |
   |---|---|---|
   | `reasoning-delta` | 推理输出（text） | **思维流** |
   | `text-delta` | 正文输出（text） | **编写** |
   | `tool-call-delta` | 工具调用（id/name/argumentsDelta） | **派活** |
   | `usage` | `TokenUsage` | **读取/编写/思维** 的计数 |
   | `block-start` / `block-end` / `finish` | 块边界与结束原因 | 无独立表现 |

2. **持久边界：`session/event`**——`turn/start`、`turn/end`、`step/start`（= 一次模型调用 + 它请求的工具执行）、
   `step/end`、`assistant/message`（带 `stream: AssistantStreamRecord[]` 与可选 `usage`）、
   `assistant/attempt`（**失败 / 重试 / 中途取消**，同样带 stream）。

**TokenUsage 字段**：`inputTokens`、`outputTokens`、`totalTokens?`、`cacheReadTokens?`、`cacheWriteTokens?`、`reasoningTokens?`。
源码明确 **`usage` 可以缺失**（适配器未上报时）→ 缺失必须显示"未上报"，**不补零**。

**一次真实 headless 任务实测到的值**（cumulative，4 次 usage 上报）：
`inputTokens 1192 · outputTokens 194 · reasoningTokens 86 · cacheReadTokens 29440`；
本步 `reasoningChars 188`、`textChars 17`、`toolCallCount 1`；`turn 1 / step 2`、`finishReason {kind:'stop'}`。

**已实现**（`src/shared/model-activity.mjs` + 桥接订阅 + 客户端）：
- 纯逻辑累积器 `createModelActivity` / `applyStreamChunk` / `applyModelSessionEvent` / `modelPhaseOf` / `modelSnapshot`，8 项单测。
- 阶段 `thinking / writing / calling / retrying / idle`：**只由真实到过的增量块决定**，并有 1.5 秒衰减窗口，
  窗口过后回 idle——不"保持思考中"假装模型还在想。
- 快照新增 `model` 段；客户端在状态面板显示阶段、轮次/步骤、token 累计、思维流与输出的尾巴。
- 3D：资产中央总控台上的 `Coordinator` 机器人即"模型本人"，按阶段做**程序化动作**
  （思考=缓慢左右、撰写=快速小幅、派活=转向工位、回 idle 归位）。用程序化动作是因为该节点没有自带剪辑；
  动作由真实阶段驱动，不是凭空演的。

**未做（后续）**：读取/编写仍只是数字与文本，没有独立的空间表现；思维流没有做字幕/气泡动画；
`assistant/attempt` 的重试只在阶段上体现，没有单独的历史记录。

## 5. 已踩实的坑

### 5.1 `--patch` 的参数位置（会导致启动直接失败）

`--patch` 是**启动器级全局参数**，不是 `web` 子命令的选项。写在子命令之后：

```
error: unknown option '--patch'
```

正确顺序：

```bash
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 --profile web --patch "<绝对路径>" --port 3081 --no-open
```

**版本差异：** 源码文档写的是 `dsh web --patch ./xxx.yml`，发布包 `0.1.5-rc.1` **不接受**该写法。`web` 自身只支持 `--host` / `--no-open` / `--port` / `--trusted-host`。

### 5.2 `ctx.set()` 会让整棵插件树加载失败

```
Error: cannot set property "studioProbe" without provide
    at Proxy.set (cordis/lib/index.js:784)
```

Cordis 要求先 `provide`。必须用 `ctx.provide(name, value)`（返回注销函数）。用错的后果不是降级，而是**宿主启动失败**。

### 5.3 Web UI 必须用带令牌的地址访问

启动时打印 `dsh web: http://127.0.0.1:<port>/?token=<token>`。裸端口返回 **401**；带 token 才 303 跳转并种下 cookie。

### 5.4 补丁生效性可离线预检

```bash
npx @deepseek-ai/dsh --profile web --patch "<路径>" --dump-config
```

输出含目标行，路径被规范化为 `file://` URL（空格编码为 `%20`）。不启服务，是改插件后最快的验证手段。

### 5.5 headless profile 可自动驱动真实调用

`--profile headless "<任务>"` 跑一次性任务、打印结果后退出，**不需要人工操作 Web UI**。这让事件验证可以自动化、可重复。注意用独立的 `DSH_HOME`，避免与正在运行的 `web` 宿主抢 `profiles/node_modules.lock`。

### 5.6 ⚠️ 绝对不要用 `--cache` 指向项目目录启动宿主

`npx --cache "L:/Toolfolk for DSH/tmp/npm-cache" ...` 会生成一棵**含重复副本**的模块树（`dsh-tools` 5 份、`dsh-agent-loop` 2 份），而 `healProfilesModuleFallback` 会把 `~/.dsh/profiles/node_modules/@deepseek-ai/*` **软链到这棵树**——于是用户的 profile 也被一起带坏，表现为：

- agent 一调工具就崩 `Cannot read properties of undefined (reading 'prepare')`；
- 恢复旧会话报 `agent-presets: refusing to compose an unscoped context`。

原因见 §4.10 发现 0（`TOOL_RUNTIME_SCHEDULER` 是 `unique symbol`，跨模块副本不相等）。**用默认 npm 缓存即可**。项目自身的 `npm ci --cache ./tmp/npm-cache`（装 three/esbuild）不受影响，那是项目依赖，与宿主 profile 无关。

**恢复方法**：用默认缓存重新启动宿主，`healProfilesModuleFallback` 会把软链重指到正常树；无需手工改任何文件。若启动卡在 `profiles/node_modules.lock`，那是上次进程被强杀留下的**孤儿锁**（文件内容是已消失的 PID），按官方实现说明"孤儿回收是 operator action"，删掉这一个文件即可：

```bash
rm -f "C:/Users/LAI/.dsh/profiles/node_modules.lock"
```

## 6. 插件形态结论

- 插件是**纯 ESM 模块**，宿主直接加载 `.mjs`，**无需 TypeScript、无需编译、无需构建步骤**。
- 导出：`export const name`、`export function apply(ctx, config)`、`export const inject = [...]`。
- 通过 `ctx` 注册的资源随插件卸载自动清理；特殊资源用 `ctx.effect(() => cleanup)`。
- 覆盖层里插件路径**必须写绝对路径**（Windows 用正斜杠形式）。

## 7. 下一步

已完成的 INT 项：**INT-01 ~ INT-06 全部完成**。
- INT-01 环境 ✅、INT-02 插件骨架 ✅、INT-03 UI 挂载点 ✅（§4.9）、INT-04 事件采集 ✅（含取消、并发、会话身份）、INT-05 归属映射 ✅（§4.6）、INT-06 卸载清理 ✅（§4.7）。

**M1 阶段结论：产品具备真实数据基础。** 后端事件、归属依据、UI 挂载三条链路均已打通并留有可复现的验证手段。

待办，按优先级：

1. **PTC / `run_code` 的 parent token** —— 唯一还没拿到的调用拓扑信息（子代理已是跨会话形态，见 §4.5）。
2. **DSH 设置界面的禁用入口** —— §4.7 验的是 fiber 卸载路径；设置界面的启用/禁用入口本身尚未实测。
3. **协作式取消的工具覆盖面** —— §4.8.2 的"快速停稳"结论只对 `pwsh` 实测成立；其他工具的取消响应速度未知。
4. **基础设施插件工位名单** —— 按 §4.6.5 第 4 条，用 `entryId` 建名单（`storage-*`、`session-*`、`sandbox-*`、`typert-*` 等）。
5. **把官方工具目录随包交付并做版本校验** —— §4.6.4 的实现前提。
6. **按 React 18.3.1 锁定 3D 依赖** —— Three.js / React Three Fiber 版本必须与宿主 React 18 匹配（§4.9.1 实测值）。

**已关闭项**：
- 接管 `tools.register` 实验——补丁无排序能力，且插件并行加载，排序不构成"更早注册"的保证；工具服务也不存在注册观察扩展点（见 §4.6.3）。
- 插件 3D 资源送达——已由 `workspaceFiles` Remote 服务解决（见 §4.9.3）。

**M1 可以直接交棒的成果：** 3D 层现在具备全部前置条件——**能拿到真实调用事件、能定位每个调用属于谁、能把真模型送进浏览器、能在官方界面上落位**。下一步（M2/M3）可以开始写状态引擎与第一个真实工位，而不是继续试探接口。

## 8. 复现方式

```bash
# 交互式（Web UI）
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile web --patch "L:/Toolfolk for DSH/src/host/cordis.yml" --port 3081 --no-open
# 打开启动输出里带 token 的地址，发送会触发工具调用的消息

# 自动化（一次性任务）
DSH_HOME="<独立家目录>" npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile headless --patch "L:/Toolfolk for DSH/src/host/cordis.yml" "<任务描述>"

# 卸载清理回归（§4.7）
DSH_HOME="<独立家目录>" npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile headless --patch "L:/Toolfolk for DSH/src/host/cordis-unload-test.yml" "<任意任务>"

# 取消行为回归（§4.8）
DSH_HOME="<独立家目录>" npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile headless --patch "L:/Toolfolk for DSH/src/host/cordis-cancel-test.yml" "<任意任务>"

# 状态桥接自检（§4.10，M2/M3）：跑完看 tmp/studio-state.json，日志里有 check / verdict 行
DSH_HOME="<独立家目录>" npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile web --patch "L:/Toolfolk for DSH/src/host/cordis-bridge-selftest.yml" --port 3082 --no-open

# 状态桥接 + 客户端（M3 开发）：打开带 token 的地址，切到「工作室」视图
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile web --patch "L:/Toolfolk for DSH/packages/studio-panel/cordis.yml" --port 3081 --no-open
```

> **Node 版本**：必须用托管版 Node 22（`C:\Users\LAI\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`）。
> 实测用系统 Node v24 启动宿主时**无任何输出、无报错地挂住**（55 秒零字节）。

探针把所有事件以 `[studio-probe]` 前缀的 JSON 行打到 stdout；测试驱动的输出以 `[unload-test]` / `[cancel-test]` 为前缀。对着看即可判定。

**合成工具调用**：`ctx.tools.execute({ callId, name, arguments, signal })` 是公开 API，会完整穿过策略与扩展点流水线——**不需要模型即可驱动真实调用**，用于确定性测试。已知局限：合成调用不经过 `session/event`，其 `session` 字段为 `unknown`。

---

**证据来源：** 宿主 stdout 中 `[studio-probe]` 前缀的 JSON 行，以及 `reference/deepseek-harness` 指定 commit 的源码。本文所有时间戳、耗时、字段名、代码片段均直接取自上述来源，未做推断。
