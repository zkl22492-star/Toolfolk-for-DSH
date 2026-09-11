# 第三方声明 / Third-Party Notices

本文件列出 **dsh-studio-panel（DSH 3D AI 工作室）** 分发物中包含或依赖的第三方软件及其许可。
分发（打包、拷贝给他人、发布到 registry）时**必须随包附带本文件**。

> 说明：为什么需要它 —— 我们把自己的客户端 bundle 做成了单文件（`lib/client.js`），
> 里面**内联了 three.js**。MIT 许可要求"保留版权与许可声明"，而打包器（esbuild）
> 默认会把代码注释（含许可声明）剥掉，所以声明必须由本文件一并提供。

---

## 已内联进产物（会随包分发）

### three.js
- 版本：`0.180.0`
- 用途：3D 场景渲染、GLB 解析、动画、CSS2D 标签
- 位置：`lib/client.js`（内联；宿主平台模块表不含 three，必须自带）
- 许可：MIT

```
The MIT License

Copyright © 2010-2025 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 构建期依赖（不进入分发物）

### esbuild
- 版本：`0.28.2`
- 用途：仅在 `scripts/build-client.mjs` 里把客户端源码打成 bundle；产物中不含 esbuild 代码
- 许可：MIT（Copyright (c) 2020 Evan Wallace）

---

## 不作为依赖分发的软件

### DeepSeek Harness 官方包（`@deepseek-ai/dsh*`）
- 插件的运行依赖由**宿主**提供（平台模块表：React、Cordis、dsh-client-* 等），
  我们不打包、不重分发官方包；兼容版本见 README。
- 项目内 `reference/deepseek-harness/` 是官方源码的浅克隆，**已 gitignore**，仅用于读契约，不参与分发。

---

## 自有资产来源

| 资产 | 来源 |
|---|---|
| `assets/3d/v2/*.glb` + `manifest.json` | **由本项目脚本程序化生成**（`scripts/asset-kit-v2.mjs` → `scripts/build-assets.mjs`）。不含第三方模型；贴图亦由脚本生成或由下述美术图转换。 |
| `assets/art/studio-v1/*.png`（窗景日/夜、挂画、chibi、标语） | **项目作者自制**（2026-09-11 确认），不含第三方素材。 |
| 代码（`src/`、`packages/`、`scripts/`） | 本项目自有，以 **MIT** 许可发布（见仓库根 `LICENSE`）。 |

---

## 本项目自身的许可

**MIT** —— 全文见仓库根 [`LICENSE`](LICENSE)（`Copyright (c) 2026 浊客er`）。
仓库根 `package.json` 的 `license` 字段均已标为 `MIT`。

## 发布前仍建议补齐

- [ ] 若公开分发：补充 `author` / `repository` 字段与发布说明；
- [ ] 分发时**必须**把本文件与 `LICENSE` 一起放进包里。
