import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  STUDIO_STATE_FILE,
  STUDIO_WORKSPACE_STATE,
  studioStatePath,
  studioWorkspaceStatePath,
} from '../../src/shared/studio-state-path.mjs'

test('用户目录落点：<home>/.dsh/studio/state.json，DSH_STUDIO_STATE 可覆盖', () => {
  assert.equal(studioStatePath('C:/Users/x', undefined), 'C:/Users/x/.dsh/studio/state.json')
  // 尾部斜杠要吃掉，否则会拼出双斜杠
  assert.equal(studioStatePath('C:/Users/x/', undefined), 'C:/Users/x/.dsh/studio/state.json')
  assert.equal(studioStatePath('C:\\Users\\x\\', undefined), 'C:\\Users\\x/.dsh/studio/state.json')
  assert.equal(studioStatePath('C:/Users/x', 'D:/other/state.json'), 'D:/other/state.json')
  // 尾部带分隔符 → 按目录处理，用默认文件名（两种直觉写法都得能用）
  assert.equal(studioStatePath('C:/Users/x', 'D:/other/'), 'D:/other/state.json')
  assert.equal(studioStatePath('C:/Users/x', 'D:\\other\\'), 'D:\\other/state.json')
  // 空串/空白覆盖必须当作"没给"（环境变量为空是常见情况）
  assert.equal(studioStatePath('C:/Users/x', '   '), 'C:/Users/x/.dsh/studio/state.json')
  assert.ok(STUDIO_STATE_FILE.length > 0)
})

test('会话工作区落点：<cwd>/.dsh-studio/state.json，尾部斜杠同样吃掉', () => {
  assert.equal(studioWorkspaceStatePath('L:/proj'), 'L:/proj/.dsh-studio/state.json')
  assert.equal(studioWorkspaceStatePath('L:/proj/'), 'L:/proj/.dsh-studio/state.json')
  assert.equal(studioWorkspaceStatePath('L:\\proj\\'), 'L:\\proj/.dsh-studio/state.json')
  // 客户端就是按这个相对路径读的，绝对路径必须以它结尾，否则两端对不上
  assert.ok(studioWorkspaceStatePath('L:/proj').endsWith('/' + STUDIO_WORKSPACE_STATE))
})

/**
 * 两端常量不许漂移。
 *
 * 客户端 bundle 里的相对路径是**字面量**（它不能 import 宿主模块），宿主按共享函数算。
 * 这两个值一旦不一致，表现是"工作室一直等待宿主状态"，且不报错——所以用测试钉住。
 */
test('客户端字面量与共享常量一致（漂移就会读不到状态文件）', () => {
  const client = readFileSync(
    new URL('../../src/client/index.mjs', import.meta.url),
    'utf8',
  )
  const found = client.match(/const WORKSPACE_STATE_PATH = '([^']+)'/)
  assert.ok(found !== null, '客户端应声明 WORKSPACE_STATE_PATH 字面量')
  assert.equal(found[1], STUDIO_WORKSPACE_STATE)

  // 宿主必须走共享函数，不许自己拼字符串
  const host = readFileSync(new URL('../../src/host.mjs', import.meta.url), 'utf8')
  assert.ok(host.includes('studioWorkspaceStatePath'), '宿主应使用 studioWorkspaceStatePath 计算副本路径')
  assert.ok(!/['"]\.dsh-studio/.test(host), '宿主不应硬编码工作区状态目录')
})
