# DSH AI 工作室

把 DSH 的插件与模型调用过程**可视化成 3D 数字办公室**——**插件即员工、工位即岗位、调用即任务**。

六名员工各有固定岗位，谁在干活、在干什么、为什么这么干、最后交付了什么，一眼看得见。

**实机画面**（暗色主题 · 真实调用驱动 · 六名员工各就各位）：

![DSH 3D AI 工作室 · 实机](docs/assets/studio-live-room.png)

---

## 安装

**前置**：官方宿主 `@deepseek-ai/dsh@0.1.5-rc.1`（宿主 React 18.3.1）。已经装过 DSH 就不用再装。

### 1. 下载插件包（点一下就行，不用找 Releases 页面）

### 👉 **[点这里下载 dsh-studio-panel-0.1.0.tgz](https://github.com/zkl22492-star/Toolfolk-for-DSH/releases/download/v0.1.0/dsh-studio-panel-0.1.0.tgz)**（15 MB）

文件会进你的**下载**文件夹。

### 2. 打开终端，执行一条命令

在**下载文件夹**里打开终端：

- **Windows**：在文件资源管理器的**地址栏**输入 `cmd` 回车（就打开在下载目录了）
- **macOS**：右键下载文件夹 → 服务 → 新建位于文件夹位置的终端窗口
- **Linux**：在下载目录右键「在终端中打开」

然后复制粘贴这一条：

```bash
dsh plugin --profile web add ./dsh-studio-panel-0.1.0.tgz
```

没装全局 `dsh` 的话，换成：

```bash
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 plugin --profile web add ./dsh-studio-panel-0.1.0.tgz
```

### 3. 启动并打开工作室

```bash
dsh --profile web --port 3081 --no-open
```

用启动输出里带 `?token=` 的**完整地址**打开，
在视图切换器的「对话 / 轨迹」旁边切到 **「3D 工作室」**（标签就叫这个名，便于第一次找到）。

> 首次打开可能是空房间：**Web profile 下工具插件要等会话的 agent 启动才加载**——在对话里发一条消息，员工就上岗了。

**卸载**：`dsh plugin --profile web remove dsh-studio-panel`

> 安装路径**不要含空格**：`dsh plugin add` 会把路径按空格切开（实测 `L:/Toolfolk for DSH/…` 会被截成 `L:/Toolfolk`）。
> 在下载目录用上面那条**相对路径** `./文件名` 最稳。

### 其它安装方式

| 方式 | 命令 | 是否需要授权执行作者代码 |
|---|---|---|
| **下载附件**（上面那种，推荐） | `dsh plugin --profile web add ./dsh-studio-panel-0.1.0.tgz` | 否 |
| git 一条命令（能跟源码） | `dsh plugin --profile web add "github:zkl22492-star/Toolfolk-for-DSH#path:/packages/studio-panel"` | **是**：pnpm ≥10 会先拦住，需按提示把 `allowBuilds: dsh-studio-panel: true` 写进该 profile 的 `pnpm-workspace.yaml`，再跑一次。建议锁 commit（`#<sha>&path:…`） |
| npm（尚未发布） | `dsh plugin --profile web add dsh-studio-panel` | 否 |

### 安装注意

- ⚠️ **安装路径不要含空格**：`dsh plugin add` 会把路径按空格切开（实测 `L:/Toolfolk for DSH/…` 会被截成 `L:/Toolfolk`）。
  在包所在目录用相对路径最稳。
- 插件只读宿主事件，**不联网、不上传任何数据**；状态只写到本机（见下「许可、隐私与兼容」）。
- 实测（独立 profile，非本机默认 profile）：`add` 781 ms → **不带 `--patch` 启动即自动加载**、资源从安装位置解析 → `remove` 549 ms。

---

## 它长什么样

| 能力 | 说明 |
|---|---|
| **六个固定岗位** | 工位 = 岗位：①资料检索 ②撰写修改 ③联网调查 ④会话记忆 ⑤命令执行 ⑥协作调度。插件是岗位里的「承包方」，不占座 |
| **「正在做某事」** | 主文案由**真实参数**推出（如 `正在联网调查：<url>`），不是统计数字；未收录的工具另列"未归类"，不硬塞 |
| **思维流气泡** | 员工干活时头顶冒泡，第二行是**这次任务对应的模型推理原文**（先想后调，按调用归属）；干完停留一会儿淡出 |
| **交付纸** | 回答结束时一张微皱 A4 递到眼前（「老大请过目」+ 红章「已阅」）；可滚动看全文，点印章收起 |
| **员工日志** | 左下角，**头部固定**（收起按钮不会滚走）；按时间倒序列出调用事件与交付 |
| **汇报记录** | 右上角，**默认收起**；点开展开全部历史回答，**含插件启动前就存在的历史**（从会话完整日志回填） |
| **明暗主题** | 跟随宿主 `body[data-ds-dark-theme]`，颜色变量单一来源 |
| **总控台机器人** | 中央总控台上的 `Coordinator` 即模型本人，按阶段做程序化动作 |

员工干活时头顶冒泡，气泡第二行就是**这次任务对应的模型推理原文**（实机截图中两个工位正在同时干活）：

![思维流气泡：正在联网调查 / 正在运行命令](docs/assets/studio-live-bubbles.png)

更多截图见 [`docs/assets/`](docs/assets)。

## 文档

- [**接入能力验证结论**](docs/integration-findings.md) —— 官方接口实测：可用接口、关键约束、已知差异与每项证据
- [开发规划与里程碑](docs/开发规划.md) —— 任务拆分、验收标准、收尾记录
- [打包清单](docs/打包清单.md) —— 打包/分发/验收细节
- [产品构想与技术路线](DSH%203D%20AI%20工作室插件｜产品构想文档.md)
- [资产说明](assets/3d/v2/README.md) · [资产清单](assets/3d/v2/manifest.json)

## 许可、隐私与兼容

- **许可**：**MIT**（[LICENSE](LICENSE)，`Copyright (c) 2026 浊客er`）。
- **第三方声明**：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。客户端产物内联了 **three.js（MIT）**，
  而打包器会剥掉代码里的许可注释，所以**分发时必须随包附带该文件**（产物头部也留了指引）。
- **资产来源**：`assets/3d/v2/*.glb` 由本项目脚本**程序化生成**；`assets/art/studio-v1/*.png` 为**项目作者自制**。不含第三方素材。
- **隐私**：插件只读宿主事件（`tools/execute`、`tools/result`、`session/event`、`agent/assistant-stream`），
  不修改工具调用链、不拦截返回值；状态只写到**本机文件**，**不发送任何数据到外部**：
  - `<用户目录>/.dsh/studio/state.json`（可用 `DSH_STUDIO_STATE` 覆盖）；
  - 会话工作区里的一份 `.dsh-studio/state.json`——**纯派生数据、可随时删除**，是为了让浏览器端在任何机器上都找得到状态；
    建议加进你项目的 `.gitignore`（本仓库已加）。
- **兼容**：官方 `@deepseek-ai/dsh@0.1.5-rc.1`（宿主 React 18.3.1）。**桌面端未验证**。

---

## 开发

### 构建与测试

```bash
npm ci
npm test                  # 65 项：状态引擎 + 桥接核心 + 岗位 + 思维流 + 交付 + 状态路径
npm run client:build      # 源码 → 闭包工厂 bundle（three 内联；改完不用重启宿主）
npm run state:replay      # 纯逻辑回放（不连宿主）；可传 tests/fixtures/studio-replay.json
npm run assets:build      # 重新导出模型
npm run assets:verify     # 校验 GLB 结构与动作幅度
npm run preview           # 预览 3D 资产 → http://127.0.0.1:4173/?version=v2
```

### 开发态运行

宿主用官方发行包，**不需要源码构建**：

```bash
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile web --patch "<仓库绝对路径>/src/host/cordis-dev.yml" \
  --port 3081 --no-open
# 用启动输出里带 ?token= 的完整地址打开，切到「3D 工作室」
```

两个实测出来的环境约束（踩过，别再踩）：

- **必须用 Node 22**：系统 Node 24 实测会无输出挂住；
- **必须用默认 npm 缓存**：`--cache` 指向项目 `tmp` 会生成含重复副本的模块树，宿主的 profile 软链会被带坏，
  工具分发随之崩溃（`agent-loop` 与 `tools` 的 unique symbol 失配）——详见[接入结论 §5.6](docs/integration-findings.md)。

> 环境约束：宿主 React 为 **18.3.1**，3D 依赖必须按此匹配；改客户端 bundle 由 HMR 自动重载，**无需重启宿主**；
> 改 `src/host/*` 或 `src/shared/*`（宿主侧）**必须重启宿主**（token 会变）。

### 数据通路

```text
tools/execute + tools/result + session/event + agent/assistant-stream
  → packages/studio-panel/src/host.mjs   宿主：归约进状态引擎（热路径不写盘，防抖 250 ms）
  → <用户目录>/.dsh/studio/state.json    权威快照（原子替换）
  → <会话工作区>/.dsh-studio/state.json  同一份副本：客户端用**工作区相对路径**引导，
                                         换台机器/换账号也能找到（绝对路径是构建期算的，包不写死）
  → remote.workspaceFiles.readAll        客户端每 500 ms 读回（两端通用通道）
  → packages/studio-panel/src/client     按会话匹配 → 六岗位动作 + 气泡 + 交付纸 + 日志/汇报
```

### 目录

| 路径 | 内容 |
|---|---|
| `packages/studio-panel/` | **分发包**：客户端面板（`lib/client.js`，含内联 three）+ 宿主入口 + 包内补丁 |
| `src/host/studio-probe.mjs` | 事件探针：订阅 `tools/execute` / `tools/result` / `session/event`，只读记录（回归/排查用） |
| `src/host/bridge-selftest.mjs` | 桥接自检驱动：合成调用（成功/失败/取消/并发）→ 读回快照逐项核对，并验工作区副本相对路径可读 |
| `src/shared/studio-bridge-core.mjs` | 桥接纯逻辑：归属求交、工位分配、快照序列化（可单测） |
| `src/shared/studio-state-path.mjs` | 状态文件路径的唯一约定（宿主与客户端必须一致） |
| `src/shared/state-engine.mjs` | 调用记录、会话统计、员工状态 |
| `src/shared/employee-resolver.mjs` | 名册与目录求交，筛选员工、处理别名及歧义 |
| `src/shared/tool-package-map.json` | 工具 → 插件映射（来自官方生成式工具目录） |
| `src/shared/studio-posts.mjs` | 六个固定岗位、岗位与座位对齐、由参数推出「正在做什么」（可单测） |
| `src/shared/model-activity.mjs` | 模型自身活动：思维流按调用归属、token、交付正文与结束性质（可单测） |
| `src/shared/studio-{lighting,art,camera}.mjs` | 视觉层：光照/主题、贴图、取景 |
| `src/host/cordis*.yml` | 覆盖层；`cordis-unload-test.yml` / `cordis-cancel-test.yml` 为回归用 |
| `reference/deepseek-harness/` | 官方源码（已 gitignore，仅用于读契约，不装依赖） |

**归属分两层**（见[接入结论](docs/integration-findings.md) §4.10）：`官方目录 ∩ 已加载插件` 是基线；
`ctx.tools.schemas()` 有内容时再求交收紧。实测工具注册在 **agent 作用域层**，没有 agent 活动时工具名册为空——
此时快照会带 `attribution.mode = catalog-plugin`，客户端**把降级显示出来**。基础设施包（如工具注册表 `dsh-tools`）不占工位。

### 打包与分发（维护者）

```bash
cd packages/studio-panel && npm pack    # prepack 自动把 LICENSE / 声明 / 资源复制进包
# → dsh-studio-panel-0.1.0.tgz（15.2 MB / 23 个文件）
```

**包内容**：`src/`（宿主入口与共享模块）、`lib/client.js`（含内联 three）、`assets/`（`studio.glb` 与 4 张美术图）、
`cordis.patch.yml`、`README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`。**不含**设计文档、测试、脚本与开发工具。

`prepare` 脚本（git 安装时运行）只做一件事：把仓库里的 `studio.glb` 与美术图**复制进包**，不联网。
产物内不含任何机器相关路径（客户端引导走会话工作区相对路径）。

## 尚未完成（不要当作已通过）

- **跨机器安装**：未在**另一台机器/账号**上装过（本环境只有一台）。tarball 渠道已实测：装 → 不带 `--patch` 自动加载 → 卸载。
- **git 子目录渠道**：pnpm 机制已验证（子目录识别、`allowBuilds` 门禁、`prepare` 能读到整个仓库），
  **完整的 `dsh plugin add owner/repo#…` 未实测**（需要仓库已上线）。
- **桌面端**：从未验证（一直没有可用环境）。
- **性能**：从未测量；资产里 **95% 是未压缩几何**（12.56 MiB / 13.21 MiB），是唯一值得优化的地方。
- **真人目视项**：动作穿插（手/桌/椅/脸）、交付纸排版与字号、气泡避让的边界情况；10 分钟连续观察未做。
- **减少动态效果 / 性能模式**：明确决定延后。
