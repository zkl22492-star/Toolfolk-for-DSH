/**
 * DSH 3D 工作室 · M1 接入探针（host 侧）
 *
 * 目的：验证官方 DSH 宿主能否提供驱动 3D 工作室所需的调用事件。
 * 对应 docs/开发规划.md 的 INT-04：
 *   开始执行 / 最终结果 / 取消 / 会话身份 / 嵌套调用
 *
 * 数据来源（全部是官方扩展点，不修改宿主调用链）：
 *   1. tools/execute —— 包裹分发生命周期，拿到精确耗时与最终结果
 *   2. tools/result  —— 观测不可变的权威结果
 *   3. session/event —— 可持久回放的会话事实（tool/call、tool/result）
 *
 * 硬约束（产品构想文档 30.2）：
 *   可视化处理不得阻塞或改变工具执行结果。本插件只读、只记录，
 *   不修改 exec、不替换 signal、不拦截返回值、不吞异常。
 *
 * 官方签名（reference/deepseek-harness @ c291e79）：
 *   'tools/execute'(exec: ToolDispatchExecution, next) => Promise<ToolExecutionResult>
 *   'tools/result'(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => undefined
 *   'session/event'(session: Session, event: SessionEvent) => void
 */

export const name = 'studio-probe'

// 需要 tools 服务：一方面监听 tools/* 扩展点，一方面用 ctx.tools.schemas() 取工具清单。
// 不声明 inject 就访问 ctx.tools 会得到
// `cannot get property "tools" without inject`（已实测）。
export const inject = ['tools']

const PREFIX = '[studio-probe]'

/** 事件计数与成功/失败/取消统计，供后续 UI 面板读取。 */
const stats = {
  executeStarted: 0,
  executeFinished: 0,
  results: 0,
  successes: 0,
  failures: 0,
  cancelled: 0,
  sessionEvents: 0,
  toolCallEvents: 0,
  toolResultEvents: 0,
  unknownSessionEvents: 0,
  /** 合成事件通道收到次数，用于验证卸载后监听器是否释放。 */
  echoes: 0,
}

/** 正在执行中的调用：callId -> 记录。用于并发与父子关系判定。 */
const inFlight = new Map()

/**
 * callId -> sessionId。
 *
 * 为什么不直接用 exec.agent：`tools/execute` 上拿不到稳定的会话标识，而
 * `session/event` 的 `tool/call` 带 callId 与 session，且实测比 `tools/execute`
 * 早约 2ms 到达，所以开始执行时这里已经能查到会话。
 */
const callSession = new Map()

/** 本次进程内出现过的会话 id —— 子代理会开启独立会话，必须分别计数。 */
const sessionsSeen = new Set()

/**
 * 按会话统计在飞调用数。
 *
 * 2026-09-11 实测：子代理产生的内部调用属于**另一个会话**，若用全局计数会把
 * 父会话与子会话的活动混在一起（实测出现 concurrent:2 实为两个会话各 1 个）。
 * 产品文档 30.5 第 4 条要求避免跨会话串线，故必须分桶。
 */
function concurrentIn(sessionId) {
  let count = 0
  for (const record of inFlight.values()) {
    if (record.sessionId === sessionId) count++
  }
  return count
}

/** 已完成的调用记录（环形缓冲，避免长时间运行无限增长）。 */
const records = []
const RING_MAX = 500

/** 本项目关心的会话事件类型。 */
const WATCHED_SESSION_EVENTS = new Set([
  'tool/call',
  'tool/result',
  'turn/start',
  'turn/end',
])

/** 只做一次的结构自检，用来确认运行时真实字段而不用猜。 */
const introspected = new Set()

function emit(kind, payload) {
  try {
    process.stdout.write(PREFIX + ' ' + JSON.stringify({ kind, ts: Date.now(), ...payload }) + '\n')
  } catch {
    // 记录失败绝不能影响宿主
  }
}

/** 安全序列化：截断、防循环、Symbol 转字符串。 */
function safeValue(value, max = 400) {
  if (value === undefined) return undefined
  try {
    let text
    if (typeof value === 'string') text = value
    else if (typeof value === 'symbol') text = String(value)
    else text = JSON.stringify(value)
    if (text === undefined) text = String(value)
    return text.length > max ? text.slice(0, max) + '…(+' + (text.length - max) + ')' : text
  } catch {
    return '<unserializable>'
  }
}

/** 一次性结构自检：把对象的键与关键字段类型打出来。 */
function introspect(tag, obj) {
  if (introspected.has(tag)) return
  introspected.add(tag)
  try {
    if (obj === null || obj === undefined) {
      emit('introspect', { tag, value: String(obj) })
      return
    }
    const keys = Object.keys(obj)
    const shape = {}
    for (const key of keys) {
      const v = obj[key]
      shape[key] = v === null ? 'null' : typeof v
    }
    emit('introspect', {
      tag,
      typeName: obj.constructor ? obj.constructor.name : typeof obj,
      keys,
      shape,
      idField: obj.id === undefined ? null : safeValue(obj.id, 120),
      sessionIdField: obj.sessionId === undefined ? null : safeValue(obj.sessionId, 120),
    })
  } catch (error) {
    emit('introspect-error', { tag, message: String(error && error.message) })
  }
}

/** 从会话对象里尽力取一个可读标识，取不到就诚实报 unknown。 */
function describeSession(session) {
  if (session === null || session === undefined) return 'unknown'
  for (const key of ['id', 'sessionId', 'key']) {
    const value = session[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return 'unknown'
}

function pushRecord(record) {
  records.push(record)
  if (records.length > RING_MAX) records.splice(0, records.length - RING_MAX)
}

/** 调用完毕时，把我们在 tools/execute 里没拿到、但 tools/result 能补的字段合并进去。 */
function mergeResult(exec, result) {
  const callId = safeValue(exec && exec.callId, 120)
  const existing = records.find((item) => item.callId === callId)
  const isError = Boolean(result && result.isError)
  const message = isError && result.error ? String(result.error.message ?? '') : ''
  const cancelled = isError && /aborted/i.test(message)

  if (existing) {
    existing.isError = isError
    existing.cancelled = cancelled
    existing.errorMessage = isError ? safeValue(message, 300) : undefined
    existing.hasConcludesTurn = Boolean(result && result.concludesTurn)
    return existing
  }

  // 没有对应的开始事件。官方契约里这是「进入时已中止」的特征：信号在入口就已中止时，
  // 注册表会跳过 pre-execute / 审批 / tools/execute / post-execute 和工具主体，
  // 因此 tools/execute 包装层根本不会被调用，但 tools/result 仍会发布一次。
  const abortedBeforeDispatch =
    isError && (/aborted before dispatch/i.test(message) || /aborted/i.test(message))
  const orphan = {
    callId,
    name: exec && exec.name,
    isError,
    cancelled,
    abortedBeforeDispatch,
    errorMessage: isError ? safeValue(message, 300) : undefined,
    note: abortedBeforeDispatch
      ? 'tools/result 收到结束事件但未见开始事件：疑似「进入时已中止」（ABORTED_BEFORE_DISPATCH），流水线被短路'
      : 'tools/result 收到结束事件但未见开始事件（乱序或缺失通知）',
  }
  pushRecord(orphan)
  return orphan
}

export function apply(ctx) {
  emit('plugin-loaded', { name, node: process.version, platform: process.platform })

  // ── 1. tools/execute：包裹分发生命周期，拿精确耗时 ──────────────────────
  ctx.on('tools/execute', async (exec, next) => {
    const startedAt = Date.now()
    const callId = safeValue(exec && exec.callId, 120)
    const hasParent = Boolean(exec && exec.parent)
    const sessionId = callSession.get(callId) ?? 'unknown'

    stats.executeStarted++
    inFlight.set(callId, { name: exec && exec.name, startedAt, hasParent, sessionId })

    if (introspected.size === 0) introspect('ToolExecution', exec)

    emit('call-start', {
      callId,
      name: exec && exec.name,
      session: sessionId,
      hasParent,
      parentToken: exec && exec.parent ? String(exec.parent) : undefined,
      rootCallId: safeValue(exec && exec.rootCallId, 120),
      concurrent: concurrentIn(sessionId),
      argumentsPreview: safeValue(exec && exec.arguments, 200),
    })

    try {
      const result = await next()
      const durationMs = Date.now() - startedAt

      // 关键（2026-09-11 实测）：工具级失败**不会抛异常**，而是以
      // isError: true 的结果正常返回。所以成败必须从 result 判断，
      // 不能只用 try/catch —— 否则失败会被误报成成功。
      const isError = Boolean(result && result.isError)

      // 取消与失败必须分开记录（产品文档 30.5 第 3 条：取消不能计为成功）。
      // 官方契约（2026-07-19-cooperative-tool-cancellation）：取消同样以结果形式
      // 返回，不抛异常；正文调用后被取消记为 ABORTED，模型可见文本
      // "Error: tool call aborted"，且注册表会等工具主体完全停稳后才返回。
      const signalAborted = Boolean(exec && exec.signal && exec.signal.aborted)
      const message = isError && result.error ? String(result.error.message ?? '') : ''
      const abortedByText = /aborted/i.test(message)
      const cancelled = isError && (signalAborted || abortedByText)

      stats.executeFinished++
      if (cancelled) stats.cancelled++
      else if (isError) stats.failures++
      else stats.successes++
      inFlight.delete(callId)

      emit('call-end', {
        callId,
        name: exec && exec.name,
        session: sessionId,
        ok: !isError,
        isError,
        cancelled,
        signalAborted,
        errorMessage: isError ? safeValue(message, 300) : undefined,
        durationMs,
        concurrentAfter: concurrentIn(sessionId),
      })
      return result
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const aborted =
        Boolean(exec && exec.signal && exec.signal.aborted) ||
        (error && (error.name === 'AbortError' || error.name === 'TimeoutError'))

      stats.executeFinished++
      if (aborted) stats.cancelled++
      else stats.failures++
      inFlight.delete(callId)

      emit('call-end', {
        callId,
        name: exec && exec.name,
        session: sessionId,
        ok: false,
        cancelled: aborted,
        durationMs,
        errorName: error && error.name,
        errorMessage: safeValue(error && error.message, 300),
        concurrentAfter: concurrentIn(sessionId),
      })

      // 必须原样抛出，绝不能吞掉或改变宿主的执行结果
      throw error
    }
  })

  // ── 2. tools/result：观测不可变的权威结果 ──────────────────────────────
  ctx.on('tools/result', (exec, result) => {
    stats.results++
    const merged = mergeResult(exec, result)
    emit('result', {
      callId: safeValue(exec && exec.callId, 120),
      name: exec && exec.name,
      isError: Boolean(result && result.isError),
      errorMessage: result && result.isError ? safeValue(result.error && result.error.message, 300) : undefined,
      metaKeys: result && result.meta ? Object.keys(result.meta) : undefined,
      mergedCallId: merged && merged.callId,
    })
  })

  // ── 3. session/event：可持久回放的会话事实 ────────────────────────────
  ctx.on('session/event', (session, event) => {
    stats.sessionEvents++
    const type = event && event.type
    const sessionId = describeSession(session)

    // 新会话出现时显式记一笔：子代理会开启独立会话，这是跨会话串线的源头。
    if (sessionId !== 'unknown' && !sessionsSeen.has(sessionId)) {
      sessionsSeen.add(sessionId)
      emit('session-opened', { session: sessionId, seq: event && event.seq, via: String(type) })
    }

    if (type === 'tool/call') {
      stats.toolCallEvents++
      if (records.length === 0) introspect('Session', session)
      introspect('SessionEvent(tool/call)', event)
      // 建立 callId -> sessionId 映射，供随后的 tools/execute 分桶计数
      const callId = event && event.data ? event.data.callId : undefined
      if (typeof callId === 'string' && callId.length > 0) callSession.set(callId, sessionId)
    } else if (type === 'tool/result') {
      stats.toolResultEvents++
      introspect('SessionEvent(tool/result)', event)
    } else if (!WATCHED_SESSION_EVENTS.has(type)) {
      stats.unknownSessionEvents++
      introspect('SessionEvent(other:' + String(type) + ')', event)
      return
    }

    emit('session-event', {
      session: sessionId,
      type: String(type),
      seq: event && event.seq,
      time: event && event.time,
      dataKeys: event && event.data ? Object.keys(event.data) : undefined,
      callId: event && event.data ? safeValue(event.data.callId, 120) : undefined,
      toolName: event && event.data ? event.data.name : undefined,
      turn: event && event.data ? event.data.turn : undefined,
      step: event && event.data ? event.data.step : undefined,
      isError: event && event.data ? event.data.isError : undefined,
    })
  })

  // ── 4. 清理验证用的合成事件通道 ──────────────────────────────────────
  // 只用于验证「插件卸载后监听器是否真的被释放」：外部（测试驱动插件）可以
  // ctx.emit('studio-probe/echo', ...) 触发，卸载后若仍能收到即为泄漏。
  // 这是一条自定义事件名，不会与宿主任何真实事件冲突。
  ctx.on('studio-probe/echo', (payload) => {
    stats.echoes++
    emit('echo', { payload, count: stats.echoes })
  })

  // ── 5. 插件清单与工具归属侦查 ────────────────────────────────────────
  // 官方 host/plugin-inventory 的实现说明：`list()` 读取的是 `ctx.loader.entries()`。
  // 这是插件级的清单（条目 id + 模块标识），但工具注册表本身不记录归属
  // （见 docs/integration-findings.md §4.6），所以这里先把两侧原始数据都 dump
  // 出来，用真实数据判断归属到底能不能拿到。
  function describeShape(obj) {
    try {
      if (obj === null || obj === undefined) return String(obj)
      const shape = {}
      for (const key of Object.keys(obj)) {
        const value = obj[key]
        shape[key] = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      }
      return shape
    } catch (error) {
      return '<shape-error:' + String(error && error.message) + '>'
    }
  }

  function dumpInventory() {
    const report = { kind: 'inventory', loader: null, toolCount: null, tools: null, errors: [] }

    // 加载器条目 = 已加载的插件
    let loader = null
    try {
      loader = typeof ctx.get === 'function' ? ctx.get('loader') : ctx.loader
    } catch (error) {
      report.errors.push('loader-access: ' + String(error && error.message))
    }
    try {
      if (loader !== null && typeof loader.entries === 'function') {
        const entries = [...loader.entries()]
        report.entryCount = entries.length
        report.entryShape = entries.length > 0 ? describeShape(entries[0]) : null
        report.loader = entries.map((entry) => {
          const options = entry && entry.options ? entry.options : {}
          return {
            entryId: options.id ?? (entry && entry.id) ?? null,
            moduleName: options.name ?? null,
            fiberState: entry && entry.fiber ? entry.fiber.state : null,
            disabled: options.disabled ?? null,
          }
        })

        // 精确归属侦查：看某个工具插件的 fiber/ctx 是否可枚举出它注册了什么。
        // 若 fiber 能列出 effects 或 ctx 能列出贡献，就能得到「工具 → 插件」的精确映射；
        // 若不可枚举，则只能退回到模块命名约定（不可靠）或接管 register。
        const sample = entries.find((entry) => {
          const name = entry && entry.options ? entry.options.name : undefined
          return typeof name === 'string' && name.includes('dsh-tool-fs-search')
        })
        if (sample !== undefined && sample !== null) {
          const fiber = sample.fiber
          report.fiberProbe = {
            entryId: sample.options ? sample.options.id : null,
            fiberType: fiber ? fiber.constructor?.name : null,
            fiberOwnKeys: fiber ? Object.keys(fiber) : null,
            fiberProtoKeys: fiber ? Object.getOwnPropertyNames(Object.getPrototypeOf(fiber)) : null,
            ctxKeys: sample.ctx ? Object.keys(sample.ctx).slice(0, 30) : null,
            ctxProtoKeys: sample.ctx
              ? Object.getOwnPropertyNames(Object.getPrototypeOf(sample.ctx)).slice(0, 40)
              : null,
          }
        }
      } else {
        report.errors.push('loader.entries 不可用')
      }
    } catch (error) {
      report.errors.push('loader-entries: ' + String(error && error.message))
    }

    // 工具清单（只有 schema，按官方实现确认不含归属）
    try {
      if (ctx.tools !== undefined && typeof ctx.tools.schemas === 'function') {
        const schemas = ctx.tools.schemas()
        report.toolCount = schemas.length
        report.tools = schemas.map((schema) => schema && schema.name)
        report.toolShape = schemas.length > 0 ? Object.keys(schemas[0]) : null
      }
    } catch (error) {
      report.errors.push('tools.schemas: ' + String(error && error.message))
    }

    emit('inventory', report)
  }

  // 宿主插件并行加载，我们的插件在 include 列表末尾，apply 时可能还有插件没就绪。
  // 延后 dump 一次，确保拿到完整清单。
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        dumpInventory()
      } catch (error) {
        emit('inventory-error', { message: String(error && error.message) })
      }
    }, 4000)
    return () => clearTimeout(timer)
  })

  // 供宿主内诊断：把当前统计和记录注册成服务（后续 UI 面板复用同一份数据）。
  // 注意：必须是 ctx.provide，不是 ctx.set —— Cordis 要求先 provide 才能 set，
  // 用 ctx.set 会以 cannot set property "studioProbe" without provide 直接崩掉加载。
  // provide 注册的服务归当前 fiber 所有，插件卸载时自动注销。
  ctx.provide('studioProbe', {
    stats,
    records,
    inFlight,
    dumpInventory,
    snapshot() {
      return {
        stats: { ...stats },
        sessions: [...sessionsSeen],
        inFlight: inFlight.size,
        recentRecords: records.slice(-50),
      }
    },
  })

  emit('probe-ready', { watching: ['tools/execute', 'tools/result', 'session/event'] })
}
