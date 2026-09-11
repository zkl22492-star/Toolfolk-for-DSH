/**
 * DSH 3D 工作室 · 宿主状态桥接（M2 收尾 / M3 前置）
 *
 * 与 `studio-probe.mjs` 的区别：探针只**记录事件用于验证**；本插件把事件
 * **真的喂进状态引擎**，并把引擎快照写给客户端渲染层。探针保留，用于回归与排查。
 *
 * 数据流：
 *   tools/execute + tools/result + session/event
 *     → state-engine（规范化调用记录 / 员工状态 / 统计）
 *     → 防抖 + 原子写 JSON 快照（用户目录一份 + 每个会话工作区一份）
 *     → 客户端经 remote.workspaceFiles 读回 → 3D 工位与信息面板
 *
 * 两份快照各有用途（详见 shared/studio-state-path.mjs）：
 *   用户目录那份是权威落点；会话工作区那份相对路径可达，是客户端"从零找到状态"的可移植入口。
 *
 * 硬约束（产品构想文档 30.2）：可视化不得阻塞或改变工具执行结果。
 *   - 全部监听器只读、不替换 signal、不拦截返回值、不吞异常；
 *   - **热路径内绝不 await 写盘**：事件只标脏 + 起防抖定时器，写盘在定时器里异步做；
 *   - 写盘失败只记日志，不影响宿主。
 */

import { existsSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assignmentFrom,
  buildAttribution,
  buildSnapshot,
  normalizePlugins,
  normalizeToolNames,
  outcomePayload,
  STATION_COUNT,
} from './shared/studio-bridge-core.mjs'
import { CONNECTION, createStudio, reduce } from './shared/state-engine.mjs'
import {
  applyModelSessionEvent,
  applyStreamChunk,
  createModelActivity,
  harvestDeliveries,
  modelSnapshot,
  seedDeliveries,
  takeThoughtForCall,
} from './shared/model-activity.mjs'
import { studioStatePath, studioWorkspaceStatePath } from './shared/studio-state-path.mjs'

export const name = 'studio-bridge'

// tools：监听 tools/* 扩展点 + ctx.tools.schemas() 取工具名册。
// 不声明 inject 就访问 ctx.tools 会得到 `cannot get property "tools" without inject`（已实测）。
export const inject = ['tools']

const PREFIX = '[studio-bridge]'
const HERE = dirname(fileURLToPath(import.meta.url))
/** 包根：`<包>/src/host.mjs` → `<包>`（资源与状态文件都按它推导，不依赖开发机绝对路径）。 */
const PACKAGE_ROOT = resolve(HERE, '..')
/** 开发形态下的仓库根（包在 `<repo>/packages/studio-panel`），仅作资源回退。 */
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
/** DSH 家目录：状态文件落在这里，插件装进 profile 后包目录可能只读。 */
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : homedir()
const STATE_PATH = studioStatePath(DSH_HOME, process.env.DSH_STUDIO_STATE)

/**
 * 资源位置：优先**包内**（发行形态），回退到仓库开发路径。
 * 客户端不再写死绝对路径——宿主把解析结果写进快照，客户端照着读，
 * 这样同一个 bundle 装在谁的机器上都能找到资源。
 */
function resolveAssets() {
  const candidates = [
    { glb: PACKAGE_ROOT + '/assets/studio.glb', art: PACKAGE_ROOT + '/assets/art' },
    { glb: REPO_ROOT + '/assets/3d/v2/studio.glb', art: REPO_ROOT + '/assets/art/studio-v1' },
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate.glb)) return candidate
  }
  return null
}
const ASSETS = resolveAssets()

/** 写盘防抖窗口：工具调用密集时合并多次变更，避免写盘成为负担。 */
const WRITE_DEBOUNCE_MS = 250
/** 名册刷新周期：插件可增删，工位名单要跟着变，但不能每事件都遍历加载器。 */
const ROSTER_REFRESH_MS = 5000
/**
 * 最多给几个会话工作区写副本。
 *
 * 实测教训：曾按 `sessionPersistence.list()` 把**所有存储态**会话的 cwd 都写一遍，
 * 一次启动就污染了用户 8 个无关项目目录——"猜客户端在看哪个会话"不可控，已回退。
 * 现在只覆盖 live 会话 + sandbox 根，上限 3 兜底（正常就是 1 个）。
 */
const MAX_WORKSPACE_COPIES = 3

/**
 * 把工具参数压成截断的 JSON 字符串，供岗位视图说出"正在做什么"。
 * 只截断、不改写：宁可少显示，也不能编造参数内容。
 */
function previewArguments(args, max = 300) {
  if (args === undefined) return null
  try {
    const text = typeof args === 'string' ? args : JSON.stringify(args)
    if (typeof text !== 'string') return null
    return text.length > max ? text.slice(0, max) : text
  } catch {
    return null
  }
}

function log(kind, payload = {}) {
  try {
    process.stdout.write(PREFIX + ' ' + JSON.stringify({ kind, ts: Date.now(), ...payload }) + '\n')
  } catch {
    // 记录失败绝不能影响宿主
  }
}

function loadCatalog() {
  return JSON.parse(readFileSync(new URL('./shared/tool-package-map.json', import.meta.url), 'utf8'))
}

/** 从会话对象里尽力取可读标识，取不到就诚实报 unknown（与探针一致）。 */
function describeSession(session) {
  if (session === null || session === undefined) return 'unknown'
  for (const key of ['id', 'sessionId', 'key']) {
    const value = session[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return 'unknown'
}

export function apply(ctx) {
  let catalog
  try {
    catalog = loadCatalog()
  } catch (error) {
    log('catalog-error', { message: String(error && error.message) })
    return
  }

  const state = createStudio({ resolveEmployee: () => null })
  reduce(state, { type: 'connection', status: CONNECTION.CONNECTED })

  /** 模型自己的活动（"思维流"）：与插件调用是两条并行的观察线。 */
  const modelActivity = createModelActivity()
  /** 已经回填过历史交付的会话，避免重复扫描。 */
  const seededSessions = new Set()
  let sawAssistantStream = false

  /** callId -> sessionId。session/event 的 tool/call 带 callId 且比 tools/execute 早约 2ms（实测）。 */
  const callSession = new Map()
  /** 已经收到开始事件的 callId——用于识别「进入时已中止」的孤立结果（§4.8.1）。 */
  const startedCalls = new Set()
  /**
   * 由**真实调用**发现的员工：moduleName → 员工条目。
   *
   * 为什么需要它：web profile 下工具插件不进 `ctx.loader.entries()`，光靠名册刷新一个
   * 工位都建不出来（实测 159 条 0 命中），全部调用落「外包」，3D 里什么都不动。
   * 一笔真实调用本身就是"该插件装着"的证据，所以让它直接创建工位。
   */
  const seenEmployees = new Map()
  /** 最近一次名册刷新的「目录 ∩ 已安装」结果（员工条目数组），与调用发现合并用。 */
  let rosterSource = []
  /** 最近一次产生调用的会话，供客户端在自身会话缺失时兜底。 */
  let activeSession = null
  /** 名册刷新得到的工位分配。 */
  let assignment = { byStation: new Array(STATION_COUNT).fill(null), byEmployee: new Map(), overflow: [] }
  /** 归属置信度与降级说明，随快照一起给客户端（它必须显示出来，不能静默降级）。 */
  let attribution = null
  /** 当前归属解析器；名册刷新后替换。 */
  let resolveEmployee = () => null
  /** 上次名册刷新时间，用于避免逐调用刷新。 */
  let lastRosterAt = 0

  // ── 快照写出：防抖 + 原子替换，任何一步失败都不得影响宿主 ──────────────
  let dirty = false
  let writing = false
  let writeTimer = null
  let lastWriteError = null
  let writeCount = 0
  /** 已经记过日志的工作区副本（同一个工作区只报一次，不刷日志）。 */
  const loggedWorkspacePaths = new Set()
  /** 上次写过的根集合（没变就不重复记日志）。 */
  let lastRootsKey = null

  function scheduleWrite() {
    dirty = true
    if (writeTimer !== null || writing) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      void flush()
    }, WRITE_DEBOUNCE_MS)
    // 不能拖住宿主退出
    if (typeof writeTimer.unref === 'function') writeTimer.unref()
  }

  async function flush() {
    if (writing) return
    writing = true
    dirty = false
    try {
      assignment = currentAssignment()
      const snapshot = buildSnapshot(state, {
        assignment,
        activeSession,
        attribution,
        model: modelSnapshot(modelActivity),
        assets: ASSETS,
        now: Date.now(),
      })
      const text = JSON.stringify(snapshot)
      writeStateFile(STATE_PATH, text)
      // 再往每个会话工作区写一份：客户端只能用相对路径引导（绝对路径换台机器就失效）。
      const workspace = workspaceRoots()
      logWorkspaceRoots(workspace)
      for (const root of workspace.roots) writeStateFile(studioWorkspaceStatePath(root), text, true)
      writeCount += 1
      lastWriteError = null
    } catch (error) {
      lastWriteError = String(error && error.message)
      log('write-error', { message: lastWriteError })
    } finally {
      writing = false
      if (dirty) scheduleWrite()
    }
  }

  /**
   * 原子替换写一份快照；内容没变就不碰文件。
   *
   * 内容比较不只是省 I/O：工作区里的那一份落在用户的**项目目录**里，
   * 每次防抖都重写会让编辑器的文件监视和 git 状态一直抖。也保证客户端不会读到写了一半的 JSON
   * （先写 `.tmp` 再改名）。
   */
  function writeStateFile(path, text, isWorkspaceCopy = false) {
    try {
      if (readFileSync(path, 'utf8') === text) return
    } catch {
      // 还没写过 / 读不到 —— 继续往下写
    }
    mkdirSync(dirname(path), { recursive: true })
    const temp = path + '.tmp'
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
    if (isWorkspaceCopy && !loggedWorkspacePaths.has(path)) {
      loggedWorkspacePaths.add(path)
      log('workspace-state', { path })
    }
  }

  /**
   * 该往哪些会话工作区写副本。
   *
   * 为什么是会话工作区：`workspaceFiles.readAll` 接受**工作区相对路径**（官方实现按
   * 会话 `header.cwd` 解析，会话没有 cwd 时回退到 sandbox 工作区根），相对路径在任何机器上都成立。
   * 这就是客户端"从零找到状态文件"的唯一可移植入口——用户目录的绝对路径是构建期算的，
   * 装在别人机器上必然指错。
   *
   * **只写两处，不外扩**：
   *   1. `sessions.list()` 里 live 会话的 cwd —— 用户正在用的对话（在 UI 里打开对话会把它 resume 成 live）；
   *   2. sandbox 工作区根 —— 会话没有 cwd 时官方解析用的就是它。
   *
   * 曾经为了"恢复出来的历史对话"把 `sessionPersistence.list()` 里**所有**存储态会话的 cwd 也写一遍，
   * 结果在真实机器上一次启动就污染了 8 个无关项目目录（实测日志见下）。那种"猜客户端在看哪个会话"
   * 的做法不可控，已回退：冷会话若真读不到，客户端会把每条候选的原因显示出来，属于可诊断的失败，
   * 比到处丢文件好。
   */
  function workspaceRoots() {
    const live = []
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
      if (sessions !== null && sessions !== undefined && typeof sessions.list === 'function') {
        for (const session of sessions.list()) {
          const cwd = session === null || session === undefined ? null : session.header?.cwd
          if (typeof cwd === 'string' && cwd.length > 0 && !live.includes(cwd)) live.push(cwd)
          if (live.length >= MAX_WORKSPACE_COPIES) break
        }
      }
    } catch (error) {
      log('workspace-roots-error', { message: String(error && error.message) })
    }
    let sandbox = null
    try {
      const policy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : ctx.sandboxPolicy
      const root = policy === null || policy === undefined ? null : policy.workspaceRoot
      if (typeof root === 'string' && root.length > 0) sandbox = root
    } catch (error) {
      log('workspace-roots-error', { message: String(error && error.message) })
    }
    const roots = [...live]
    if (sandbox !== null && !roots.includes(sandbox)) roots.push(sandbox)
    return { roots, live, sandbox }
  }

  /** 写入去向只在**变化时**记一行：排查"客户端读不到"先看这里。 */
  function logWorkspaceRoots(workspace) {
    const key = workspace.roots.join('|')
    if (key === lastRootsKey) return
    lastRootsKey = key
    log('workspace-roots', { live: workspace.live, sandbox: workspace.sandbox, copies: workspace.roots })
  }

  /** 名册 ∪ 调用发现的员工；两者都是「员工条目」形状，按 entryId 去重。 */
  function mergedRoster() {
    const merged = new Map()
    for (const item of rosterSource) merged.set(item.entryId, item)
    for (const item of seenEmployees.values()) merged.set(item.entryId, item)
    return [...merged.values()]
  }

  /**
   * 工位分配：名册 ∪ 调用发现的员工，排序后依次落座。
   * 在写快照时重算，这样"新员工第一次干活"当帧就能有工位，不必等下一轮名册刷新。
   */
  function currentAssignment() {
    return assignmentFrom(state, [...seenEmployees.keys()], STATION_COUNT)
  }

  // ── 名册刷新：目录 ∩ 已安装，得到归属与员工名单 ─────────────────────────
  function refreshRoster() {
    try {
      const loader = typeof ctx.get === 'function' ? ctx.get('loader') : ctx.loader
      const entries = loader !== null && typeof loader.entries === 'function' ? [...loader.entries()] : []
      const schemas = typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas() : []
      const plugins = normalizePlugins(entries)
      const toolNames = normalizeToolNames(schemas)
      const attributionResult = buildAttribution({ catalog, plugins, toolNames })
      const { resolve, roster } = attributionResult
      state.resolveEmployee = resolve
      resolveEmployee = resolve
      rosterSource = roster
      lastRosterAt = Date.now()
      attribution = {
        mode: attributionResult.mode,
        runtimeToolCount: attributionResult.runtimeToolCount,
        pluginCount: plugins.length,
        employeeCount: roster.length,
      }
      // 名册 = 「目录 ∩ 已安装」∪ 「真实调用发现过的」
      const merged = mergedRoster()
      reduce(state, { type: 'roster', plugins: merged })
      assignment = currentAssignment()
      log('roster', {
        entries: plugins.length,
        tools: toolNames.length,
        employees: merged.length,
        seenByCalls: seenEmployees.size,
        mode: attribution.mode,
        stations: assignment.byStation.filter(Boolean).length,
        overflow: assignment.overflow.length,
      })
      scheduleWrite()
    } catch (error) {
      log('roster-error', { message: String(error && error.message) })
    }
  }

  // ── 1. tools/execute：开始与结束 ───────────────────────────────────────
  ctx.on('tools/execute', async (exec, next) => {
    const callId = exec && exec.callId !== undefined && exec.callId !== null ? String(exec.callId) : null
    const toolName = exec && typeof exec.name === 'string' ? exec.name : 'unknown'
    const sessionId = callId !== null ? callSession.get(callId) ?? 'unknown' : 'unknown'

    if (callId !== null) {
      startedCalls.add(callId)
      if (sessionId !== 'unknown') activeSession = sessionId
      // 归属在**开始这一刻**定下，之后不再追溯。工具插件是随 agent 启动才加载的，
      // 若只靠 5 秒定时刷新，会话最早的几次调用会被错记成「外包」并一直留着。
      // 所以这里同步补一次名册刷新（loader/tools 都是同步读取），把窗口关掉；
      // 带 2 秒下限，避免每次调用都做一遍全量遍历。
      if (resolveEmployee(toolName) === null && Date.now() - lastRosterAt > 2000) refreshRoster()
      // 记下"这通调用证明该插件在岗"，让它当帧就有工位（web profile 的名册为空时尤其关键）
      const resolved = resolveEmployee(toolName)
      if (resolved !== null && resolved !== undefined && typeof resolved.key === 'string') {
        if (!seenEmployees.has(resolved.key)) {
          seenEmployees.set(resolved.key, {
            entryId: resolved.key,
            moduleName: resolved.moduleName ?? null,
            label: resolved.label ?? resolved.key,
          })
          // 立刻进名册：这样它的显示名和工位当帧就对，不等下一轮 5 秒刷新
          reduce(state, { type: 'roster', plugins: mergedRoster() })
        }
      }
      reduce(state, {
        type: 'call-started',
        callId,
        toolName,
        sessionId,
        argumentsPreview: previewArguments(exec && exec.arguments),
        // 这次任务对应的思维：模型先想后调，所以在调用开始的这一刻取走缓冲区
        thoughtPreview: takeThoughtForCall(modelActivity) ?? undefined,
      })
      scheduleWrite()
    }

    try {
      const result = await next()
      if (callId !== null) {
        // 工具级失败**不抛异常**，以 result.isError 表达（§4.3）——成败只看返回值。
        const isError = Boolean(result && result.isError)
        const message = isError && result.error ? String(result.error.message ?? '') : ''
        const signalAborted = Boolean(exec && exec.signal && exec.signal.aborted)
        const cancelled = isError && (signalAborted || /aborted/i.test(message))
        reduce(state, {
          type: 'call-finished',
          callId,
          ...outcomePayload({ isError, cancelled, signalAborted, errorMessage: message }),
        })
        scheduleWrite()
      }
      return result
    } catch (error) {
      if (callId !== null) {
        const aborted =
          Boolean(exec && exec.signal && exec.signal.aborted) ||
          (error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
        reduce(state, {
          type: 'call-finished',
          callId,
          ...outcomePayload({ isError: true, cancelled: aborted, errorMessage: error && error.message }),
        })
        scheduleWrite()
      }
      // 必须原样抛出，绝不能吞掉或改变宿主的执行结果
      throw error
    }
  })

  // ── 2. tools/result：补权威结果，以及接住「进入时已中止」的孤立结束 ─────
  ctx.on('tools/result', (exec, result) => {
    const callId = exec && exec.callId !== undefined && exec.callId !== null ? String(exec.callId) : null
    if (callId === null || startedCalls.has(callId)) return
    // 没有开始事件 = 流水线被短路（ABORTED_BEFORE_DISPATCH，§4.8.1）。
    // 诚实记录：保留可确认的结果，不虚构开始时间。
    const isError = Boolean(result && result.isError)
    const message = isError && result.error ? String(result.error.message ?? '') : ''
    reduce(state, {
      type: 'call-result-only',
      callId,
      toolName: typeof exec.name === 'string' ? exec.name : 'unknown',
      sessionId: 'unknown',
      ...outcomePayload({ isError, cancelled: isError && /aborted/i.test(message), errorMessage: message }),
    })
    scheduleWrite()
  })

  // ── 3. agent/assistant-stream：模型的**实时**增量（"思维流"主数据源）──────
  // 官方 session-controller 也订阅这个事件（packages/api/session-controller/src/history.ts），
  // 它是 emit 型、agent 作用域；根上下文的监听器能收到全部 agent 的帧。
  // 只读、不阻塞：任何异常都必须被吞掉，绝不能影响模型流。
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const frame = payload && payload.frame ? payload.frame : payload
      const chunk = frame && frame.chunk ? frame.chunk : null
      if (chunk === null) return
      if (!sawAssistantStream) {
        sawAssistantStream = true
        log('assistant-stream-online', {
          // 打印一次真实形状，便于确认字段名（不靠猜）
          frameKeys: frame !== null && typeof frame === 'object' ? Object.keys(frame) : [],
          chunkType: chunk.type,
        })
      }
      const result = applyStreamChunk(modelActivity, chunk, Date.now())
      if (result.changed) scheduleWrite()
    } catch (error) {
      log('assistant-stream-error', { message: String(error && error.message) })
    }
  })

  // ── 4. session/event：会话身份、调用归属，以及模型活动的持久边界 ─────────
  ctx.on('session/event', (session, event) => {
    try {
      const type = event && event.type
      const data = event && event.data
      const sessionId = describeSession(session)

      // 模型相关事件（思维流的边界与失败）——与工具调用各走各的
      if (typeof type === 'string') {
        const result = applyModelSessionEvent(modelActivity, type, data, Date.now())
        if (result.changed) scheduleWrite()
      }

      if (type !== 'tool/call') return
      const callId = data ? data.callId : undefined
      if (typeof callId === 'string' && callId.length > 0) callSession.set(callId, sessionId)
      if (sessionId !== 'unknown') activeSession = sessionId
    } catch (error) {
      log('session-event-error', { message: String(error && error.message) })
    }
  })

  /**
   * 从会话的**完整日志**回填历史交付。
   *
   * 为什么在宿主侧做（用户实测："明明有历史对话啊"）：插件只能实时收到自己启动之后的事件，
   * 用户"一直用的那段对话"里早先的回答一份都拿不到。`Session.snapshotEvents()` 能读到完整日志
   * （含恢复出来的历史），所以在这里一次性还原每一轮的最终答复与结束性质。
   * 注：该读取器在官方源码里标了 deprecated（新的同步读取被禁止），但它是目前唯一能拿到完整日志的口子；
   * 用特性探测 + try/catch 包住，取不到就安静跳过，不影响实时通路。
   */
  function seedHistoryFromSessions() {
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions
      if (sessions === null || sessions === undefined || typeof sessions.list !== 'function') return
      for (const session of sessions.list()) {
        const sessionId = describeSession(session)
        if (sessionId === 'unknown' || seededSessions.has(sessionId)) continue
        if (typeof session.snapshotEvents !== 'function') continue
        seededSessions.add(sessionId)
        const entries = harvestDeliveries(session.snapshotEvents())
        if (entries.length === 0) continue
        const added = seedDeliveries(modelActivity, entries)
        log('delivery-seed', { session: sessionId, harvested: entries.length, added })
        scheduleWrite()
      }
    } catch (error) {
      log('delivery-seed-error', { message: String(error && error.message) })
    }
  }

  // ── 5. 生命周期 ────────────────────────────────────────────────────────
  refreshRoster()
  seedHistoryFromSessions()
  const rosterTimer = setInterval(() => {
    refreshRoster()
    // 会话可能稍后才被打开（恢复的对话），所以每轮都看一眼有没有新会话需要回填
    seedHistoryFromSessions()
  }, ROSTER_REFRESH_MS)
  if (typeof rosterTimer.unref === 'function') rosterTimer.unref()

  ctx.effect(() => () => {
    clearInterval(rosterTimer)
    if (writeTimer !== null) clearTimeout(writeTimer)
    writeTimer = null
    // 卸载时把连接标成断开：客户端据此显示「未知」而不是把员工全判成待机（§5 用例 6）。
    reduce(state, { type: 'connection', status: CONNECTION.DISCONNECTED })
    void flush()
  })

  // 宿主机内诊断入口（探针同款约定：必须 provide，不能 set）。
  ctx.provide('studioBridge', {
    statePath: STATE_PATH,
    snapshot: () => buildSnapshot(state, { assignment, activeSession, now: Date.now() }),
    report: () => ({
      statePath: STATE_PATH,
      writeCount,
      lastWriteError,
      startedCalls: startedCalls.size,
      activeSession,
      stations: assignment.byStation,
      stats: { ...state.stats },
      // 工作区副本去向：客户端只能靠相对路径找到状态文件，排查时先看这里
      workspaceCopies: workspaceRoots().roots.map(studioWorkspaceStatePath),
    }),
  })

  log('bridge-ready', { statePath: STATE_PATH, stations: STATION_COUNT, assets: ASSETS })
}
