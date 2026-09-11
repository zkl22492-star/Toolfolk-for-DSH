/**
 * 宿主桥接核心用例（M2 → M3 接缝）
 *
 * 覆盖三件事：
 *   1. 归属（§4.6.5）——官方目录给出唯一包名；运行时名册只提升置信度、不做过滤
 *   2. 工位分配的**稳定性**与「调用发现的员工也能落座」（MVP-01）
 *   3. 快照可序列化且如实反映状态——客户端读到的东西不能有 Map，也不能美化未知
 *
 * 运行：node --test tests/**\/*.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  assignmentFrom,
  assignStations,
  buildAttribution,
  buildSnapshot,
  lastOutcomeOf,
  normalizePlugins,
  normalizeToolNames,
  outcomePayload,
  STATION_COUNT,
} from '../../packages/studio-panel/src/shared/studio-bridge-core.mjs'
import { CONNECTION, UNASSIGNED_EMPLOYEE, createStudio, reduce } from '../../packages/studio-panel/src/shared/state-engine.mjs'

const catalog = JSON.parse(readFileSync(new URL('../../packages/studio-panel/src/shared/tool-package-map.json', import.meta.url)))

const plugin = (entryId, name) => ({ entryId, moduleName: '@deepseek-ai/dsh-' + name })
/** 员工身份 = 插件包名（moduleName）。 */
const MOD = (name) => '@deepseek-ai/dsh-' + name

test('buildAttribution 用「官方目录 ∩ 已加载插件」建立员工，不猜名字（§4.6.5）', () => {
  const { resolve, roster } = buildAttribution({
    catalog,
    plugins: [plugin('fs', 'tool-fs'), plugin('search', 'tool-fs-search'), plugin('infra', 'tool-pty')],
    toolNames: ['read', 'write', 'glob', 'not-a-real-tool'],
  })
  assert.equal(resolve('read').key, MOD('tool-fs'))
  assert.equal(resolve('write').key, MOD('tool-fs'))
  assert.equal(resolve('glob').key, MOD('tool-fs-search'))
  // 目录里没有的工具名 → 不认（不猜名字）
  assert.equal(resolve('not-a-real-tool'), null)
  // 基础设施插件：没有对应工具被求交，因此不建空工位
  assert.deepEqual(
    roster.map((item) => item.entryId).sort(),
    [MOD('tool-fs'), MOD('tool-fs-search')],
  )
})

test('运行时工具名册为空时仍按目录∩插件建立员工，并标注模式', () => {
  // 实测：无 agent 活动时 ctx.tools.schemas() 可能为空。此时若要求名册必须命中，
  // 用户打开工作室会看到一个空房间——但插件确实装着。
  const { resolve, roster, mode, runtimeToolCount } = buildAttribution({
    catalog,
    plugins: [plugin('fs', 'tool-fs'), plugin('search', 'tool-fs-search')],
    toolNames: [],
  })
  assert.equal(mode, 'catalog-plugin')
  assert.equal(runtimeToolCount, 0)
  assert.equal(resolve('read').key, MOD('tool-fs'))
  assert.equal(resolve('read').confidence, 'catalog-plugin')
  assert.deepEqual(roster.map((item) => item.entryId).sort(), [MOD('tool-fs'), MOD('tool-fs-search')])
})

test('基础设施包不占工位（run_code 属工具注册表，不是工人）', () => {
  // 实测：@deepseek-ai/dsh-tools 随基础包在启动时就加载，官方目录把 run_code 映到它。
  // 不过滤的话工作室会凭空多出一个 "tools 员工"，而它其实是工位本身。
  const { resolve, roster } = buildAttribution({
    catalog,
    plugins: [plugin('tools', 'tools'), plugin('fs', 'tool-fs')],
    toolNames: [],
  })
  assert.equal(resolve('run_code'), null)
  assert.deepEqual(roster.map((item) => item.entryId), [MOD('tool-fs')])
})

test('名册为空时真实调用仍能建员工并落座（web profile 实测症状）', () => {
  // 实测症状：web profile 下工具插件不进 loader 名册 → 名册空 → 全部调用落「外包」、
  // 没有工位 → 客户端 applyState 把 6 个工位全设成待机 → **3D 里工作状态变化也不动**。
  // 修复是：一笔真实调用本身就证明插件在岗，它必须能落座。
  const { resolve, roster } = buildAttribution({ catalog, plugins: [], toolNames: [] })
  assert.equal(roster.length, 0)

  const state = createStudio({ resolveEmployee: resolve })
  reduce(state, { type: 'roster', plugins: roster })
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: 'S', at: 1 })
  reduce(state, { type: 'call-finished', callId: 'c1', ...outcomePayload({ isError: false }), at: 2 })

  // 桥接会把「调用发现的员工」并进分配；这里模拟同一个并集
  const assignment = assignmentFrom(state, [MOD('tool-fs')], STATION_COUNT)
  const snapshot = buildSnapshot(state, { assignment, now: 3 })
  const employee = snapshot.sessions.S.employees.find((item) => item.employeeKey === MOD('tool-fs'))
  assert.equal(employee.success, 1)
  assert.equal(typeof employee.desk, 'number') // 有工位 → 客户端才会驱动动画
  assert.equal(snapshot.assignment.byStation[employee.desk], MOD('tool-fs'))
  // 外包组不占工位
  assert.equal(assignment.byStation.includes(UNASSIGNED_EMPLOYEE), false)
})

test('运行时名册只提升置信度，不作为过滤条件（实测纠正）', () => {
  // 曾经把「运行时名册里没有该工具名」当作不归属的理由。**真实调用推翻了它**：
  // 一次成功的 read 调用，全局名册只有 4 个工具且不含 read（工具注册在 agent 作用域层，
  // 全局视图看不到），于是这笔调用被错记成「外包」——而它明明是 tool-fs 干的。
  // 现在的语义：命中运行时名册 → confidence 'catalog'；未命中 → 'catalog-plugin'，**仍然归属**。
  const { resolve, mode } = buildAttribution({
    catalog,
    plugins: [plugin('fs', 'tool-fs')],
    toolNames: ['read'],
  })
  assert.equal(mode, 'catalog')
  assert.equal(resolve('read').key, MOD('tool-fs'))
  assert.equal(resolve('read').confidence, 'catalog') // 运行时确认过
  assert.equal(resolve('write').key, MOD('tool-fs')) // 目录里有，运行时名册没覆盖 → 仍归属
  assert.equal(resolve('write').confidence, 'catalog-plugin')
})

test('buildAttribution 缺目录直接报错，不静默降级', () => {
  assert.throws(() => buildAttribution({ catalog: null, plugins: [], toolNames: [] }), TypeError)
})

test('normalizePlugins 以 fiber 实时状态判在岗，而不是解释 disabled 原文', () => {
  const plugins = normalizePlugins([
    { options: { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' }, fiber: { state: 2 } },
    // disabled 原文是 `!!js process.platform` 这类表达式，既可能求值为真也可能为假；
    // fiber 已 ACTIVE(2) 说明它在岗，不能因为原文存在就判成禁用（会误伤）。
    { options: { id: 'live', name: '@deepseek-ai/dsh-tool-live', disabled: '!!js process.platform' }, fiber: { state: 2 } },
    // DISPOSED(4) = 已卸载，不作为在岗
    { options: { id: 'gone', name: '@deepseek-ai/dsh-tool-gone' }, fiber: { state: 4 } },
    // FAILED(3) = 回调抛错，没有在提供能力
    { options: { id: 'bad', name: '@deepseek-ai/dsh-tool-bad' }, fiber: { state: 3 } },
    // fiber 不可得时才回退看 disabled 字段
    { options: { id: 'legacy', name: '@deepseek-ai/dsh-tool-legacy', disabled: true } },
    { options: { name: 'no-id' } },
  ])
  assert.equal(plugins.length, 5)
  assert.deepEqual(plugins.map((item) => item.enabled), [true, true, false, false, false])
})

test('normalizeToolNames 接受字符串与 schema 两种形状', () => {
  assert.deepEqual(normalizeToolNames(['read', { name: 'write' }, { description: 'no name' }, null]), ['read', 'write'])
})

test('assignStations 稳定且不硬塞超出容量的员工（MVP-01 / MVP-02）', () => {
  const first = assignStations(['zeta', 'alpha', 'mid'])
  assert.deepEqual(first.byStation.slice(0, 3), ['alpha', 'mid', 'zeta'])
  assert.equal(first.byStation.length, STATION_COUNT)
  assert.equal(first.byStation[3], null)
  assert.equal(first.overflow.length, 0)

  // 新增一个排序靠后的员工，原有三名不跳位
  const grown = assignStations(['zeta', 'alpha', 'mid', 'omega'])
  assert.deepEqual(grown.byStation.slice(0, 4), ['alpha', 'mid', 'omega', 'zeta'])

  // 超出工位容量 → overflow，不覆盖已有工位
  const many = Array.from({ length: STATION_COUNT + 3 }, (_, i) => 'e' + String(i).padStart(2, '0'))
  const overflowed = assignStations(many)
  assert.equal(overflowed.byStation.filter(Boolean).length, STATION_COUNT)
  assert.deepEqual(overflowed.overflow, ['e06', 'e07', 'e08'])
})

test('outcomePayload 只透传引擎认识的判定字段，空错误信息视作没有错误', () => {
  assert.deepEqual(outcomePayload({ isError: true, cancelled: true, junk: 1 }), {
    isError: true,
    cancelled: true,
    signalAborted: false,
    errorMessage: undefined,
  })
  // 成功调用会带 message=''；原样透传会让面板出现悬空的「最近错误：」
  assert.equal(outcomePayload({ isError: false, errorMessage: '' }).errorMessage, undefined)
  assert.equal(outcomePayload({ isError: true, errorMessage: 'ENOENT' }).errorMessage, 'ENOENT')
})

/** 造一份与宿主真实事件同形的状态，用于快照断言。 */
function buildRealisticState() {
  const { resolve, roster } = buildAttribution({
    catalog,
    plugins: [plugin('fs', 'tool-fs'), plugin('search', 'tool-fs-search')],
    toolNames: ['read', 'write', 'glob'],
  })
  const state = createStudio({ resolveEmployee: resolve })
  reduce(state, { type: 'connection', status: CONNECTION.CONNECTED })
  reduce(state, { type: 'roster', plugins: roster })

  const S = 'session-main'
  const SUB = 'subagent-1'
  // 并发：fs 两次成功
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S, at: 1000 })
  reduce(state, { type: 'call-started', callId: 'c2', toolName: 'write', sessionId: S, at: 1010 })
  reduce(state, { type: 'call-finished', callId: 'c1', ...outcomePayload({ isError: false }), at: 1100 })
  // search 失败
  reduce(state, { type: 'call-started', callId: 'c3', toolName: 'glob', sessionId: S, at: 1020 })
  reduce(state, { type: 'call-finished', callId: 'c3', ...outcomePayload({ isError: true, errorMessage: 'ENOENT' }), at: 1150 })
  // fs 取消（与失败分开统计）
  reduce(state, { type: 'call-started', callId: 'c4', toolName: 'read', sessionId: S, at: 1030 })
  reduce(state, { type: 'call-finished', callId: 'c4', ...outcomePayload({ isError: true, cancelled: true, errorMessage: 'tool call aborted' }), at: 1160 })
  // 子代理独立会话
  reduce(state, { type: 'call-started', callId: 'c5', toolName: 'glob', sessionId: SUB, at: 1040 })
  // 「进入时已中止」：只有结果，没有开始
  reduce(state, { type: 'call-result-only', callId: 'c6', toolName: 'read', sessionId: S, ...outcomePayload({ isError: true, cancelled: true, errorMessage: 'tool call aborted before dispatch' }), at: 1170 })
  return { state, S, SUB }
}

test('lastOutcomeOf 取该员工最近一次已结束调用，不把运行中的算进去', () => {
  const { state, S } = buildRealisticState()
  const fs = lastOutcomeOf(state, S, MOD('tool-fs'))
  assert.equal(fs.outcome, 'cancelled')
  assert.equal(fs.toolName, 'read')
  assert.equal(lastOutcomeOf(state, S, 'nobody'), null)
})

test('buildSnapshot 输出纯 JSON 且如实反映并发、失败、取消、外包', () => {
  const { state, S, SUB } = buildRealisticState()
  const rosterKeys = [...state.roster.keys()]
  const assignment = assignStations(rosterKeys, STATION_COUNT)
  const snapshot = buildSnapshot(state, { assignment, activeSession: S, now: 2000 })

  // 必须能原样过 JSON 通道：Map / Set 进不来
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.connection, 'connected')
  assert.equal(snapshot.activeSession, S)

  const employees = snapshot.sessions[S].employees
  const fs = employees.find((item) => item.employeeKey === MOD('tool-fs'))
  // c2 仍在飞 → 工作中，且当前任务可读
  assert.equal(fs.status, 'working')
  assert.equal(fs.runningCount, 1)
  assert.deepEqual(fs.currentTools, ['write'])
  assert.equal(fs.success, 1)
  // c4（执行中取消）与 c6（进入时已中止）都是取消，且**不计为失败**（§4.8）
  assert.equal(fs.cancelled, 2)
  assert.equal(fs.failure, 0)
  assert.equal(fs.lastError, null)
  assert.equal(typeof fs.desk, 'number')

  const search = employees.find((item) => item.employeeKey === MOD('tool-fs-search'))
  assert.equal(search.status, 'idle')
  assert.equal(search.failure, 1)
  assert.equal(search.lastError, 'ENOENT')
  assert.equal(search.lastOutcome.outcome, 'failure')

  // 「进入时已中止」不虚构开始时间：c6 只有结果，started 只算 c1/c2/c4
  assert.equal(fs.started, 3)

  // 子代理会话独立分桶，不与主会话串线
  assert.equal(snapshot.sessions[SUB].employees.find((e) => e.employeeKey === MOD('tool-fs-search')).runningCount, 1)
  assert.equal(snapshot.sessions[SUB].employees.find((e) => e.employeeKey === MOD('tool-fs')).started, 0)

  // 外包：没有归属工具时落 unassigned，不伪装成某个插件
  const other = createStudio({ resolveEmployee: () => null })
  reduce(other, { type: 'roster', plugins: rosterKeys.map((key) => ({ entryId: key, moduleName: null })) })
  reduce(other, { type: 'call-started', callId: 'x1', toolName: 'mystery', sessionId: S, at: 1 })
  const otherSnap = buildSnapshot(other, { assignment: assignStations(rosterKeys), now: 2 })
  const unassigned = otherSnap.sessions[S].employees.find((item) => item.employeeKey === UNASSIGNED_EMPLOYEE)
  assert.equal(unassigned.desk, null)
  assert.equal(unassigned.runningCount, 1)
  assert.deepEqual(otherSnap.unassignedTools, { mystery: 1 })
})

test('buildSnapshot 在断开连接时标未知，不把员工判成完成或待机（§5 用例 6）', () => {
  const { state, S } = buildRealisticState()
  reduce(state, { type: 'connection', status: CONNECTION.DISCONNECTED })
  const snapshot = buildSnapshot(state, { assignment: assignStations([...state.roster.keys()]), now: 2000 })
  for (const employee of snapshot.sessions[S].employees) {
    assert.equal(employee.status, 'unknown')
  }
})
