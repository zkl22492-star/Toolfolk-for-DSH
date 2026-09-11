/**
 * 状态引擎用例（M2）
 *
 * 用例表直接抄自 docs/开发规划.md 第 5 节「M2：让状态可信」的交付与验收表，
 * 一条不落；另加几条由 M1 实测结论推出的边界用例。
 *
 * 运行：node tests/state/state-engine.test.mjs
 * （用 Node 内置 node:test，无第三方依赖）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONNECTION,
  OUTCOME,
  UNASSIGNED_EMPLOYEE,
  createStudio,
  employeesOf,
  outcomeOf,
  reduce,
  snapshot,
} from '../../packages/studio-panel/src/shared/state-engine.mjs'

const S1 = 'session-aaa'
const S2 = 'session-bbb'

/** 固定时钟，避免用例依赖真实时间。 */
function clock(start = 1_000_000) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/** 一个简单的归属解析器：fs 系列工具归 tool-fs，其余归 tool-other。 */
function resolver(toolName) {
  if (['read', 'write', 'edit'].includes(toolName)) {
    return { key: 'tool-fs', label: '档案管理员', confidence: 'exact' }
  }
  if (['glob', 'grep'].includes(toolName)) {
    return { key: 'tool-fs-search', label: '检索员', confidence: 'exact' }
  }
  return null // 故意让部分工具无法归属，验证"未归属"诚实路径
}

function studio() {
  const time = clock()
  const state = createStudio({ resolveEmployee: resolver, now: time.now })
  reduce(state, { type: 'connection', status: CONNECTION.CONNECTED })
  reduce(state, {
    type: 'roster',
    plugins: [
      { entryId: 'tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs' },
      { entryId: 'tool-fs-search', moduleName: '@deepseek-ai/dsh-tool-fs-search' },
    ],
  })
  return { state, time }
}

test('session counters and activity remain isolated after completion', () => {
  const { state, time } = studio()
  reduce(state, { type: 'call-started', callId: 'a', toolName: 'read', sessionId: S1 })
  const saved = snapshot(state, S1)
  reduce(state, { type: 'call-finished', callId: 'a', isError: false })
  assert.equal(state.sessionStats.get(S1).running, 0)
  assert.equal(saved.sessionStats[S1].running, 1)
  const employee = (id, options) => employeesOf(state, id, options).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(employee(S1).started, 1)
  assert.equal(employee(S1).activity, 1)
  assert.equal(employee(S2).activity, 0)
  assert.equal(employee(S1, { now: time.now() + 31000 }).activity, 0)
})

test('result-only events preserve an aborted signal without error text', () => {
  const { state } = studio()
  reduce(state, { type: 'call-finished', callId: 'aborted', toolName: 'read', sessionId: S1, signalAborted: true, isError: true })
  assert.equal(state.calls.get('aborted').outcome, OUTCOME.CANCELLED)
  assert.equal(state.sessionStats.get(S1).running, 0)
})

// ─────────────────────────────────────────────────────────────
// 规划第 5 节用例表
// ─────────────────────────────────────────────────────────────

test('用例1：三个并发调用完成一个 → 员工仍工作，运行数变为两个', () => {
  const { state, time } = studio()
  for (const callId of ['c1', 'c2', 'c3']) {
    reduce(state, { type: 'call-started', callId, toolName: 'read', sessionId: S1 })
  }
  let fs = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(fs.runningCount, 3, '三个调用应同时在飞')
  assert.equal(fs.status, 'working')

  reduce(state, { type: 'call-finished', callId: 'c1', isError: false, at: time.now() })

  fs = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(fs.runningCount, 2, '完成一个后仍有两个在飞')
  assert.equal(fs.status, 'working', '仍有调用在跑，必须保持工作状态')
  assert.equal(fs.success, 1)
})

test('用例2：一个调用失败、另一个继续 → 继续工作并保留局部错误提示', () => {
  const { state, time } = studio()
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  reduce(state, { type: 'call-started', callId: 'c2', toolName: 'read', sessionId: S1 })

  reduce(state, {
    type: 'call-finished',
    callId: 'c1',
    isError: true,
    errorMessage: 'cannot read "x": not found',
    at: time.now(),
  })

  let fs = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(fs.status, 'working', '另一个调用仍在执行，不能因为一次失败就停下')
  assert.equal(fs.runningCount, 1)
  assert.equal(fs.failure, 1)
  assert.match(fs.lastError, /not found/, '局部错误提示必须保留')

  reduce(state, { type: 'call-finished', callId: 'c2', isError: false, at: time.now() })
  fs = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(fs.status, 'idle')
  assert.match(fs.lastError, /not found/, '错误提示不应因后续成功而消失')
})

test('用例3：同一完成通知到达两次 → 调用次数与结果不重复计算', () => {
  const { state, time } = studio()
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  reduce(state, { type: 'call-finished', callId: 'c1', isError: false, at: time.now() })
  const second = reduce(state, { type: 'call-finished', callId: 'c1', isError: false, at: time.now() })

  assert.equal(second.changed, false)
  assert.equal(second.reason, 'duplicate-finish')
  assert.equal(state.stats.success, 1, '成功计数不得翻倍')
  assert.equal(state.stats.started, 1)
  assert.equal(state.stats.duplicateIgnored, 1)

  // 重复的开始通知同样不计数
  const dupStart = reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  assert.equal(dupStart.reason, 'duplicate-start')
  assert.equal(state.stats.started, 1)
})

test('用例4：开始事件缺失，先收到结束事件 → 保留结果但不虚构开始时间', () => {
  const { state, time } = studio()
  reduce(state, {
    type: 'call-finished',
    callId: 'orphan-1',
    toolName: 'read',
    sessionId: S1,
    isError: true,
    errorMessage: 'tool call aborted before dispatch',
    at: time.now(),
  })

  const record = state.calls.get('orphan-1')
  assert.ok(record, '结果必须被保留，不能丢弃')
  assert.equal(record.startMissing, true)
  assert.equal(record.startedAt, null, '**不得虚构开始时间**')
  assert.equal(record.outcome, OUTCOME.CANCELLED, '该消息属于取消，不是普通失败')

  const fs = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(fs.cancelled, 1)
  assert.equal(fs.failure, 0, '取消不得计入失败')
})

test('用例5：用户取消调用 → 单独记录取消，不计为成功（也不计为失败）', () => {
  const { state, time } = studio()
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  const outcome = outcomeOf({ isError: true, errorMessage: 'tool call aborted' })
  reduce(state, {
    type: 'call-finished',
    callId: 'c1',
    isError: true,
    signalAborted: true,
    errorMessage: 'tool call aborted',
    at: time.now(),
  })

  assert.equal(outcome, OUTCOME.CANCELLED)
  assert.equal(state.stats.cancelled, 1)
  assert.equal(state.stats.success, 0, '取消绝不能算成功')
  assert.equal(state.stats.failure, 0, '取消也不该算失败——两者必须分开统计')

  const fs = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(fs.cancelled, 1)
  assert.equal(fs.lastError, null, '取消不应写成错误提示')
})

test('用例6：断开数据连接 → 显示未知，不把员工全部改成完成/待机', () => {
  const { state, time } = studio()
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  reduce(state, { type: 'connection', status: CONNECTION.DISCONNECTED })

  const list = employeesOf(state, S1)
  assert.ok(list.length > 0)
  for (const employee of list) {
    assert.equal(employee.status, 'unknown', '断线时必须为未知，不能假装知道')
  }
  // 断线期间继续收到事件也不该把状态说成已完成
  reduce(state, { type: 'call-finished', callId: 'c1', isError: false, at: time.now() })
  assert.equal(state.calls.get('c1').outcome, OUTCOME.SUCCESS, '结果本身照常记录')
  for (const employee of employeesOf(state, S1)) {
    assert.equal(employee.status, 'unknown')
  }
})

test('用例7：重新连接 → 依据权威基线恢复，旧快照与新事件不交叉污染', () => {
  const { state, time } = studio()
  reduce(state, { type: 'call-started', callId: 'old-1', toolName: 'read', sessionId: S1 })
  reduce(state, { type: 'call-finished', callId: 'old-1', isError: false, at: time.now() })
  reduce(state, { type: 'connection', status: CONNECTION.DISCONNECTED })

  // 重建：调用方用一份权威快照替换调用集合，再接收增量
  const authoritative = createStudio({ resolveEmployee: resolver, now: state.now })
  reduce(authoritative, { type: 'connection', status: CONNECTION.CONNECTED })
  reduce(authoritative, { type: 'roster', plugins: [{ entryId: 'tool-fs' }] })
  reduce(authoritative, { type: 'call-started', callId: 'fresh-1', toolName: 'read', sessionId: S1 })
  reduce(authoritative, { type: 'call-finished', callId: 'fresh-1', isError: false, at: time.now() })

  const fresh = employeesOf(authoritative, S1)
  const fs = fresh.find((e) => e.employeeKey === 'tool-fs')
  assert.equal(fs.runningCount, 0)
  assert.equal(fs.success, 1, '恢复后只应看到基线里的那一次成功')
  assert.equal(authoritative.calls.has('old-1'), false, '旧快照的调用不得混入')
  assert.equal(authoritative.stats.started, 1)
})

test('用例8：同名工具跨会话运行 → 员工活动与统计不串线', () => {
  const { state, time } = studio()
  // 父会话跑 read，子代理会话也跑 read（子代理 = 独立会话，见 §4.5）
  reduce(state, { type: 'call-started', callId: 'p1', toolName: 'read', sessionId: S1 })
  reduce(state, { type: 'call-started', callId: 'p2', toolName: 'read', sessionId: S1 })
  reduce(state, { type: 'call-started', callId: 'k1', toolName: 'read', sessionId: S2 })

  const parent = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')
  const child = employeesOf(state, S2).find((e) => e.employeeKey === 'tool-fs')
  assert.equal(parent.runningCount, 2, '父会话只看自己的两个')
  assert.equal(child.runningCount, 1, '子会话只看自己的一个')

  reduce(state, { type: 'call-finished', callId: 'k1', isError: false, at: time.now() })
  assert.equal(
    employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs').runningCount,
    2,
    '子会话结束不得影响父会话',
  )
  assert.equal(employeesOf(state, S2).find((e) => e.employeeKey === 'tool-fs').success, 1)

  const stats = Object.fromEntries(state.sessionStats)
  assert.equal(stats[S1].started, 2)
  assert.equal(stats[S2].started, 1)
})

// ─────────────────────────────────────────────────────────────
// 由 M1 实测结论推出的边界用例
// ─────────────────────────────────────────────────────────────

test('边界：工具失败不抛异常，成败只看返回值（§4.3）', () => {
  const { state, time } = studio()
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  // 注册表正常 resolve，只是 result.isError 为 true —— 引擎必须据此判失败
  reduce(state, {
    type: 'call-finished',
    callId: 'c1',
    isError: true,
    errorMessage: 'cannot read "x": not found',
    at: time.now(),
  })
  assert.equal(state.calls.get('c1').outcome, OUTCOME.FAILURE)
  assert.equal(state.stats.failure, 1)
  assert.equal(state.stats.success, 0)
})

test('边界：无法归属的工具显示为外包组，不伪装成已识别插件（§4.6.5）', () => {
  const { state } = studio()
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'mystery_tool', sessionId: S1 })
  reduce(state, { type: 'call-started', callId: 'c2', toolName: 'mystery_tool', sessionId: S1 })

  const list = employeesOf(state, S1)
  const unassigned = list.find((e) => e.employeeKey === UNASSIGNED_EMPLOYEE)
  assert.ok(unassigned, '必须有外包组工位')
  assert.equal(unassigned.label, '外包组')
  assert.equal(unassigned.runningCount, 2)
  assert.equal(state.unassignedTools.get('mystery_tool'), 2, '未归属工具要被记账')

  // 名册上的员工**应当**出现（= 在岗但没活儿干，产品要求看得到），
  // 但认不出的工具绝不能被算到他们头上。
  const fs = list.find((e) => e.employeeKey === 'tool-fs')
  assert.ok(fs, '在岗员工应出现在列表里（idle，零活动）')
  assert.equal(fs.runningCount, 0, '**不得把认不出的工具塞给某个已知员工**')
  assert.equal(fs.started, 0)
  assert.equal(fs.status, 'idle')
})

test('边界：活动强度只由真实在飞数与近期完成量驱动，不随机（§4.4 / 产品第二原则）', () => {
  const { state } = studio()
  const before = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs')?.activity ?? 0
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  const during = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs').activity
  assert.ok(during > before, '有调用在飞时活动强度必须上升')
  reduce(state, { type: 'call-finished', callId: 'c1', isError: false })
  const after = employeesOf(state, S1).find((e) => e.employeeKey === 'tool-fs').activity
  assert.ok(after < during, '调用结束后活动强度必须回落')
})

test('边界：插件从名册消失 = 离职，标记 enabled=false 但保留历史', () => {
  const { state } = studio()
  reduce(state, { type: 'call-started', callId: 'c1', toolName: 'read', sessionId: S1 })
  reduce(state, { type: 'call-finished', callId: 'c1', isError: false })

  reduce(state, { type: 'roster', plugins: [{ entryId: 'tool-fs' }] }) // tool-fs-search 消失
  assert.equal(state.roster.get('tool-fs-search').enabled, false, '应标记为离职')
  assert.equal(state.calls.get('c1').employeeKey, 'tool-fs', '历史记录保留，不回溯改写')
})

test('边界：无效事件与缺失标识不污染状态', () => {
  const { state } = studio()
  const before = JSON.stringify(state.stats)
  assert.equal(reduce(state, null).changed, false)
  assert.equal(reduce(state, {}).changed, false)
  assert.equal(reduce(state, { type: 'nope' }).changed, false)
  assert.equal(reduce(state, { type: 'call-started', toolName: 'read' }).reason, 'missing-callId')
  assert.equal(JSON.stringify(state.stats), before, '坏事件不得改动统计')
})
