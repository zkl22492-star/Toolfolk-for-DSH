/**
 * 构建客户端 bundle：源码 → 官方要求的「闭包工厂」产物
 *
 *   packages/studio-panel/src/client/index.mjs
 *     ↓ esbuild（bundle 三方库、把平台模块留作 external）
 *   packages/studio-panel/lib/client.js
 *
 * 产物格式（见 packages/client/tsdown.client.ts 头注释与
 * packages/client/modules/src/client/manifest.ts 的 ClientBundleRegistration）：
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * factory 会收到注入的同步 require —— 它只能解析**宿主平台表**里的模块，
 * 所以 react 等必须留作 external，而 three 必须打进 bundle。
 *
 * 用法：node scripts/build-client.mjs
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const ENTRY = resolve(root, 'packages/studio-panel/src/client/index.mjs')
const OUT = resolve(root, 'packages/studio-panel/lib/client.js')
const PACKAGE_JSON = resolve(root, 'packages/studio-panel/package.json')

/**
 * 运行期路径**不再固化进产物**（注入 null）。
 *
 * 曾经的写法是把构建机的绝对路径烤进 bundle，后果是包只能在打包那台机器上工作：
 * 客户端读不到快照 → 连 GLB 路径都拿不到（资源位置也走快照）→ 工作室整个打不开。
 * 现在两端路径都来自宿主快照：
 *   - GLB/美术图：宿主按**包位置**解析（`<包>/assets/...`），随快照下发；
 *   - 快照本身：宿主同时写一份到会话工作区，客户端用**工作区相对路径**引导
 *     （`workspaceFiles` 按会话 header.cwd 解析，任何机器都成立）。
 * 产物里因此不含任何机器相关路径，可直接分发。
 */
const PORTABLE_FALLBACKS = null

/**
 * 宿主冻结的模块表 —— 只有这些能作为 external 交给注入的 require 解析。
 * 来源：reference/deepseek-harness/packages/client/web/src/platform.ts（实测清单）。
 * **three 不在其中，所以必须打进 bundle。**
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

async function main() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const id = pkg.name

  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    // 浏览器里没有 process；three 会读 NODE_ENV 做开发期断言
    define: {
      'process.env.NODE_ENV': '"production"',
      __STUDIO_GLB_PATH__: JSON.stringify(PORTABLE_FALLBACKS),
      __STUDIO_STATE_PATH__: JSON.stringify(PORTABLE_FALLBACKS),
      __STUDIO_ART_ROOT__: JSON.stringify(PORTABLE_FALLBACKS),
    },
    // 默认会把非 ASCII 转成 \uXXXX 转义，导致产物里的中文无法直接检索、排查困难
    charset: 'utf8',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  })

  const code = result.outputFiles[0].text

  // 包成闭包工厂：CJS 产物需要 module/exports 外壳，require 由宿主注入
  // 产物内联了 three.js（MIT）。打包器会剥掉代码注释里的许可声明，
  // 所以这里在产物头部留一行指引，指向随包分发的 THIRD-PARTY-NOTICES.md。
  const banner =
    '/*! ' + id + ' | 许可与第三方声明见 THIRD-PARTY-NOTICES.md（本 bundle 内联了 three.js，MIT） */' + String.fromCharCode(10)
  const wrapped =
    banner +
    'window.__ModuleLoader__.load({' +
    'id:' + JSON.stringify(id) + ',' +
    'factory:function(require){' +
    'var module={exports:{}};var exports=module.exports;' +
    '(function(module,exports,require){\n' + code + '\n})(module,exports,require);' +
    'return module.exports;' +
    '}' +
    '})\n'

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, wrapped, 'utf8')

  const kb = (Buffer.byteLength(wrapped, 'utf8') / 1024).toFixed(1)
  console.log('客户端 bundle 已生成')
  console.log('  id      : ' + id)
  console.log('  产物    : ' + OUT)
  console.log('  体积    : ' + kb + ' KB')
  console.log('  external: ' + PLATFORM_MODULES.length + ' 个平台模块')
  console.log('  内联    : three（平台表未提供，必须打进 bundle）')
  console.log('  GLB     : 不注入（运行时从宿主快照取，装到谁的机器上都成立）')
  console.log('  状态文件: 不注入（客户端走会话工作区相对路径引导）')
}

main().catch((error) => {
  console.error('构建失败：', error)
  process.exitCode = 1
})
