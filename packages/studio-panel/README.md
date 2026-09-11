# dsh-studio-panel · DSH 3D AI 工作室

把 DSH 的插件与模型调用过程**可视化成 3D 办公室**的官方插件包：插件 = 员工、工位 = 岗位、调用 = 任务。

装上之后，在会话的视图切换器里会多出第三个选项：**对话 / 轨迹 / 3D 工作室**。

## 它显示什么

- **六个固定岗位**：①资料检索 ②撰写修改 ③联网调查 ④会话记忆 ⑤命令执行 ⑥协作调度。真实工具调用驱动对应岗位的动作，插件是岗位里的"承包方"。
- **"正在做某事"**：写的是真实动作（如 `正在联网调查：<url>`），由工具参数推出，不是统计数字。
- **思维流气泡**：员工干活时头顶冒泡，第二行是**这次任务对应的模型推理原文**。
- **交付纸**：回答结束后一张微缩 A4 递到眼前（可滚动看全文，点「已阅」收起）。
- **员工日志 / 汇报记录**：左下角按时间记录调用事件；右上角可展开历史回答（含安装前的历史，从会话日志回填）。
- **明暗主题**：跟随宿主主题。

## 安装

需要宿主为官方发行版 `@deepseek-ai/dsh@0.1.5-rc.1`（宿主 React 18.3.1）。

```bash
dsh plugin --profile web add <本包路径或 tarball 或 git 地址>
dsh --profile web --port 3081 --no-open
```

> 安装路径**不要含空格**（`dsh plugin add` 会把路径按空格切开）：`cd` 到包所在目录用相对路径最稳，
> 例如 `dsh plugin --profile web add ./dsh-studio-panel-0.1.0.tgz`。

启动后按输出里带 `?token=` 的完整地址打开，在「对话 / 轨迹」旁切到「3D 工作室」。

## 数据与隐私

- 插件**只读**宿主事件（`tools/execute`、`tools/result`、`session/event`、`agent/assistant-stream`），
  不修改工具调用链、不拦截返回值。
- 状态快照写到**本机** `<用户目录>/.dsh/studio/state.json`（可用 `DSH_STUDIO_STATE` 覆盖），
  浏览器经 Remote 通道读回。**不向任何外部服务发送数据。**
- 为了让浏览器端在**任何机器**上都能找到这个快照，宿主还会往**当前会话的工作区**写一份
  `.dsh-studio/state.json`（纯派生数据，可随时删除；建议加进你项目的 `.gitignore`）。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方声明（含内联的 three.js）见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
