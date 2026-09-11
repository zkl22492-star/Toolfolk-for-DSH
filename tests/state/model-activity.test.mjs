/**
 * 模型活动（思维流）用例
 *
 * 数据源见 docs/integration-findings.md §4.11：
 *   实时 = agent/assistant-stream 的 chunk；持久 = session/event 的 turn/step/assistant 事件。
 *
 * 重点验证「不编造」：阶段只由真实到过的块决定且有衰减；usage 缺失就是未知，不补零；
 * 结算事件不重复累加实时已计过的字符。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_PHASE,
  PHASE_HOLD_MS,
  applyModelSessionEvent,
  applyStreamChunk,
  createModelActivity,
  modelPhaseOf,
  modelSnapshot,
  takeThoughtForCall,
  assistantTextOf,
  harvestDeliveries,
  seedDeliveries,
} from '../../src/shared/model-activity.mjs'

test('实时增量块把阶段依次推成 思考 → 编写 → 派活', () => {
  const activity = createModelActivity()
  assert.equal(modelPhaseOf(activity, 0), MODEL_PHASE.IDLE)

  applyStreamChunk(activity, { type: 'reasoning-delta', index: 0, text: '先看文件' }, 1000)
  assert.equal(modelPhaseOf(activity, 1000), MODEL_PHASE.THINKING)

  applyStreamChunk(activity, { type: 'text-delta', index: 1, text: '好的' }, 1100)
  assert.equal(modelPhaseOf(activity, 1100), MODEL_PHASE.WRITING)

  applyStreamChunk(activity, { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'read', argumentsDelta: '{"file' }, 1200)
  assert.equal(modelPhaseOf(activity, 1200), MODEL_PHASE.CALLING)
  assert.equal(activity.toolCallIds.length, 1)
})

test('阶段有衰减窗口：窗口过后回到 idle，不假装还在想', () => {
  const activity = createModelActivity()
  applyStreamChunk(activity, { type: 'reasoning-delta', index: 0, text: 'x' }, 1000)
  assert.equal(modelPhaseOf(activity, 1000 + PHASE_HOLD_MS), MODEL_PHASE.THINKING)
  assert.equal(modelPhaseOf(activity, 1000 + PHASE_HOLD_MS + 1), MODEL_PHASE.IDLE)
})

test('usage 只在真实上报时存在；缺失写 null，不补零', () => {
  const activity = createModelActivity()
  const before = modelSnapshot(activity, 0)
  assert.equal(before.usage, null)
  assert.equal(before.usageReports, 0)

  applyStreamChunk(activity, { type: 'usage', usage: { inputTokens: 1200, outputTokens: 80, reasoningTokens: 30, cacheReadTokens: 900 } }, 1000)
  const after = modelSnapshot(activity, 1000)
  assert.equal(after.usage.inputTokens, 1200)
  assert.equal(after.totals.inputTokens, 1200)
  assert.equal(after.totals.reasoningTokens, 30)
  assert.equal(after.totals.cacheReadTokens, 900)
  // 没上报过的字段保持 0（累计加法），但"最近一次 usage"如实保留它的形状
  assert.equal(after.totals.cacheWriteTokens, 0)
  assert.equal(after.usage.cacheWriteTokens, undefined)
})

test('结算事件补 usage 但不重复累加实时已计过的字符', () => {
  const activity = createModelActivity()
  applyStreamChunk(activity, { type: 'text-delta', index: 0, text: '四个字' }, 1000)
  applyModelSessionEvent(activity, 'assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 10, outputTokens: 4 } }, 1100)
  assert.equal(activity.textChars, 3)
  assert.equal(activity.totals.outputTokens, 4)
})

test('assistant/attempt 记为失败重试，新内容到达后自动解除', () => {
  const activity = createModelActivity()
  applyModelSessionEvent(activity, 'assistant/attempt', { turn: 1, step: 1, stream: [] }, 1000)
  assert.equal(modelPhaseOf(activity, 1000), MODEL_PHASE.RETRYING)
  assert.equal(activity.attempts, 1)

  // 重试成功、开始产出内容 → 不再是"重试中"
  applyStreamChunk(activity, { type: 'reasoning-delta', index: 0, text: '再来' }, 1100)
  assert.equal(modelPhaseOf(activity, 1100), MODEL_PHASE.THINKING)
  assert.equal(activity.attempts, 1)
})

test('turn/step 边界与完成计数', () => {
  const activity = createModelActivity()
  applyModelSessionEvent(activity, 'turn/start', { turn: 3 }, 1000)
  applyModelSessionEvent(activity, 'step/start', { turn: 3, step: 1 }, 1010)
  assert.equal(activity.turn, 3)
  assert.equal(activity.step, 1)
  // 模型调用已发出 → 先记为思考中
  assert.equal(modelPhaseOf(activity, 1010), MODEL_PHASE.THINKING)
  applyModelSessionEvent(activity, 'step/end', { turn: 3, step: 1 }, 1200)
  applyModelSessionEvent(activity, 'turn/end', { turn: 3, reason: 'stop' }, 1300)
  assert.equal(activity.stepsCompleted, 1)
  assert.equal(activity.turnsCompleted, 1)
})

test('无关事件与未知块类型一律忽略，不污染状态', () => {
  const activity = createModelActivity()
  assert.equal(applyModelSessionEvent(activity, 'request/header', {}, 1).changed, false)
  assert.equal(applyModelSessionEvent(activity, 'tool/result', {}, 1).changed, false)
  assert.equal(applyStreamChunk(activity, { type: 'brand-new-thing' }, 1).changed, false)
  assert.equal(applyStreamChunk(activity, null, 1).changed, false)
  assert.equal(activity.reasoningChars, 0)
  assert.equal(modelPhaseOf(activity, 1), MODEL_PHASE.IDLE)
})

test('快照是纯 JSON，且文本尾巴有长度上限', () => {
  const activity = createModelActivity({ tailLimit: 10 })
  for (let i = 0; i < 5; i++) applyStreamChunk(activity, { type: 'text-delta', index: 0, text: 'abcdef' }, 1000 + i)
  const snapshot = modelSnapshot(activity, 1004)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  assert.equal(snapshot.textTail.length, 10)
  assert.equal(snapshot.textChars, 30) // 计数是完整的，尾巴才是截断的
  assert.ok(snapshot.textTail.endsWith('abcdef'))
})

test('思维按调用归属：先想后调，取走即清空，不重复算到两次调用', () => {
  const activity = createModelActivity()
  applyStreamChunk(activity, { type: 'reasoning-delta', index: 0, text: '先看看 package.json 里写了什么' }, 1000)
  const first = takeThoughtForCall(activity)
  assert.equal(first, '先看看 package.json 里写了什么')
  // 取走后同一段思维不会跑到下一次调用头上
  assert.equal(takeThoughtForCall(activity), null)

  applyStreamChunk(activity, { type: 'reasoning-delta', index: 0, text: '再查一下这个库的用法' }, 2000)
  assert.equal(takeThoughtForCall(activity), '再查一下这个库的用法')
})

test('没有推理时退回正文尾巴；两者都没有就返回 null（不编）', () => {
  const activity = createModelActivity()
  assert.equal(takeThoughtForCall(activity), null)
  applyStreamChunk(activity, { type: 'text-delta', index: 0, text: '我这就去做' }, 1000)
  assert.equal(takeThoughtForCall(activity), '我这就去做')
  assert.equal(takeThoughtForCall(activity), null)
})

test('思维过长时截断，保留末尾（最近的想法）', () => {
  const activity = createModelActivity()
  applyStreamChunk(activity, { type: 'reasoning-delta', index: 0, text: 'x'.repeat(300) }, 1000)
  const thought = takeThoughtForCall(activity, 50)
  assert.equal(thought.length, 51) // 50 + 前导省略号
  assert.ok(thought.startsWith('…'))
})

test('交付：每步只暂存正文，轮次结束才落成一份交付（只取 text 块）', () => {
  const activity = createModelActivity()
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '我先想一下' },
      { type: 'text', text: '第一段结论。' },
      { type: 'tool-call', id: 't1', name: 'read' },
      { type: 'text', text: '第二段补充。' },
    ],
  }
  applyModelSessionEvent(activity, 'assistant/message', { turn: 2, step: 3, message, usage: { outputTokens: 12 } }, 5000)
  // 暂存态：还没交付，历史里也不该出现
  assert.equal(activity.delivery, null)
  assert.equal(activity.pendingDelivery.chars, 14)
  assert.equal(activity.pendingDelivery.turn, 2)
  assert.equal(modelSnapshot(activity, 5000).deliveries.length, 0)

  applyModelSessionEvent(activity, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 5100)
  // 交付态：正文只含 text 块（推理与工具调用都不进纸面）
  assert.equal(activity.delivery.text, ['第一段结论。', '第二段补充。'].join(String.fromCharCode(10, 10)))
  assert.equal(activity.delivery.chars, 14)
  assert.equal(activity.delivery.reasonKind, 'completed')
  assert.equal(modelSnapshot(activity, 5100).deliveries.length, 1)
})

test('交付：turn/end 的 reason 决定性质，只有 completed 才算真的答完', () => {
  const build = (kind) => {
    const activity = createModelActivity()
    applyModelSessionEvent(activity, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好了' }] } }, 1000)
    applyModelSessionEvent(activity, 'turn/end', { turn: 1, reason: { kind } }, 1200)
    return modelSnapshot(activity, 1200)
  }
  assert.equal(build('completed').delivery.completed, true)
  assert.equal(build('max-tokens').delivery.completed, false)
  assert.equal(build('aborted').delivery.completed, false)
  assert.equal(build('error').delivery.completed, false)
  assert.equal(build('completed').lastTurnEnd.kind, 'completed')
})

test('交付：超长正文按上限截断，但字数如实保留', () => {
  const activity = createModelActivity({ deliveryLimit: 20 })
  applyModelSessionEvent(activity, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x'.repeat(100) }] } }, 1000)
  applyModelSessionEvent(activity, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, 1100)
  assert.equal(activity.delivery.text.length, 20)
  assert.equal(activity.delivery.chars, 100)
  assert.equal(activity.delivery.truncated, true)
  // 结束性质如实标注，不假装答完
  assert.equal(activity.delivery.reasonKind, 'max-tokens')
  assert.equal(activity.delivery.completed, false)
})

test('assistantTextOf：没有 text 块时返回空串，不编内容', () => {
  assert.equal(assistantTextOf({ content: [{ type: 'reasoning', text: '只想没说' }] }), '')
  assert.equal(assistantTextOf(null), '')
  assert.equal(assistantTextOf({ content: [] }), '')
})

test('汇报记录：历史交付按时间倒序保留，最新一份给全文、更早的截断并标注', () => {
  const activity = createModelActivity({ deliveryHistoryLimit: 3 })
  for (let i = 0; i < 5; i++) {
    applyModelSessionEvent(activity, 'assistant/message', { turn: i + 1, step: 1, message: { content: [{ type: 'text', text: 'x'.repeat(5000) + ' #' + i }] } }, 1000 + i)
    applyModelSessionEvent(activity, 'turn/end', { turn: i + 1, reason: { kind: 'completed' } }, 1100 + i)
  }
  const snapshot = modelSnapshot(activity, 2000)
  assert.equal(snapshot.deliveries.length, 3)
  // 新的在前
  assert.equal(snapshot.deliveries[0].turn, 5)
  assert.equal(snapshot.deliveries[2].turn, 3)
  // 最新一份不截断，更早的截到 4000 并标注
  assert.equal(snapshot.deliveries[0].abridged, false)
  assert.equal(snapshot.deliveries[1].abridged, true)
  assert.equal(snapshot.deliveries[1].text.length, 4000)
  // 字数如实保留（不是截断后的长度）
  assert.equal(snapshot.deliveries[1].chars, 5003)
  assert.equal(snapshot.deliveries[0].reasonKind, 'completed')
  assert.equal(snapshot.deliveries[0].completed, true)
})

test('交付：一次回答多步，只掉出一张纸（回归：曾每步各掉一张）', () => {
  const activity = createModelActivity()
  const say = (text, step) => applyModelSessionEvent(activity, 'assistant/message', { turn: 1, step, message: { content: [{ type: 'text', text }] } }, 1000 + step)
  say('第一步中间输出', 1)
  say('第二步中间输出', 2)
  say('这是最终回答', 3)
  assert.equal(activity.deliveries.length, 0)
  applyModelSessionEvent(activity, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 2000)
  const snapshot = modelSnapshot(activity, 2000)
  assert.equal(snapshot.deliveries.length, 1)
  assert.equal(snapshot.deliveries[0].text, '这是最终回答')
})

test('回填：从完整会话日志还原每轮答复与结束性质（进行中的那轮不算）', () => {
  const events = [
    { type: 'assistant/message', time: 1000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一轮中间的废话' }] } } },
    { type: 'assistant/message', time: 1100, data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '第一轮最终答复' }] } } },
    { type: 'turn/end', time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'assistant/message', time: 2000, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二轮被截断了' }] } } },
    { type: 'turn/end', time: 2100, data: { turn: 2, reason: { kind: 'max-tokens' } } },
    // 进行中：只有 assistant/message、还没 turn/end
    { type: 'assistant/message', time: 3000, data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '这轮还没结束' }] } } },
  ]
  const entries = harvestDeliveries(events)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].turn, 2)
  assert.equal(entries[0].text, '第二轮被截断了')
  assert.equal(entries[0].completed, false)
  assert.equal(entries[0].reasonKind, 'max-tokens')
  assert.equal(entries[1].text, '第一轮最终答复')
  assert.equal(entries[1].completed, true)
  assert.equal(entries[1].historical, true)
})

test('回填：合并去重、按时间倒序、不抢占"当前交付"', () => {
  const activity = createModelActivity({ deliveryHistoryLimit: 3 })
  const added = seedDeliveries(activity, [
    { at: 100, turn: 1, text: '旧的' },
    { at: 300, turn: 3, text: '最新的' },
    { at: 200, turn: 2, text: '中间的' },
  ])
  assert.equal(added, 3)
  assert.deepEqual(activity.deliveries.map((item) => item.turn), [3, 2, 1])
  // 不设为"当前交付"：否则一打开工作室就会自动弹出一张旧纸
  assert.equal(activity.delivery, null)
  // 重复回填不重复计数
  assert.equal(seedDeliveries(activity, [{ at: 300, turn: 3, text: '最新的' }]), 0)
  // 上限生效
  seedDeliveries(activity, [{ at: 400, turn: 4, text: 'x' }, { at: 500, turn: 5, text: 'y' }])
  assert.equal(activity.deliveries.length, 3)
})
