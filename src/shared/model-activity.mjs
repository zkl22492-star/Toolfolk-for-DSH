/**
 * 模型活动累积器（"思维流"数据层）
 *
 * 目的：把**模型自己的**工作过程也变成工作室里看得见的东西——不是只有插件在干活。
 * 依据 docs/integration-findings.md §4.11（本轮实测确认的可用事件）。
 *
 * 数据来源（全部是官方事件，只读，不改调用链）：
 *   1. `agent/assistant-stream`（宿主 Cordis 事件，agent 作用域）
 *      → 实时增量：`reasoning-delta`（思维）/ `text-delta`（编写）/
 *        `tool-call-delta`（派活）/ `usage`（token 计数）/ `finish`
 *   2. `session/event`（持久事实）→ 边界与失败：
 *      `turn/start` / `turn/end` / `step/start`（一次模型调用）/ `step/end` /
 *      `assistant/message`（带最终 stream 与 usage）/ `assistant/attempt`（失败、重试、取消）
 *
 * 诚实约束（产品文档第二原则）：
 *   - 阶段（thinking / writing / calling）**只由真实到过的增量块决定**，且有衰减窗口；
 *     窗口过后回到 idle，不"保持思考中"假装模型还在想。
 *   - `usage` 只在适配器真的上报时才存在（源码明确 `usage` 可缺失）→ 缺失就报未知，不补零。
 *   - 文本尾巴只截取真实输出，不生成、不润色。
 */

/** 模型的工作阶段。`idle` 表示"这段时间没有模型活动"。 */
export const MODEL_PHASE = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  WRITING: 'writing',
  CALLING: 'calling',
  RETRYING: 'retrying',
})

/** 最后一个增量块到"阶段回落 idle"的保持时长。 */
export const PHASE_HOLD_MS = 1500
/** 文本尾巴保留的字符数（只用于展示，不是完整内容）。 */
export const TAIL_LIMIT = 240

const PHASE_OF_KIND = {
  reasoning: MODEL_PHASE.THINKING,
  text: MODEL_PHASE.WRITING,
  'tool-call': MODEL_PHASE.CALLING,
}

export function createModelActivity(options = {}) {
  return {
    /** 当前轮次 / 步骤（step = 一次模型调用 + 它请求的工具执行）。 */
    turn: null,
    step: null,
    /** 最近一次增量块的类别：'reasoning' | 'text' | 'tool-call' | 'usage' | 'finish'。 */
    lastKind: null,
    lastChunkAt: null,
    /** 本会话累计的字符数（真实计数，非估算）。 */
    reasoningChars: 0,
    textChars: 0,
    toolCallChars: 0,
    toolCallIds: [],
    blockCount: 0,
    /** 最近一次 usage（适配器未上报时为 null——不补零）。 */
    usage: null,
    /** 会话累计 token（只累加真实上报过的字段）。 */
    totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    usageReports: 0,
    /** 失败与重试（来自 assistant/attempt）。 */
    attempts: 0,
    retrying: false,
    lastFailureAt: null,
    /**
     * 最近一次"交付"：模型把话说完、这一轮结算后要摊给用户看的那份东西。
     * 内容取自 `assistant/message` 的正文（text 块），性质取自 `turn/end` 的 reason。
     */
    delivery: null,
    /**
     * 本轮的**待交付**正文。
     *
     * 为什么需要它：`assistant/message` 是**每个 step** 都会发的（一次回答可能多步），
     * 若每步都交付，用户一次提问会掉出好几张纸（实测确认）。所以每步只覆盖暂存，
     * **等 `turn/end` 才真正交付一份**——这才对得上"回答完后给你一张纸"。
     */
    pendingDelivery: null,
    /**
     * 历史交付（新的在前）。"汇报记录"要像一叠 A4 —— 得留下过去那些纸，
     * 只保留最近 N 份；最新的那份给全文，更早的在快照里截断并标注（见 modelSnapshot）。
     */
    deliveries: [],
    deliveryHistoryLimit: options.deliveryHistoryLimit ?? 10,
    /** 最近一次轮次结束的原因（completed / max-tokens / aborted / error / blocked / interrupted）。 */
    lastTurnEnd: null,
    /** 交付正文在快照里的截断上限（字符）。 */
    // 交付正文在快照里的上限：放宽到 3 万字，纸面才滚得动；
    // 真正画布装不下的部分由 layoutDelivery 再截一次并在页脚写明（见客户端）。
    deliveryLimit: options.deliveryLimit ?? 30000,
    /** 完成的轮次计数。 */
    turnsCompleted: 0,
    stepsCompleted: 0,
    finishReason: null,
    /** 文本尾巴（只保留末尾若干字符）。 */
    reasoningTail: '',
    textTail: '',
    /**
     * 自上次工具调用以来累积的思维文本。
     *
     * 用途：把**模型的想法归属到某一次具体的调用**——推理发生在调用之前，
     * 所以"调用发生时取走这段缓冲"就得到这次任务对应的思维流。
     * 这样每个正在干活的员工头顶显示的是他自己那件事的想法，而不是一份公共文本。
     */
    pendingThought: '',
    /** 上次取思维时的正文字数：退回正文当思维时用来判断"有没有新内容"，避免同一段被算到两次调用 */
    textCharsAtLastTake: 0,
    tailLimit: options.tailLimit ?? TAIL_LIMIT,
    now: options.now ?? (() => Date.now()),
  }
}

/** 从 AssistantMessage 的 content 块里取**正文**（只看 text 块，不取推理、不取工具调用）。 */
export function assistantTextOf(message) {
  if (message === null || message === undefined) return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && block !== undefined && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n\n').trim()
}

function appendTail(previous, addition, limit) {
  const merged = previous + addition
  return merged.length > limit ? merged.slice(merged.length - limit) : merged
}

function addUsage(activity, usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return false
  activity.usage = usage
  activity.usageReports += 1
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) activity.totals[key] += value
  }
  return true
}

/**
 * 归约一个实时增量块（`agent/assistant-stream` 的 `frame.chunk`）。
 * 未知类型一律忽略——不去猜它的含义。
 */
export function applyStreamChunk(activity, chunk, at = activity.now()) {
  if (chunk === null || chunk === undefined || typeof chunk.type !== 'string') {
    return { changed: false, reason: 'invalid-chunk' }
  }
  switch (chunk.type) {
    case 'reasoning-delta': {
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      activity.reasoningChars += text.length
      activity.reasoningTail = appendTail(activity.reasoningTail, text, activity.tailLimit)
      // 同时攒进"待归属"缓冲（上限防止长时间无调用时无限增长）
      activity.pendingThought = appendTail(activity.pendingThought, text, 4000)
      activity.lastKind = 'reasoning'
      activity.lastChunkAt = at
      // 重试真的开始产出内容了 → 不再是"重试中"
      activity.retrying = false
      return { changed: true, kind: 'reasoning', chars: text.length }
    }
    case 'text-delta': {
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      activity.textChars += text.length
      activity.textTail = appendTail(activity.textTail, text, activity.tailLimit)
      activity.lastKind = 'text'
      activity.lastChunkAt = at
      activity.retrying = false
      return { changed: true, kind: 'text', chars: text.length }
    }
    case 'tool-call-delta': {
      const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
      activity.toolCallChars += delta.length
      if (typeof chunk.id === 'string' && !activity.toolCallIds.includes(chunk.id)) {
        activity.toolCallIds.push(chunk.id)
      }
      activity.lastKind = 'tool-call'
      activity.lastChunkAt = at
      activity.retrying = false
      return { changed: true, kind: 'tool-call' }
    }
    case 'usage':
      activity.lastChunkAt = at
      activity.lastKind = 'usage'
      return { changed: addUsage(activity, chunk.usage), kind: 'usage' }
    case 'block-start':
      activity.blockCount += 1
      activity.lastChunkAt = at
      return { changed: true, kind: 'block-start', blockType: chunk.blockType }
    case 'block-end':
    case 'finish':
      if (chunk.type === 'finish') activity.finishReason = chunk.reason ?? null
      activity.lastKind = 'finish'
      activity.lastChunkAt = at
      return { changed: true, kind: chunk.type }
    default:
      return { changed: false, reason: 'unknown-chunk-type' }
  }
}

/**
 * 归约一个持久会话事件里与模型相关的部分。
 * 只认识明确列出的类型；其余（request/header、compaction 等）不参与。
 */
export function applyModelSessionEvent(activity, type, data, at = activity.now()) {
  const payload = data ?? {}
  switch (type) {
    case 'turn/start':
      activity.turn = payload.turn ?? activity.turn
      // 新的一轮开始：清掉上一轮的失败标记，但**保留累计计数**
      activity.retrying = false
      return { changed: true, kind: 'turn-start' }
    case 'turn/end': {
      activity.turnsCompleted += 1
      activity.retrying = false
      const kind = payload.reason && typeof payload.reason.kind === 'string' ? payload.reason.kind : 'unknown'
      activity.lastTurnEnd = { kind, at }
      // 轮次结束才交付：把本轮最后一步的正文落成一份，并如实标上结束性质
      let committed = false
      if (activity.pendingDelivery !== null) {
        const entry = activity.pendingDelivery
        entry.reasonKind = kind
        entry.completed = kind === 'completed'
        activity.delivery = entry
        activity.deliveries.unshift(entry)
        if (activity.deliveries.length > activity.deliveryHistoryLimit) {
          activity.deliveries.length = activity.deliveryHistoryLimit
        }
        activity.pendingDelivery = null
        committed = true
      }
      return { changed: true, kind: 'turn-end', reasonKind: kind, committed }
    }
    case 'step/start':
      activity.step = payload.step ?? activity.step
      if (payload.turn !== undefined) activity.turn = payload.turn
      // 模型调用已发出：先记为"思考中"，随后的增量块会把阶段细化
      activity.lastKind = 'reasoning'
      activity.lastChunkAt = at
      return { changed: true, kind: 'step-start' }
    case 'step/end':
      activity.stepsCompleted += 1
      return { changed: true, kind: 'step-end' }
    case 'assistant/message': {
      // 结算事件：带最终 usage（可能没有）与完整 stream。
      // 实时增量已计过字符，这里**不重复累加**，只补 usage + 抽取"交付正文"。
      activity.lastKind = 'finish'
      activity.lastChunkAt = at
      const used = addUsage(activity, payload.usage)
      const text = assistantTextOf(payload.message)
      if (text.length === 0) return { changed: used, kind: 'assistant-message' }
      const entry = {
        text: text.length > activity.deliveryLimit ? text.slice(0, activity.deliveryLimit) : text,
        chars: text.length,
        truncated: text.length > activity.deliveryLimit,
        turn: payload.turn ?? activity.turn,
        step: payload.step ?? activity.step,
        interrupted: payload.interrupted === true,
        at,
        // 结束时才补上（turn/end 可能稍后到达）
        reasonKind: null,
      }
      // 只暂存：多步回答里，中间步骤的正文不该各自成为一份"交付"
      activity.pendingDelivery = entry
      return { changed: true, kind: 'delivery-pending', chars: text.length }
    }
    case 'assistant/attempt':
      // 失败 / 重试 / 中途取消：这一轮没有形成模型可见历史。
      activity.attempts += 1
      activity.retrying = true
      activity.lastFailureAt = at
      return { changed: true, kind: 'assistant-attempt' }
    default:
      return { changed: false, reason: 'irrelevant-event' }
  }
}

/**
 * 取走"这次调用对应的思维"。
 *
 * 模型是**先想后调**：推理增量在工具调用之前到达，所以工具调用开始的那一刻，
 * 把自上次调用以来累积的思维取走，就得到这一次任务对应的想法。
 * 取走即清空，避免同一段思维被算到两次调用头上。没有思维时退回正文尾巴。
 * @returns {string|null} 截断后的思维文本；实在没有就返回 null（不编）
 */
export function takeThoughtForCall(activity, limit = 180) {
  let source = activity.pendingThought
  activity.pendingThought = ''
  if (source.length === 0) {
    // 没有推理 → 退回正文。但只在正文确实**有新内容**时才用，
    // 否则同一段正文会被反复算到后续每一次调用头上。
    if (activity.textChars <= activity.textCharsAtLastTake) return null
    activity.textCharsAtLastTake = activity.textChars
    source = activity.textTail
  }
  const flat = String(source).replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  return flat.length > limit ? '…' + flat.slice(flat.length - limit) : flat
}

/** 由"最近一个增量块的类别"与保持窗口推出当前阶段。窗口外一律 idle。 */
/**
 * 从**会话的完整事件日志**里提取历史交付（汇报记录的回填来源）。
 *
 * 为什么需要：插件只能实时收到自己启动之后的事件，用户"一直用的那段对话"里的回答一份都拿不到
 * （用户实测："明明有历史对话啊"）。宿主侧的 `Session.snapshotEvents()` 能读到完整日志（含恢复出来的历史），
 * 在这里按 `assistant/message` + 配对的 `turn/end` 还原每一轮的最终答复与结束性质。
 *
 * 纯函数：只吃事件数组，便于测试。进行中（还没等到 turn/end）的那一轮不算历史交付。
 * @param {readonly object[]} events
 * @param {number} limit
 * @param {number} textLimit 单份正文上限（历史不必留全文，撑大快照不划算）
 */
export function harvestDeliveries(events, limit = 12, textLimit = 6000) {
  const pending = new Map()
  const done = []
  for (const event of events ?? []) {
    const type = event === null || event === undefined ? null : event.type
    const data = event === null || event === undefined ? null : event.data
    if (type === 'assistant/message') {
      const text = assistantTextOf(data === null || data === undefined ? null : data.message)
      if (text.length === 0) continue
      const turn = data !== null && data !== undefined && typeof data.turn === 'number' ? data.turn : null
      pending.set(turn, {
        text: text.length > textLimit ? text.slice(0, textLimit) : text,
        chars: text.length,
        truncated: text.length > textLimit,
        turn,
        step: data !== null && data !== undefined && typeof data.step === 'number' ? data.step : null,
        interrupted: data !== null && data !== undefined && data.interrupted === true,
        at: typeof event.time === 'number' ? event.time : null,
        reasonKind: null,
        completed: false,
        historical: true,
      })
    } else if (type === 'turn/end') {
      const turn = data !== null && data !== undefined && typeof data.turn === 'number' ? data.turn : null
      const entry = pending.get(turn)
      if (entry === undefined) continue
      const kind = data !== null && data !== undefined && data.reason !== null && data.reason !== undefined && typeof data.reason.kind === 'string'
        ? data.reason.kind
        : 'unknown'
      entry.reasonKind = kind
      entry.completed = kind === 'completed'
      done.push(entry)
      pending.delete(turn)
    }
  }
  done.sort((a, b) => (b.at === null ? 0 : b.at) - (a.at === null ? 0 : a.at))
  return done.slice(0, limit)
}

/**
 * 把历史交付并进活动记录（按 at + turn 去重，新的在前，超出上限截断）。
 * 注意**不**把它设为"当前交付"——否则用户一打开工作室就会有一张旧纸自动弹出来。
 */
export function seedDeliveries(activity, entries) {
  let added = 0
  const key = (item) => String(item.at === null || item.at === undefined ? '' : item.at) + '#' + String(item.turn === null || item.turn === undefined ? '' : item.turn)
  const existing = new Set(activity.deliveries.map(key))
  for (const entry of entries ?? []) {
    if (entry === null || entry === undefined || typeof entry.text !== 'string' || entry.text.length === 0) continue
    const entryKey = key(entry)
    if (existing.has(entryKey)) continue
    existing.add(entryKey)
    activity.deliveries.push(entry)
    added += 1
  }
  activity.deliveries.sort((a, b) => (b.at === null || b.at === undefined ? 0 : b.at) - (a.at === null || a.at === undefined ? 0 : a.at))
  if (activity.deliveries.length > activity.deliveryHistoryLimit) {
    activity.deliveries.length = activity.deliveryHistoryLimit
  }
  return added
}

export function modelPhaseOf(activity, now = activity.now(), holdMs = PHASE_HOLD_MS) {
  if (activity.retrying) return MODEL_PHASE.RETRYING
  if (activity.lastChunkAt === null) return MODEL_PHASE.IDLE
  if (now - activity.lastChunkAt > holdMs) return MODEL_PHASE.IDLE
  return PHASE_OF_KIND[activity.lastKind] ?? MODEL_PHASE.IDLE
}

/** 可序列化的模型活动快照（客户端读这个）。 */
export function modelSnapshot(activity, now = activity.now()) {
  return {
    phase: modelPhaseOf(activity, now),
    turn: activity.turn,
    step: activity.step,
    reasoningChars: activity.reasoningChars,
    textChars: activity.textChars,
    toolCallChars: activity.toolCallChars,
    toolCallCount: activity.toolCallIds.length,
    blockCount: activity.blockCount,
    // usage 缺失就是 null：不把未知写成 0
    usage: activity.usage,
    totals: { ...activity.totals },
    usageReports: activity.usageReports,
    attempts: activity.attempts,
    retrying: activity.retrying,
    turnsCompleted: activity.turnsCompleted,
    stepsCompleted: activity.stepsCompleted,
    finishReason: activity.finishReason,
    reasoningTail: activity.reasoningTail,
    textTail: activity.textTail,
    // 交付：内容 + 性质（kind 为 null 表示 turn/end 还没到）
    delivery: activity.delivery,
    // 历史交付：最新一份给全文，更早的截断到 4000 字并标记 abridged（快照体积可控）
    deliveries: activity.deliveries.map((item, index) => {
      const abridge = index > 0 && item.text.length > 4000
      return {
        at: item.at,
        turn: item.turn,
        chars: item.chars,
        truncated: item.truncated,
        interrupted: item.interrupted,
        reasonKind: item.reasonKind ?? null,
        completed: item.reasonKind === 'completed',
        abridged: abridge,
        text: abridge ? item.text.slice(0, 4000) : item.text,
      }
    }),
    lastTurnEnd: activity.lastTurnEnd,
    lastChunkAt: activity.lastChunkAt,
  }
}
