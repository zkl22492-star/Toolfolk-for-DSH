/**
 * 工作室状态引擎（M2）
 *
 * 职责：把 M1 实测得到的调用事件，固化成**可信的员工状态与统计**。
 * 纯逻辑：不依赖渲染、不依赖宿主，输入输出都是普通数据，可重复验证。
 *
 * 设计依据（全部来自 docs/integration-findings.md 的实测结论）：
 *
 *   §4.3  工具失败**不抛异常**，以 `result.isError` 表达 → 成败必须看返回值
 *   §4.8  取消与失败都返回 `isError: true`，**必须分开统计**（产品文档 30.5-3）
 *   §4.8.1 「进入时已中止」只有 result、没有 call-start → 会出现**孤立结束**
 *   §4.5  子代理开启独立会话 → **必须按会话分桶**，否则活动与统计串线
 *   §4.4  并发由工具执行模式决定 → 活动强度只能由真实在飞数驱动
 *   §4.6  工具→插件归属采用三层求交；**无法确认时显示未归属，绝不伪装**
 *
 * 硬约束（产品文档 30.5）：
 *   - 重复通知不重复计数
 *   - 取消不计为成功
 *   - 数据断开显示"未知/断开"，不把员工全判成待机或完成
 *   - 不虚构缺失信息（缺开始事件就不编开始时间）
 */

/** 调用的终态。`unknown` 用于数据不足、无法判定结果的情况。 */
export const OUTCOME = Object.freeze({
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILURE: 'failure',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
})

/** 与宿主数据通道的连接状态。 */
export const CONNECTION = Object.freeze({
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  UNKNOWN: 'unknown',
})

/** 无法归属到任何插件时的员工键——显示为「外包」，不是错误态。 */
export const UNASSIGNED_EMPLOYEE = 'unassigned'

/** 活动强度的统计窗口：只看这段时间内完成过的调用。 */
export const ACTIVITY_WINDOW_MS = 30_000

/**
 * 判断一个终态结果是否属于「取消」。
 *
 * 依据 §4.8：取消与失败都表现为 `isError: true`，只能靠信号或错误文本区分。
 * @param {{ isError?: boolean, cancelled?: boolean, signalAborted?: boolean, errorMessage?: string }} result
 * @returns {boolean}
 */
export function isCancellation(result) {
  if (result === null || result === undefined) return false
  if (result.cancelled === true) return true
  if (result.signalAborted === true) return true
  return typeof result.errorMessage === 'string' && /aborted/i.test(result.errorMessage)
}

/**
 * 由一个终态结果推出 OUTCOME。
 * @param {{ isError?: boolean, cancelled?: boolean, signalAborted?: boolean, errorMessage?: string }} result
 * @returns {string} OUTCOME 之一
 */
export function outcomeOf(result) {
  if (result === null || result === undefined) return OUTCOME.UNKNOWN
  if (isCancellation(result)) return OUTCOME.CANCELLED
  return result.isError === true ? OUTCOME.FAILURE : OUTCOME.SUCCESS
}

/**
 * 创建初始状态。
 * @param {{ resolveEmployee?: (toolName: string) => { key: string, label: string, confidence: string } | null }} [options]
 *   resolveEmployee：工具 → 员工归属解析器。内部由 tool-package-map + 插件名册求交实现，
 *   引擎只负责调用它并**如实记录置信度**。
 */
export function createStudio(options = {}) {
  return {
    connection: CONNECTION.UNKNOWN,
    /** 插件名册：employeeKey → 员工。 */
    roster: new Map(),
    /** callId → 调用记录。 */
    calls: new Map(),
    /** 出现过的会话（含子代理会话）。 */
    sessions: new Set(),
    /** 全局计数。 */
    stats: { started: 0, success: 0, failure: 0, cancelled: 0, unknown: 0, duplicateIgnored: 0 },
    /** sessionId → 该会话的计数（防止跨会话串线）。 */
    sessionStats: new Map(),
    /** toolName → 无法归属时的出现次数。 */
    unassignedTools: new Map(),
    /** 已完成的调用，用于计算活动强度（只保留窗口内的）。 */
    recent: [],
    resolveEmployee: options.resolveEmployee ?? (() => null),
    now: options.now ?? (() => Date.now()),
  }
}

function bumpSession(state, sessionId, key, delta = 1) {
  const id = sessionId ?? 'unknown'
  let record = state.sessionStats.get(id)
  if (record === undefined) {
    record = { started: 0, success: 0, failure: 0, cancelled: 0, unknown: 0, running: 0 }
    state.sessionStats.set(id, record)
  }
  record[key] += delta
}

function pruneRecent(state) {
  const threshold = state.now() - ACTIVITY_WINDOW_MS
  while (state.recent.length > 0 && state.recent[0].at < threshold) state.recent.shift()
}

/**
 * 把一次调用归到某个员工。
 * 归属失败时**不伪装**：记到 unassignedTools，员工键用 UNASSIGNED_EMPLOYEE。
 */
function employeeFor(state, toolName) {
  let resolved = null
  try {
    resolved = state.resolveEmployee(toolName)
  } catch {
    resolved = null
  }
  if (resolved === null || resolved === undefined || resolved.key === undefined) {
    state.unassignedTools.set(toolName, (state.unassignedTools.get(toolName) ?? 0) + 1)
    return { key: UNASSIGNED_EMPLOYEE, label: null, moduleName: null, confidence: 'none' }
  }
  // label / moduleName 一并带上：岗位视图要显示"这个岗位现在由谁承包"，
  // 以及给不出具名归属时要能如实说明
  return {
    key: resolved.key,
    label: resolved.label ?? null,
    moduleName: resolved.moduleName ?? null,
    confidence: resolved.confidence ?? 'exact',
  }
}

/** 更新插件名册。已离开的员工记录保留，标记为 enabled=false（= 离职，不丢历史）。 */
export function applyRoster(state, plugins) {
  const seen = new Set()
  for (const plugin of plugins ?? []) {
    const key = plugin.entryId ?? plugin.moduleName
    if (key === undefined) continue
    seen.add(key)
    const existing = state.roster.get(key)
    state.roster.set(key, {
      key,
      label: existing?.label ?? plugin.label ?? key,
      moduleName: plugin.moduleName ?? null,
      enabled: plugin.enabled !== false,
      firstSeenAt: existing?.firstSeenAt ?? state.now(),
      lastSeenAt: state.now(),
    })
  }
  for (const [key, employee] of state.roster) {
    if (!seen.has(key)) employee.enabled = false
  }
  return state
}

/**
 * 归约一个事件。返回被修改的记录，便于调用方做增量通知。
 *
 * 支持的事件：
 *   { type: 'roster', plugins }
 *   { type: 'connection', status }
 *   { type: 'call-started', callId, toolName, sessionId, at? }
 *   { type: 'call-finished', callId, isError?, cancelled?, signalAborted?, errorMessage?, at? }
 *   { type: 'call-result-only', callId, toolName, sessionId, isError?, cancelled?, errorMessage?, at? }
 *     ↑ 「进入时已中止」形态：只有结果没有开始（§4.8.1）
 */
export function reduce(state, event) {
  if (event === null || event === undefined || typeof event.type !== 'string') {
    return { changed: false, reason: 'invalid-event' }
  }
  const at = typeof event.at === 'number' ? event.at : state.now()

  switch (event.type) {
    case 'roster':
      applyRoster(state, event.plugins)
      return { changed: true, reason: 'roster' }

    case 'connection': {
      const next = event.status
      if (next !== CONNECTION.CONNECTED && next !== CONNECTION.DISCONNECTED && next !== CONNECTION.UNKNOWN) {
        return { changed: false, reason: 'invalid-status' }
      }
      state.connection = next
      return { changed: true, reason: 'connection' }
    }

    case 'call-started': {
      if (typeof event.callId !== 'string' || event.callId.length === 0) {
        return { changed: false, reason: 'missing-callId' }
      }
      // 重复的开始通知：不重复计数（§5 用例 3）
      if (state.calls.has(event.callId)) {
        state.stats.duplicateIgnored += 1
        return { changed: false, reason: 'duplicate-start' }
      }
      const employee = employeeFor(state, event.toolName)
      const sessionId = event.sessionId ?? 'unknown'
      state.calls.set(event.callId, {
        callId: event.callId,
        toolName: event.toolName,
        sessionId,
        employeeKey: employee.key,
        moduleName: employee.moduleName ?? null,
        employeeLabel: employee.label ?? null,
        attribution: employee.confidence,
        // 原始参数（截断）：岗位视图靠它说出"正在阅读哪个文件/搜什么词/跑什么命令"
        argumentsPreview: typeof event.argumentsPreview === 'string' ? event.argumentsPreview : null,
        // 这次任务对应的思维流（模型先想后调，见 takeThoughtForCall）
        thoughtPreview: typeof event.thoughtPreview === 'string' && event.thoughtPreview.length > 0 ? event.thoughtPreview : null,
        startedAt: at,
        finishedAt: null,
        outcome: OUTCOME.RUNNING,
        errorMessage: null,
        startMissing: false,
      })
      state.sessions.add(sessionId)
      state.stats.started += 1
      bumpSession(state, sessionId, 'started')
      bumpSession(state, sessionId, 'running')
      return { changed: true, reason: 'started', callId: event.callId, employeeKey: employee.key }
    }

    case 'call-finished': {
      const record = state.calls.get(event.callId)
      if (record === undefined) {
        // 没有开始事件就收到结束。**保留可确认的结果，但不虚构开始时间**（§5 用例 4）。
        // 若事件自带工具名，就降级成 result-only 记录；否则只能如实报告缺口。
        if (typeof event.toolName === 'string' && event.toolName.length > 0) {
          return reduce(state, { ...event, type: 'call-result-only' })
        }
        return { changed: false, reason: 'finish-without-start', callId: event.callId }
      }
      // 重复的结束通知：不重复计算（§5 用例 3）
      if (record.outcome !== OUTCOME.RUNNING) {
        state.stats.duplicateIgnored += 1
        return { changed: false, reason: 'duplicate-finish', callId: event.callId }
      }
      const outcome = outcomeOf({
        isError: event.isError,
        cancelled: event.cancelled,
        signalAborted: event.signalAborted,
        errorMessage: event.errorMessage,
      })
      record.finishedAt = at
      record.outcome = outcome
      // 空字符串视为没有错误信息（否则成功调用也会在面板里显示「最近错误：」）
      record.errorMessage = typeof event.errorMessage === 'string' && event.errorMessage.length > 0 ? event.errorMessage : null
      state.stats[outcomeKey(outcome)] += 1
      bumpSession(state, record.sessionId, 'running', -1)
      bumpSession(state, record.sessionId, outcomeKey(outcome))
      state.recent.push({ at, employeeKey: record.employeeKey, sessionId: record.sessionId })
      pruneRecent(state)
      return { changed: true, reason: 'finished', callId: event.callId, outcome }
    }

    case 'call-result-only': {
      // 「进入时已中止」：流水线被短路，tools/execute 包装层根本没被调用（§4.8.1）。
      // 因此只有结果、没有开始。诚实记录：startMissing=true，耗时为 unknown。
      if (typeof event.callId !== 'string' || event.callId.length === 0) {
        return { changed: false, reason: 'missing-callId' }
      }
      if (state.calls.has(event.callId)) {
        state.stats.duplicateIgnored += 1
        return { changed: false, reason: 'duplicate-result-only' }
      }
      const employee = employeeFor(state, event.toolName)
      const sessionId = event.sessionId ?? 'unknown'
      const outcome = outcomeOf({
        isError: event.isError,
        cancelled: event.cancelled,
        signalAborted: event.signalAborted,
        errorMessage: event.errorMessage,
      })
      state.calls.set(event.callId, {
        callId: event.callId,
        toolName: event.toolName,
        sessionId,
        employeeKey: employee.key,
        moduleName: employee.moduleName ?? null,
        employeeLabel: employee.label ?? null,
        attribution: employee.confidence,
        argumentsPreview: typeof event.argumentsPreview === 'string' ? event.argumentsPreview : null,
        thoughtPreview: typeof event.thoughtPreview === 'string' && event.thoughtPreview.length > 0 ? event.thoughtPreview : null,
        startedAt: null,
        finishedAt: at,
        outcome,
        errorMessage: typeof event.errorMessage === 'string' && event.errorMessage.length > 0 ? event.errorMessage : null,
        startMissing: true,
      })
      state.sessions.add(sessionId)
      state.stats[outcomeKey(outcome)] += 1
      bumpSession(state, sessionId, outcomeKey(outcome))
      state.recent.push({ at, employeeKey: employee.key, sessionId })
      pruneRecent(state)
      return { changed: true, reason: 'result-only', callId: event.callId, outcome }
    }

    default:
      return { changed: false, reason: 'unknown-event-type' }
  }
}

function outcomeKey(outcome) {
  if (outcome === OUTCOME.SUCCESS) return 'success'
  if (outcome === OUTCOME.FAILURE) return 'failure'
  if (outcome === OUTCOME.CANCELLED) return 'cancelled'
  return 'unknown'
}

/**
 * 派生某个会话下员工的展示状态。
 *
 * 关键点（§4.5）：**按会话分桶**。子代理开启独立会话，若用全局计数，
 * 父会话与子会话的活动会互相污染。
 *
 * @param {object} state
 * @param {string} sessionId
 * @param {{ now?: number, connectionOverride?: string }} [options]
 */
export function employeesOf(state, sessionId, options = {}) {
  const connection = options.connectionOverride ?? state.connection
  const byKey = new Map()

  const ensure = (key) => {
    let entry = byKey.get(key)
    if (entry === undefined) {
      const rosterEntry = state.roster.get(key)
      entry = {
        employeeKey: key,
        label: rosterEntry?.label ?? (key === UNASSIGNED_EMPLOYEE ? '外包组' : key),
        moduleName: rosterEntry?.moduleName ?? null,
        enabled: rosterEntry?.enabled ?? true,
        running: [],
        runningCount: 0,
        started: 0,
        success: 0,
        failure: 0,
        cancelled: 0,
        unknown: 0,
        lastError: null,
        lastActivityAt: null,
        activity: 0,
        status: 'idle',
      }
      byKey.set(key, entry)
    }
    return entry
  }

  // 先按名册建位：在岗但本会话没活儿的员工也必须在列表里
  // （用户要能看到"这个人在岗"，否则会以为插件没装上）。
  for (const [key, rosterEntry] of state.roster) {
    if (rosterEntry.enabled) ensure(key)
  }

  const threshold = (options.now ?? state.now()) - ACTIVITY_WINDOW_MS
  for (const record of state.calls.values()) {
    if (record.sessionId !== sessionId) continue
    const entry = ensure(record.employeeKey)
    if (!record.startMissing) entry.started += 1
    if (record.outcome === OUTCOME.RUNNING) {
      entry.running.push(record.callId)
      continue
    }
    entry[outcomeKey(record.outcome)] += 1
    if (record.errorMessage !== null && record.outcome !== OUTCOME.CANCELLED) {
      entry.lastError = record.errorMessage
    }
    if (record.finishedAt !== null && (entry.lastActivityAt === null || record.finishedAt > entry.lastActivityAt)) {
      entry.lastActivityAt = record.finishedAt
    }
  }

  // 活动强度：真实在飞数 + 窗口内完成数。**不猜、不随机**（产品文档第二原则）。
  for (const entry of byKey.values()) {
    const recentForEmployee = state.recent.filter(
      (item) => item.sessionId === sessionId && item.employeeKey === entry.employeeKey && item.at >= threshold,
    ).length
    entry.activity = entry.running.length * 2 + recentForEmployee
    entry.runningCount = entry.running.length

    if (connection === CONNECTION.DISCONNECTED) {
      // 数据断开时**不把员工判成待机或完成**，而是明确标为未知（§5 用例 6）。
      entry.status = 'unknown'
    } else if (connection === CONNECTION.UNKNOWN) {
      entry.status = entry.running.length > 0 ? 'working' : 'unknown'
    } else if (entry.running.length > 0) {
      entry.status = 'working'
    } else {
      entry.status = 'idle'
    }
  }

  return [...byKey.values()].sort((a, b) => b.activity - a.activity || a.employeeKey.localeCompare(b.employeeKey))
}

/** 某个员工在某会话下的局部健康度（供"10 秒内定位哪个插件出问题"使用）。 */
export function healthOf(state, sessionId, employeeKey) {
  const list = employeesOf(state, sessionId)
  return list.find((item) => item.employeeKey === employeeKey) ?? null
}

/** 只读快照，便于序列化与断言。 */
export function snapshot(state, sessionId) {
  return {
    connection: state.connection,
    sessions: [...state.sessions],
    stats: { ...state.stats },
    sessionStats: Object.fromEntries([...state.sessionStats].map(([id, stats]) => [id, { ...stats }])),
    unassignedTools: Object.fromEntries(state.unassignedTools),
    employees: sessionId === undefined ? [] : employeesOf(state, sessionId),
  }
}
