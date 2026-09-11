import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createEmployeeResolver } from '../../packages/studio-panel/src/shared/employee-resolver.mjs'
import { replayStudio } from '../../scripts/lib/replay.mjs'

const catalog = JSON.parse(readFileSync(new URL('../../packages/studio-panel/src/shared/tool-package-map.json', import.meta.url)))
const plugin = (entryId, name) => ({ entryId, moduleName: '@deepseek-ai/dsh-' + name })
/** 员工身份 = 插件包名（moduleName），不是配置里的条目 id。 */
const MOD = (name) => '@deepseek-ai/dsh-' + name

test('catalog attribution resolves tools and groups them by package', () => {
  const resolve = createEmployeeResolver(catalog, [plugin('fs', 'tool-fs'), plugin('infra', 'client')], ['read', { name: 'write' }, 'custom'])
  assert.equal(resolve('read').key, MOD('tool-fs'))
  assert.equal(resolve('write').key, MOD('tool-fs'))
  assert.equal(resolve('read').confidence, 'catalog')
  // edit 也属 tool-fs。运行时名册没列出它（agent 平面的工具不在全局名册里），
  // 但目录是显式映射 → 仍然归属，只是置信度降一档。
  assert.equal(resolve('edit').key, MOD('tool-fs'))
  assert.equal(resolve('edit').confidence, 'catalog-plugin')
  // 目录里没有的工具名一律不认（不猜名字）
  assert.equal(resolve('custom'), null)
  assert.equal(resolve.roster.length, 1)
  // 一笔真实调用本身就是"该插件装着"的证据：即使插件条目看不到，
  // 只要目录能唯一落到一个包，就要归属——否则 web profile 下全是「外包」。
  assert.equal(createEmployeeResolver(catalog, [], ['read'])('read').key, MOD('tool-fs'))
})

test('aliases resolve only a unique enabled runtime owner', () => {
  const plain = plugin('plain', 'tool-bash')
  const persistent = plugin('pty', 'tool-bash-persistent')
  assert.equal(createEmployeeResolver(catalog, [persistent], ['bash'])('bash').key, MOD('tool-bash-persistent'))
  // 一次性版与持久版同时在场 → 同名跨包，不猜
  assert.equal(createEmployeeResolver(catalog, [plain, persistent], ['bash'])('bash'), null)
  assert.equal(createEmployeeResolver(catalog, [plain, { ...persistent, enabled: false }], ['bash'])('bash').key, MOD('tool-bash'))
  // 同一个包被装了两个条目：员工按包算，仍是同一个人
  assert.equal(createEmployeeResolver(catalog, [plain, { ...plain, entryId: 'other' }], ['bash'])('bash').key, MOD('tool-bash'))
})

test('fresh replay is deterministic and preserves concurrent work', () => {
  const input = JSON.parse(readFileSync(new URL('../fixtures/studio-replay.json', import.meta.url)))
  const first = replayStudio({ ...input, catalog })
  assert.deepEqual(first, replayStudio({ ...input, catalog }))
  assert.equal(first.employees[0].runningCount, 1)
  assert.equal(first.employees[0].started, 2)
  assert.equal(first.sessionStats['demo-session'].running, 1)
})
