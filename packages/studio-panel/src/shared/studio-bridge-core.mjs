/**
 * 工作室桥接核心（M2 → M3 之间的接缝）
 *
 * 职责：把「宿主运行时名册 / 工具名册 / 原始调用事件」翻译成
 * `state-engine` 能吃的规范化事件，并把引擎状态导出成**可序列化的快照**。
 *
 * 为什么单独一层：
 *   - 宿主侧桥接插件（src/host/studio-bridge.mjs）要碰 fs、定时器、ctx，
 *     这些没法在单元测试里跑；把判定逻辑抽到这里就能纯逻辑验证。
 *   - 客户端拿到的必须是纯 JSON（Map / Set 不能过 Remote 通道），
 *     序列化规则集中在此，避免两侧各写一份而漂移。
 *
 * 依据：docs/integration-findings.md §4.6.5（三层求交归属）、§4.4（并发由真实在飞数驱动）。
 */

import { createEmployeeResolver } from './employee-resolver.mjs'
import { buildEventLog, buildPosts } from './studio-posts.mjs'
import { OUTCOME, UNASSIGNED_EMPLOYEE, employeesOf } from './state-engine.mjs'

/** 组合场景里的工位数，与 assets/3d/v2/studio.glb 的 Station_0..5 一致。 */
export const STATION_COUNT = 6

/** 快照格式版本。客户端据此判断是否兼容，避免两端错版时静默乱读。 */
export const BRIDGE_SNAPSHOT_VERSION = 1

/**
 * 由三层求交建立工具归属与员工名册。
 *
 * 三层 = 官方生成式工具目录 ∩ 运行时插件名册 ∩ 运行时工具名册（§4.6.5）。
 * 任一环缺失都会导致该工具解析为 null，引擎随后按「外包组」处理——**不伪装**。
 *
 * @param {{ catalog: object, plugins?: object[], toolNames?: string[] }} input
 */
export function buildAttribution(input) {
  const catalog = input.catalog
  if (catalog === null || catalog === undefined || typeof catalog !== 'object') {
    throw new TypeError('buildAttribution 需要官方工具包映射（catalog）')
  }
  const plugins = input.plugins ?? []
  const toolNames = input.toolNames ?? []
  const resolve = createEmployeeResolver(catalog, plugins, toolNames)
  return {
    resolve,
    roster: resolve.roster,
    // 名册级状态：运行时工具名册为空时，所有归属都只有"目录确认"这一级。
    // 注意运行时名册**即使非空也覆盖不到 agent 平面的工具**，所以它不为空
    // 不代表每笔调用都能被"确认"——单笔调用的置信度看 resolve(tool).confidence。
    mode: toolNames.length > 0 ? 'catalog' : 'catalog-plugin',
    runtimeToolCount: toolNames.length,
  }
}

/**
 * 把工具名册的两种可能形状（字符串 / `{ name }`）统一成字符串数组。
 * 官方 `ctx.tools.schemas()` 返回 `{ name, description, parameters }`，
 * 但测试与回放里也可能直接给字符串。
 */
export function normalizeToolNames(tools) {
  const names = []
  for (const tool of tools ?? []) {
    const name = typeof tool === 'string' ? tool : tool?.name
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}

/**
 * 把加载器条目压成归属解析需要的形状。
 *
 * 官方 `ctx.loader.entries()` 的元素是 `{ options: { id, name, disabled }, fiber }`。
 *
 * `enabled` **优先看 fiber 的实时生命周期状态**，而不是去解释 `options.disabled`
 * 的原文——那可能是 `!!js process.platform` 这类表达式字符串，原文里既有"被禁用"
 * 也有"未被禁用"的表达式，按原文判断会把本该在岗的插件误判为禁用。
 * Cordis FiberState：PENDING 0 / LOADING 1 / ACTIVE 2 / FAILED 3 / DISPOSED 4 / UNLOADING 5。
 * 只有 FAILED、DISPOSED、UNLOADING 不算在岗（在途的 PENDING/LOADING 保留，稍后会 active）。
 * fiber 不可得时才回退到 disabled 字段的存在性。
 */
export function normalizePlugins(entries) {
  const plugins = []
  for (const entry of entries ?? []) {
    const options = entry?.options ?? entry ?? {}
    const entryId = options.id ?? entry?.id
    const moduleName = options.name ?? null
    if (entryId === undefined || entryId === null) continue
    const fiberState = entry?.fiber?.state
    const enabled =
      typeof fiberState === 'number'
        ? fiberState !== 3 && fiberState !== 4 && fiberState !== 5
        : options.disabled === undefined || options.disabled === null
    plugins.push({
      entryId: String(entryId),
      moduleName: moduleName === null ? null : String(moduleName),
      label: options.label ?? (moduleName === null ? String(entryId) : String(moduleName)),
      enabled,
    })
  }
  return plugins
}

/**
 * 稳定工位分配：员工键排序后依次落座。
 *
 * 稳定性来自「按 key 排序」而非「按出现顺序」——名册刷新（插件增减）时，
 * 已存在的员工仍落在同一工位，符合规划 MVP-01「稳定员工标识对应稳定位置」。
 * 超出工位数量的员工进 `overflow`，不硬塞（MVP-02 的分页留待 M4）。
 *
 * @param {string[]} employeeKeys
 * @param {number} stationCount
 * @returns {{ byStation: (string|null)[], byEmployee: Map<string, number>, overflow: string[] }}
 */
export function assignStations(employeeKeys, stationCount = STATION_COUNT) {
  const sorted = [...new Set(employeeKeys ?? [])].filter((key) => typeof key === 'string' && key.length > 0)
  sorted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const byStation = new Array(Math.max(0, stationCount)).fill(null)
  const byEmployee = new Map()
  const overflow = []
  for (const key of sorted) {
    const index = byEmployee.size
    if (index < byStation.length) {
      byStation[index] = key
      byEmployee.set(key, index)
    } else {
      overflow.push(key)
    }
  }
  return { byStation, byEmployee, overflow }
}

/**
 * 工位分配 = 名册 ∪ 调用发现的员工（外包组不占工位）。
 *
 * 为什么要并上"调用发现的"：web profile 下工具插件不进 `ctx.loader.entries()`
 * （实测 159 条 0 命中），名册是空的。若分配只看名册，员工就永远没有工位，
 * 客户端 `applyState` 会把所有工位设成待机——**3D 里看不到任何变化**（实测症状）。
 * 一笔真实调用证明该插件在岗，因此它必须能落座。
 */
export function assignmentFrom(state, seenKeys = [], stationCount = STATION_COUNT) {
  const keys = new Set([...state.roster.keys(), ...seenKeys])
  keys.delete(UNASSIGNED_EMPLOYEE)
  return assignStations([...keys], stationCount)
}

/**
 * 某个员工在某会话下最近一次**已结束**调用的终态。
 * 用于客户端决定播放 Idle / Working / Error；没有历史则返回 null（不猜）。
 */
export function lastOutcomeOf(state, sessionId, employeeKey) {
  let latest = null
  for (const record of state.calls.values()) {
    if (record.sessionId !== sessionId || record.employeeKey !== employeeKey) continue
    if (record.finishedAt === null) continue
    if (latest === null || record.finishedAt > latest.finishedAt) latest = record
  }
  return latest === null ? null : { outcome: latest.outcome, finishedAt: latest.finishedAt, toolName: latest.toolName }
}

/**
 * 构建一份可序列化的快照，供客户端经 Remote 通道读取。
 *
 * 覆盖**所有出现过的会话**：客户端视图属于某个具体会话，若只导出「最近活跃会话」，
 * 用户切到别的会话时会看到错误的工作室。会话 id 由客户端自行匹配（§4.5 按会话分桶）。
 *
 * @param {object} state state-engine 的状态
 * @param {{ assignment?: { byStation: (string|null)[] }, sessionIds?: string[], activeSession?: string|null, now?: number }} [options]
 */
export function buildSnapshot(state, options = {}) {
  const assignment = options.assignment ?? { byStation: [] }
  const deskByEmployee = new Map()
  assignment.byStation.forEach((key, index) => {
    if (typeof key === 'string') deskByEmployee.set(key, index)
  })

  const sessionIds = options.sessionIds ?? [...state.sessions]
  const sessions = {}
  for (const sessionId of sessionIds) {
    // 固定岗位视图：主文案是"正在做某件事"，统计只作次要信息（见 studio-posts.mjs）
    const postView = buildPosts(state, sessionId)
    const employees = employeesOf(state, sessionId, { now: options.now }).map((entry) => {
      const desk = deskByEmployee.has(entry.employeeKey) ? deskByEmployee.get(entry.employeeKey) : null
      return {
        employeeKey: entry.employeeKey,
        label: entry.label,
        moduleName: entry.moduleName,
        enabled: entry.enabled,
        status: entry.status,
        desk,
        runningCount: entry.runningCount,
        currentTools: entry.running.map((callId) => state.calls.get(callId)?.toolName ?? null).filter(Boolean),
        started: entry.started,
        success: entry.success,
        failure: entry.failure,
        cancelled: entry.cancelled,
        unknown: entry.unknown,
        activity: entry.activity,
        lastError: entry.lastError,
        lastActivityAt: entry.lastActivityAt,
        lastOutcome: lastOutcomeOf(state, sessionId, entry.employeeKey),
      }
    })
    sessions[sessionId] = {
      employees,
      posts: postView.posts.map((post) => ({
        ...post,
        lastFinished: post.lastFinished,
      })),
      uncategorized: postView.uncategorized,
      /** 员工日志：按时间倒序的调用事件流（岗位视图只保留"最近一次"，日志要序列）。 */
      events: buildEventLog(state, sessionId),
      /** 岗位固定 → 工位固定：下标即岗位下标。 */
      postStation: postView.byStation,
    }
  }

  return {
    version: BRIDGE_SNAPSHOT_VERSION,
    updatedAt: options.now ?? state.now(),
    connection: state.connection,
    activeSession: options.activeSession ?? null,
    stats: { ...state.stats },
    sessionStats: Object.fromEntries([...state.sessionStats].map(([id, value]) => [id, { ...value }])),
    unassignedTools: Object.fromEntries(state.unassignedTools),
    assignment: { byStation: [...assignment.byStation], overflow: [...(assignment.overflow ?? [])] },
    attribution: options.attribution ?? null,
    /** 模型自身的活动（思维流 / 写入 / 派活 / token 计数）。缺失时客户端写"未知"。 */
    model: options.model ?? null,
    /** 资源位置（由宿主按包位置解析）：客户端据此读取 GLB 与美术图，避免写死绝对路径。 */
    assets: options.assets ?? null,
    sessions,
  }
}

/** 供宿主侧桥接使用的终态判定输入，字段名与引擎一致（§4.3 / §4.8）。 */
export function outcomePayload(input) {
  // 空字符串 = 没有错误信息。成功调用会走到这里且 message 为 ''，
  // 若原样透传，引擎会把它当成"有错误"，面板就会出现悬空的「最近错误：」。
  const message = typeof input?.errorMessage === 'string' && input.errorMessage.length > 0 ? input.errorMessage : undefined
  return {
    isError: Boolean(input?.isError),
    cancelled: input?.cancelled === true,
    signalAborted: input?.signalAborted === true,
    errorMessage: message,
  }
}

export { OUTCOME }
