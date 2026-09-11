/**
 * 固定岗位与"正在做什么"用例
 *
 * 用户口径（2026-09-11）：岗位显示的必须是「**正在做某件事**」，不是统计数字；
 * 六个工位职责固定（产品文档原文：工位 = 岗位）。
 *
 * 这里重点验证：文案由**真实参数**推出、拿不到参数时不编细节、未知工具不硬塞进岗位。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  POST_DEFINITIONS,
  buildEventLog,
  buildPosts,
  describeAction,
  parseArguments,
  postIndexOfTool,
  shortenSubject,
} from '../../src/shared/studio-posts.mjs'
import { createStudio, reduce } from '../../src/shared/state-engine.mjs'

test('岗位固定为 6 个，且覆盖四类高频工具', () => {
  assert.equal(POST_DEFINITIONS.length, 6)
  // 顺序必须与房间座位对齐（姿势/道具）：研究 工程 设计 档案 文档 助理
  assert.deepEqual(POST_DEFINITIONS.map((post) => post.key), ['research', 'write', 'web', 'memory', 'exec', 'collab'])
})

test('工具归到岗位；未知工具返回 null，不硬塞', () => {
  assert.equal(postIndexOfTool('read'), 0)
  assert.equal(postIndexOfTool('grep'), 0)
  assert.equal(postIndexOfTool('edit'), 1)
  assert.equal(postIndexOfTool('str_replace_editor'), 1)
  assert.equal(postIndexOfTool('web_search'), 2)
  assert.equal(postIndexOfTool('session_search'), 3)
  assert.equal(postIndexOfTool('pwsh'), 4)
  assert.equal(postIndexOfTool('job_output'), 4)
  assert.equal(postIndexOfTool('subagent'), 5)
  assert.equal(postIndexOfTool('todo_write'), 5)
  // 未收录的工具不能猜
  assert.equal(postIndexOfTool('some_third_party_tool'), null)
  assert.equal(postIndexOfTool(undefined), null)
})

test('"正在做什么"由真实参数推出（对象与 JSON 字符串两种形状）', () => {
  assert.equal(describeAction('read', { file_path: 'L:/p/src/shared/a.mjs' }), '正在翻查资料：a.mjs')
  // 会话事件里 arguments 是原始 JSON 字符串
  assert.equal(describeAction('grep', '{"pattern":"TODO","path":"src"}'), '正在翻查资料：TODO')
  assert.equal(describeAction('pwsh', { command: 'ls -la' }), '正在运行命令：ls -la')
  assert.equal(describeAction('edit', { file_path: 'c:/x/bridge.mjs' }), '正在改写文件：bridge.mjs')
  assert.equal(describeAction('web_search', { query: 'deepseek cordis 插件' }), '正在联网调查：deepseek cordis 插件')
  assert.equal(describeAction('session_search', { query: '上次改了什么' }), '正在翻查会话记录：上次改了什么')
})

test('拿不到参数时不编造细节', () => {
  assert.equal(describeAction('read', null), '正在翻查资料…')
  assert.equal(describeAction('read', 'not-json-at-all'), '正在翻查资料…')
  assert.equal(describeAction('read', {}), '正在翻查资料…')
})

test('未收录的工具如实写成"正在执行 <工具名>"，并进未分类', () => {
  const text = describeAction('mystery_tool', { target: 'x' })
  assert.ok(text.startsWith('正在执行 mystery_tool'))
})

test('参数解析：对象原样、JSON 字符串解析、非法输入返回 null', () => {
  assert.deepEqual(parseArguments({ a: 1 }), { a: 1 })
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 })
  assert.equal(parseArguments('[1,2]'), null) // 数组不是参数对象
  assert.equal(parseArguments('{bad'), null)
  assert.equal(parseArguments(null), null)
})

test('主题词截断，路径只留文件名', () => {
  assert.equal(shortenSubject('read', 'L:/a/b/c.mjs'), 'c.mjs')
  assert.equal(shortenSubject('pwsh', 'a'.repeat(80)).length, 43)
})

/** 造一个带真实参数的状态。 */
function stateWith(calls) {
  const resolveEmployee = (toolName) => ({
    key: 'pkg:' + toolName,
    label: toolName,
    moduleName: '@deepseek-ai/dsh-tool-' + toolName,
    confidence: 'catalog',
  })
  const state = createStudio({ resolveEmployee })
  for (const call of calls) {
    reduce(state, { type: 'call-started', ...call })
    if (call.finish !== undefined) reduce(state, { type: 'call-finished', callId: call.callId, ...call.finish })
  }
  return state
}

test('buildPosts：运行中的岗位说出正在做的事，完成的说"刚做完"', () => {
  const state = stateWith([
    { callId: 'c1', toolName: 'read', sessionId: 'S', at: 1000, argumentsPreview: '{"file_path":"L:/p/package.json"}', finish: { isError: false, at: 1100 } },
    { callId: 'c2', toolName: 'web_search', sessionId: 'S', at: 1200, argumentsPreview: '{"query":"cordis 插件"}' },
    { callId: 'c3', toolName: 'mystery_tool', sessionId: 'S', at: 1300, argumentsPreview: '{"x":1}', finish: { isError: false, at: 1350 } },
  ])
  const view = buildPosts(state, 'S')
  const research = view.posts[0]
  const web = view.posts[2]

  // 研究岗：已完成 → 记在"刚做完"，且文案带真实文件名
  assert.equal(research.running.length, 0)
  assert.equal(research.lastFinished.doing, '正在翻查资料：package.json')
  assert.equal(research.success, 1)
  // 承包方：这个岗位上的活是谁在干。用**显示短名**（tool-fs / read），不是包全名
  assert.deepEqual(research.providers, ['read'])

  // 联网岗：仍在跑 → 出现在"正在做"，且文案带真实查询词
  assert.equal(web.running.length, 1)
  assert.equal(web.running[0].doing, '正在联网调查：cordis 插件')

  // 未收录工具 → 未分类，不占岗位
  assert.deepEqual(view.uncategorized, [{ toolName: 'mystery_tool', count: 1, running: 0 }])
  // 没有活干的岗位（例如会话记忆）保持空闲，不产生假数据
  assert.equal(view.posts[3].key, 'memory')
  assert.equal(view.posts[3].running.length, 0)
  assert.equal(view.posts[3].lastFinished, null)
})

test('buildPosts：岗位固定，工位映射按下标一一对应', () => {
  const state = stateWith([
    { callId: 'c1', toolName: 'pwsh', sessionId: 'S', at: 1000, argumentsPreview: '{"command":"ls"}' },
  ])
  const view = buildPosts(state, 'S')
  assert.deepEqual(view.byStation, [null, null, null, null, 'exec', null])
  assert.equal(view.posts.length, 6)
})

test('空闲岗位保持"在岗待命"，不产生假活动', () => {
  const state = stateWith([])
  const view = buildPosts(state, 'S')
  for (const post of view.posts) {
    assert.equal(post.running.length, 0)
    assert.equal(post.lastFinished, null)
    assert.equal(post.started, 0)
  }
})

test('员工日志：按时间倒序，字段如实（缺开始时间则耗时写 null）', () => {
  const state = stateWith([
    { callId: 'c1', toolName: 'read', sessionId: 'S', at: 1000, argumentsPreview: '{"file_path":"L:/p/a.mjs"}', finish: { isError: false, at: 1300 } },
    { callId: 'c2', toolName: 'web_search', sessionId: 'S', at: 2000, argumentsPreview: '{"query":"cordis"}', finish: { isError: true, errorMessage: 'boom', at: 2400 } },
    // 另一会话不应混进日志
    { callId: 'c9', toolName: 'read', sessionId: 'OTHER', at: 2500, finish: { isError: false, at: 2600 } },
    // 「进入时已中止」：只有结果、没有开始 → 耗时为 null
    { callId: 'c3', toolName: 'read', sessionId: 'S', at: 3000 },
  ])
  reduce(state, { type: 'call-result-only', callId: 'c4', toolName: 'read', sessionId: 'S', isError: true, errorMessage: 'aborted', at: 3100 })
  const log = buildEventLog(state, 'S')
  assert.deepEqual(log.map((row) => row.callId), ['c4', 'c3', 'c2', 'c1'])
  assert.equal(log.find((r) => r.callId === 'c1').durationMs, 300)
  assert.equal(log.find((r) => r.callId === 'c1').doing, '翻查资料：a.mjs')
  assert.equal(log.find((r) => r.callId === 'c1').postTitle, '资料检索')
  assert.equal(log.find((r) => r.callId === 'c2').outcome, 'failure')
  assert.equal(log.find((r) => r.callId === 'c2').errorMessage, 'boom')
  assert.equal(log.find((r) => r.callId === 'c3').durationMs, null)
  assert.equal(log.find((r) => r.callId === 'c4').startMissing, true)
  assert.equal(log.find((r) => r.callId === 'c2').postTitle, '联网调查')
})

test('员工日志：超出上限时只留最近的 N 条', () => {
  const calls = []
  for (let i = 0; i < 12; i++) calls.push({ callId: 'k' + i, toolName: 'read', sessionId: 'S', at: 1000 + i, finish: { isError: false, at: 1001 + i } })
  const log = buildEventLog(stateWith(calls), 'S', 5)
  assert.equal(log.length, 5)
  assert.deepEqual(log.map((r) => r.callId), ['k11', 'k10', 'k9', 'k8', 'k7'])
})
