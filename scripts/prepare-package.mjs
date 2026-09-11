/**
 * 打包前置：把**运行时需要但不在包目录里**的文件复制进包。
 *
 * 为什么需要：13.2 MiB 的 `studio.glb` 与美术图由资产管线生成在仓库的 `assets/` 下，
 * 源码也放在仓库根。分发时它们必须在**包内**（别人的机器上没有我们的仓库）。
 * 复制出来的这些文件**已 gitignore**——`npm pack` 前由 `prepack` 自动生成，
 * 所以仓库里不会多出 22 MB 的副本。
 *
 * 用法：`npm pack` 会自动触发（packages/studio-panel 的 prepack）；
 *      也可以手动 `node scripts/prepare-package.mjs`。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = resolve(root, 'packages/studio-panel')

const copies = [
  [resolve(root, 'LICENSE'), resolve(pkg, 'LICENSE')],
  [resolve(root, 'THIRD-PARTY-NOTICES.md'), resolve(pkg, 'THIRD-PARTY-NOTICES.md')],
  [resolve(root, 'assets/3d/v2/studio.glb'), resolve(pkg, 'assets/studio.glb')],
]

const artSource = resolve(root, 'assets/art/studio-v1')
const artTarget = resolve(pkg, 'assets/art')
if (existsSync(artSource)) {
  for (const name of readdirSync(artSource)) {
    if (name.toLowerCase().endsWith('.png')) copies.push([join(artSource, name), join(artTarget, name)])
  }
}

let done = 0
let bytes = 0
for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.error('缺少源文件：' + from)
    process.exitCode = 1
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  bytes += statSync(to).size
  done += 1
}
console.log(`prepare-package: 复制 ${done} 个文件（${(bytes / 1048576).toFixed(1)} MiB）到 packages/studio-panel/`)
