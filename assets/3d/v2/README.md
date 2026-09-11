# 温暖微缩工作室 · 3D 资产 v2

按已确认参考图重新制作的第二版可交互资产，2026-09-11。当前是美术精修迭代，待用户视觉验收；尚未接入 DSH。

## 本轮变化

- 六工位布局，采用参考图的左侧大窗、右侧休息区、中央鼠尾草绿总控台、前景矮书架和圆角地台。
- 人物重做头部、覆盖式发帽与弧形发束，提供短发、发髻、短波波头、贝雷帽和眼镜变化；圆润衣袖、领口、抽绳、手掌、裤腿与鞋底替换原来的基础形体。
- 研究、编程、设计、文档、档案与助理工位提供不同屏幕和道具。六人场景包含打字、读文件和拿杯子的示范姿态。
- 木纹、织物、窗外景、屏幕及装饰画共 11 张程序化贴图，嵌入 GLB。无需运行时加载外部图片。
- 绿植改为弯曲叶片、枝干和垂吊藤蔓；补充抽屉、书脊标签、收纳盒、杯子、抱枕、茶几及小摆件。
- 预览器采用暖色日光、环境遮蔽、柔化阴影和抗锯齿。光照由预览器提供，导入其他工具需配置相应灯光。

## 资产文件

| 文件 | 内容 |
|---|---|
| room.glb | 大窗、圆角地台、木地板、墙画与入口隔板 |
| desk.glb | 编程工位，含显示器与桌面道具 |
| chair.glb | 奶油白框架、绿色软垫与脚轮 |
| employee.glb | 蓝衣基础员工，三个动作 |
| plant.glb | 叶片盆栽 |
| bookshelf.glb | 书籍与收纳盒书架 |
| console.glb | 总控台与微笑机器人 |
| sofa.glb | 软垫双人沙发、抱枕 |
| coffeeTable.glb | 木茶几与书籍 |
| studio.glb | 六工位完整美术场景 |
| manifest.json | 精确包体积、三角面、网格数、包围盒、动画名 |

`studio.glb` 为 438,286 个三角面、331 个网格、13,844,600 字节（13.20 MiB）。本轮优先检验美术质量；相比 v1 体积与几何量增加，尚未完成正式性能验收、纹理压缩或 LOD。网格数不等于实际渲染调用数。

## 坐标、动作与使用

单位米，Y 向上。员工局部面向 +Z；桌子使用侧为 +Z，员工放在桌子 +Z 侧并绕 Y 旋转 π 面向桌面。家具可独立加载。

`employee.glb` 与 `studio.glb` 包含 `Idle`、`Working`、`Error`。这是刚性部件层级动画，尚无蒙皮、IK 或步行动作。组合场景的动作统一驱动示例员工，不能直接代表真实插件调用。屏幕、任务标签和工作状态均为演示数据。

## 本地预览和再生成

```powershell
npm ci --ignore-scripts --cache ./tmp/npm-cache
npm run assets:build
npm run assets:verify
npm run preview
```

新版：`http://127.0.0.1:4173/?version=v2`；初版：`http://127.0.0.1:4173/?version=v1`。预览页可切换资产、动作、旋转、暂停、下载 GLB，以及打开参考图。

建模源为 `scripts/asset-kit-v2.mjs`，导出为 `scripts/build-assets.mjs`。默认构建 v2；如需重建初版，运行 `npm run assets:build -- --v1`。

已附带贴图源，无需 Python 即可重建模型。修改纹理时安装 Pillow，执行 `python scripts/make-textures.py`，再导出模型。脚本当前使用 Windows Arial 字体路径；其他系统需调整 `font()`。`textures/*.png` 是正向可读的源图，`textures/gltf/*.png` 是供 GLB 嵌入的纵向翻转版本，匹配 glTF 的 UV 约定。所有纹理由本项目生成，未使用参考图作为模型表面贴图。

## 验证与后续

`npm run assets:verify` 检查十个 GLB 的二进制结构、内嵌图片、顶点、三角面、包围盒与三个动画绑定。Node 检查不解码图片；`node scripts/check-preview.cjs` 使用本地 Chromium 检查图片解码、全部资产切换、动作按钮和真实渲染，需已启动预览服务器及可用 Playwright（通过 `STUDIO_PLAYWRIGHT_PATH` 指定）。

真实截图位于 `docs/assets/studio-render-v2.png`、`employee-render-v2.png` 和 `studio-assets-preview-v2.png`。v1 资产与截图保留供比较。

后续重点是用户视觉验收、角色肩肘接合及更自然的职业动作、真实宿主内性能与兼容性验证。当前图像是 Three.js 实际模型渲染；尚未达到参考概念图的离线渲染细腻度。
