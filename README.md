# DSH AI 工作室

把 DSH 的插件调用过程可视化成 3D 数字办公室——**插件即员工、工位即岗位、调用即任务**。
核心不是 3D 皮肤，而是让 AI 的工作过程**看得见、可管理**。

当前进度（2026-09-11 收尾）：**M1（Web 端）与 M2 完成，M3 数据通路与画面均已由用户目视确认**——真实调用驱动六个固定岗位、
思维流气泡、交付纸、明暗主题适配都已可用（**56 项测试全绿**）。M4、M5 未开始；**桌面端与可安装的插件包都还没有**。
收尾清单、已知限制与下一步见[开发规划 §13](docs/开发规划.md)。

## 文档

- [产品构想与技术路线](DSH%203D%20AI%20工作室插件｜产品构想文档.md) —— 第 29–30 节为已确认的实施依据
- [开发规划与里程碑](docs/开发规划.md) —— M1–M5 任务拆分与验收标准
- [**接入能力验证结论**](docs/integration-findings.md) —— M1 实测报告：可用接口、关键约束、已知差异与每项证据

## 现在能看到什么

| 能力 | 说明 |
|---|---|
| 六个固定岗位 | 工位 = 岗位：①资料检索 ②撰写修改 ③联网调查 ④会话记忆 ⑤命令执行 ⑥协作调度。插件是岗位里的「承包方」，不占座 |
| 「正在做某事」 | 主文案由**真实参数**推出（如 `正在联网调查：<url>`），不是统计数字；未收录的工具另列"未归类"，不硬塞 |
| 思维流气泡 | 员工干活时头顶冒泡，第二行是**这次任务对应的模型推理原文**（先想后调，按调用归属）；干完停留一会儿淡出 |
| 交付纸 | 回答结束时一张微皱 A4 递到眼前（「老大请过目」+ 红章「已阅」）；可滚动看全文，点印章收起 |
| 明暗主题 | 跟随宿主 `body[data-ds-dark-theme]`，变量单一来源 |
| 总控台机器人 | 中央总控台上的 `Coordinator` 即模型本人，按阶段做程序化动作 |
| 员工日志 | 左下角，**头部固定**（收起按钮不会滚走）；按时间倒序列出调用事件与交付 |
| 汇报记录 | 右上角，**默认收起**，点开展开全部历史回答；**含插件启动前就存在的历史**（从会话完整日志回填） |

## 3D 资产

- [资产说明](assets/3d/v2/README.md)、[资产清单](assets/3d/v2/manifest.json)

```bash
npm ci --ignore-scripts --cache ./tmp/npm-cache
npm run assets:build      # 重新导出模型
npm run assets:verify     # 校验 GLB 结构
npm run preview           # → http://127.0.0.1:4173/?version=v2
```

## 状态开发验证

```bash
npm test                                  # 56 项：状态引擎 + 桥接核心 + 岗位 + 思维流 + 交付
npm run state:replay                      # 纯逻辑回放（不连宿主）
npm run state:replay -- path/to/fixture.json
npm run client:build                      # 源码 → 闭包工厂 bundle（three 内联；改完不用重启宿主）
```

回放输入示例为 `tests/fixtures/studio-replay.json`，包含插件名册、实际工具名册、事件与观察会话。每次回放重建独立状态，输出员工状态及会话统计；这不是宿主真实数据联调。

**归属分两层**（见[接入结论](docs/integration-findings.md) §4.10）：`官方目录 ∩ 已加载插件` 是基线；`ctx.tools.schemas()` 有内容时再求交收紧。实测工具注册在 **agent 作用域层**，没有 agent 活动时工具名册为空——此时快照会带 `attribution.mode = catalog-plugin`，客户端**把降级显示出来**。基础设施包（如工具注册表 `dsh-tools`）不占工位。

## 数据通路（M3）

```text
tools/execute + tools/result + session/event
  → src/host/studio-bridge.mjs        宿主：归约进状态引擎（热路径不写盘，防抖 250ms）
  → tmp/studio-state.json             原子替换的纯 JSON 快照
  → remote.workspaceFiles.readAll     客户端每秒读回（唯一两端通用的通道）
  → packages/studio-panel/src/client  按会话匹配 → 六岗位动作 + 气泡 + 交付纸 + 可复制文字面板
```

状态文件路径由 `src/shared/studio-state-path.mjs` 一处计算，宿主运行时求值、构建脚本构建时注入，两端必须是同一个字符串（可用 `DSH_STUDIO_STATE` 覆盖）。

## 宿主运行

宿主用官方发行包，**不需要源码构建**：

```bash
# 必须用托管版 Node 22（系统 Node 24 实测会无输出挂住）
# 必须用默认 npm 缓存：--cache 指向项目 tmp 会生成含重复副本的模块树，
# 宿主的 healProfilesModuleFallback 会把 ~/.dsh 的 profile 软链过去，导致
# 工具分发崩溃（agent-loop 与 tools 的 unique symbol 失配）。详见接入结论 §5.6。
PATH="/c/Users/LAI/.workbuddy/binaries/node/versions/22.22.2-2:$PATH" \
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 \
  --profile web --patch "L:/Toolfolk for DSH/src/host/cordis-dev.yml" \
  --port 3081 --no-open
# 用启动输出里带 ?token= 的完整地址打开，然后在对话/轨迹旁切到「**3D 工作室**」（视图标签就叫这个名，便于第一次找到）
```

> 首次打开时工作室可能是空的：**Web profile 下工具插件要等会话的 agent 启动才加载**，在对话里发一条消息后员工才会上岗。

| 路径 | 内容 |
|---|---|
| `src/host/studio-probe.mjs` | 事件探针：订阅 `tools/execute` / `tools/result` / `session/event`，只读记录（回归/排查用） |
| `src/host/studio-bridge.mjs` | **状态桥接**：把真实事件归约进状态引擎，防抖写状态快照 |
| `src/host/bridge-selftest.mjs` | 桥接自检驱动：合成调用（成功/失败/取消/并发）→ 读回快照逐项核对 |
| `src/shared/studio-bridge-core.mjs` | 桥接纯逻辑：归属求交、工位分配、快照序列化（可单测） |
| `src/shared/studio-state-path.mjs` | 状态文件路径的唯一约定（宿主与客户端必须一致） |
| `packages/studio-panel/` | 客户端面板包：`dsh.client` 声明 + esbuild 生成的闭包工厂 bundle |
| `src/shared/state-engine.mjs` | 调用记录、会话统计、员工状态 |
| `src/shared/employee-resolver.mjs` | 名册与目录求交，筛选员工、处理别名及歧义 |
| `src/shared/tool-package-map.json` | 工具 → 插件映射（来自官方生成式工具目录） |
| `src/shared/studio-posts.mjs` | 六个固定岗位、岗位顺序与座位对齐、由参数推出「正在做什么」（可单测） |
| `src/shared/model-activity.mjs` | 模型自身活动：思维流按调用归属、token、交付正文与结束性质（可单测） |
| `src/shared/studio-lightart` | 用户的视觉层：`studio-lighting.mjs`（光照/主题）、`studio-art.mjs`（贴图）、`studio-camera.mjs`（取景） |
| `src/host/cordis*.yml` | 覆盖层；`cordis-unload-test.yml` / `cordis-cancel-test.yml` 为回归用 |
| `reference/deepseek-harness/` | 官方源码（已 gitignore，仅用于读契约，不装依赖） |

> 环境约束：宿主 React 为 **18.3.1**，3D 依赖必须按此匹配；改客户端 bundle 由 HMR 自动重载，**无需重启宿主**；
> 改 `src/host/*` 或 `src/shared/*`（宿主侧）**必须重启宿主**（token 会变）。

## 安装给别人（打包形态）

```bash
# 在 packages/studio-panel 下打包（prepack 会自动把 LICENSE / 声明 / 资源复制进包）
cd packages/studio-panel && npm pack
# 生成 dsh-studio-panel-0.1.0.tgz（约 15 MB）
```

装到宿主（**会写入你的 ~/.dsh profile**）。三条渠道，差别在**是否需要授权执行作者代码**：

```bash
# ① tarball / Release 附件：零授权，推荐给普通用户（资源已在包内）
dsh plugin --profile web add ./dsh-studio-panel-0.1.0.tgz

# ② git 子目录：能跟源码，但 pnpm ≥10 会先拦住，需要你授权（= 允许包内脚本在安装时执行）
#    建议锁 commit，避免后续推送悄悄改变实际运行的内容
dsh plugin --profile web add "owner/repo#<sha>&path:/packages/studio-panel"
#    首次失败后，把 pnpm 打印的键写进该 profile 的 pnpm-workspace.yaml：
#      allowBuilds:
#        dsh-studio-panel: true

# ③ npm（尚未发布）
dsh plugin --profile web add dsh-studio-panel
```

`prepare` 脚本（git 安装时运行）只做一件事：把仓库里的 `studio.glb` 与美术图**复制进包**，不联网。

**包内容**：`src/`（宿主入口与共享模块）、`lib/client.js`（含内联 three）、`assets/`（`studio.glb` 与 4 张美术图）、
`cordis.patch.yml`、`README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`。**不含**设计文档、测试、脚本与开发工具。

## 许可、声明与隐私

- **第三方声明**：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。客户端产物内联了 **three.js（MIT）**，
  而打包器会剥掉代码里的许可注释，所以**分发时必须随包附带该文件**（产物头部也留了指引）。
- **本项目自身的许可**：**MIT**（[LICENSE](LICENSE)，`Copyright (c) 2026 浊客er`）。
- **资产来源**：`assets/3d/v2/*.glb` 由本项目脚本**程序化生成**；`assets/art/studio-v1/*.png` 为**项目作者自制**。均不含第三方素材。
- **隐私**：本插件只读宿主事件，只把状态写到**本机文件**（默认 `<用户目录>/.dsh/studio/state.json`，
  可用 `DSH_STUDIO_STATE` 覆盖），**不发送任何数据到外部**。为了让客户端在任何机器上都能找到它，
  同一个快照还会往**会话工作区**写一份 `.dsh-studio/state.json`（纯派生数据，可随时删除，仓库已 gitignore）。
- **兼容**：官方 `@deepseek-ai/dsh@0.1.5-rc.1`（宿主 React 18.3.1）。桌面端尚未验证。

## 尚未完成（不要当作已通过）

- **打包阻塞已全部解决**（① `dsh.bundle.patch`；② 跨目录依赖 → 包内自带 `src/shared`；③ 绝对路径；
  ④ 两个半侧合成一个插件行）。逐条证据见[打包清单](docs/打包清单.md) §6。
  其中③在收尾时又发现一层：**客户端产物曾把构建机的绝对路径烤进去**，导致包只能在打包那台机器上工作；
  现在宿主把快照**同时**写到会话工作区，客户端用**工作区相对路径**引导，产物内不含任何机器相关路径。
- **真正的 `dsh plugin add` 安装/卸载**：未在真实 profile 上跑过（会写用户的 `~/.dsh`，留给用户自己执行）；
  已验证到「tarball 能被 pnpm 正常安装且不需要 `prepare`」这一步。
- **桌面端**：从未验证（一直没有可用环境）。
- **性能**：从未测量；资产里 **95% 是未压缩几何**（12.56 MiB / 13.21 MiB），是唯一值得优化的地方。
- **真人目视项**：动作穿插、交付纸排版、气泡避让边界；10 分钟连续观察未做。
- **减少动态效果 / 性能模式**：用户明确决定延后到发布前。
