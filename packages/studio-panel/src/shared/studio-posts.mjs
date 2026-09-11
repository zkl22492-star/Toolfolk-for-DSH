/**
 * 固定岗位与"正在做什么"（工位职责固定化）
 *
 * 产品依据：产品构想文档「插件 = 员工、**工位 = 岗位**、调用 = 任务」。
 * 岗位职责固定后，插件不再是"占座的人"，而是**在这个岗位上干活的承包方**；
 * 座位也不再依赖插件发现（web profile 下"要等第一次调用才有员工"、"未落座/溢出"这些问题随之消失）。
 *
 * 表述纪律（用户 2026-09-11 明确要求）：
 *   岗位显示的是「**正在做某件事**」，不是统计。所以主文案是现在进行时的一句话
 *   （"正在联网调查：deepseek cordis 插件"），由**真实调用的参数**推出来；
 *   计数只作为次要信息，不能占据主位。
 *
 * 数据来源：
 *   - `tool/call` 事件带 `name` 与原始 `arguments`（JSON 字符串）
 *   - `tools/execute` 的 `exec.arguments`（已解析对象）
 *   两者都能拿到参数，所以"阅读哪个文件""搜什么词""跑什么命令"是**真实信息**，不是编的。
 */

/**
 * 六个固定岗位。
 * `toolKeys` 用来把工具名归到岗位；未知工具**不硬塞**，另列"未分类"。
 */
/**
 * 岗位顺序**必须与房间里座位的姿势/道具对齐**（工位 i = 岗位 i）：
 *   座位 0 研究席(打字/双屏)    → 资料检索
 *   座位 1 工程席(打字/代码屏)  → 撰写修改
 *   座位 2 设计席(打字/数位板)  → 联网调查   ← 道具待换成资料台
 *   座位 3 档案席(捧卷宗阅读)   → 会话记忆   ← 姿势天生贴（档案=记忆）
 *   座位 4 文档席(打字/文档屏)  → 命令执行   ← 道具待换成终端屏
 *   座位 5 助理席(端咖啡)       → 协作调度   ← 姿势天生贴（助理=跑腿协调）
 * 为什么必须对齐：动作是按姿势分开生成的（asset-kit-v2 的 WORK 表），
 * 若岗位与座位错配，就会出现"捧着卷宗的人在联网调查"这种一眼假的画面。
 */
export const POST_DEFINITIONS = Object.freeze([
  {
    key: 'research',
    title: '资料检索',
    /** 坐着的人在干什么（现在进行时）。 */
    doing: '正在翻查资料',
    tools: ['read', 'read_image', 'glob', 'grep', 'lsp'],
  },
  {
    key: 'write',
    title: '撰写修改',
    doing: '正在改写文件',
    tools: ['write', 'edit', 'str_replace_editor'],
  },
  {
    key: 'web',
    title: '联网调查',
    doing: '正在联网调查',
    tools: ['web_search', 'web_fetch', 'skill'],
  },
  {
    key: 'memory',
    title: '会话记忆',
    doing: '正在翻查会话记录',
    tools: ['session_search', 'session_event_search', 'session_event_read', 'session_event_trace', 'session_trace'],
  },
  {
    key: 'exec',
    title: '命令执行',
    doing: '正在运行命令',
    tools: ['pwsh', 'bash', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_list', 'terminal_close', 'job_list', 'job_output', 'job_kill', 'run_code'],
  },
  {
    key: 'collab',
    title: '协作调度',
    doing: '正在协调调度',
    tools: ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent', 'todo_write', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'schedule_create', 'schedule_list', 'schedule_delete', 'workflow', 'ralph', 'present', 'ask_user_question'],
  },
])

const POST_OF_TOOL = new Map()
for (const [index, post] of POST_DEFINITIONS.entries()) {
  for (const tool of post.tools) POST_OF_TOOL.set(tool, index)
}

/** 工具名 → 岗位下标；未收录返回 null（调用方应把它列进"未分类"，不要硬塞给某个岗位）。 */
export function postIndexOfTool(toolName) {
  if (typeof toolName !== 'string') return null
  const index = POST_OF_TOOL.get(toolName)
  return index === undefined ? null : index
}

/** 从参数里挑出最能说明"在干什么"的那一项。 */
function salientArgument(toolName, args) {
  if (args === null || args === undefined || typeof args !== 'object') return null
  const pick = (...keys) => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return null
  }
  switch (toolName) {
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit':
    case 'str_replace_editor':
      return pick('file_path', 'path', 'filePath')
    case 'glob':
    case 'grep':
      return pick('pattern', 'query')
    case 'pwsh':
    case 'bash':
    case 'run_code':
      return pick('command', 'code')
    case 'web_search':
      return pick('query', 'q')
    case 'web_fetch':
      return pick('url')
    case 'session_search':
    case 'session_event_search':
    case 'session_event_read':
    case 'session_event_trace':
    case 'session_trace':
      return pick('query', 'text', 'pattern')
    case 'skill':
      return pick('name', 'skill')
    case 'subagent':
    case 'send_message':
      return pick('prompt', 'message', 'name', 'agent')
    case 'todo_write':
      return null
    case 'ask_user_question':
      return pick('question')
    default:
      return pick('file_path', 'path', 'query', 'command', 'url', 'pattern', 'name')
  }
}

/** 把参数压成短标签：路径只留文件名，命令/查询截断。 */
export function shortenSubject(toolName, raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let text = raw.replace(/\s+/g, ' ').trim()
  if (toolName === 'read' || toolName === 'read_image' || toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor') {
    const parts = text.split(/[\\/]/)
    text = parts[parts.length - 1] || text
  }
  const LIMIT = 42
  return text.length > LIMIT ? text.slice(0, LIMIT) + '…' : text
}

/** 参数可能是 JSON 字符串（会话事件）或已解析对象（tools/execute）。 */
export function parseArguments(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw)
    // 数组/标量都不是"参数对象"，不能当参数用
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 生成"正在做某事"的一句话。
 * 拿不到具体参数时退回岗位动词或工具名——**不编造细节**。
 */
export function describeAction(toolName, rawArguments) {
  const index = postIndexOfTool(toolName)
  const post = index === null ? null : POST_DEFINITIONS[index]
  const args = parseArguments(rawArguments)
  const subject = shortenSubject(toolName, salientArgument(toolName, args))
  if (post === null) return `正在执行 ${String(toolName)}${subject === null ? '' : '：' + subject}`
  return subject === null ? `${post.doing}…` : `${post.doing}：${subject}`
}

/**
 * 按岗位聚合当前活动。
 *
 * 主文案 = 正在做的那件事（可能多件）；其次才是"刚做完"和计数。
 * @returns {{ posts: object[], uncategorized: object[], byStation: (string|null)[] }}
 */
/**
 * 员工日志：把会话里的调用按时间倒序排成事件流。
 *
 * 为什么要在数据层做：原来每个岗位只保留"最近一次"（`lastFinished`），那是**状态**不是**日志**。
 * 面板要改成"员工日志"记录事件，就得有序列。这里只取真实字段：时间、岗位、工具、动作、终态、耗时。
 * @param {object} state
 * @param {string} sessionId
 * @param {number} limit 上限（倒序取最近的 N 条）
 */
export function buildEventLog(state, sessionId, limit = 80) {
  const rows = []
  for (const record of state.calls.values()) {
    if (record.sessionId !== sessionId) continue
    const index = postIndexOfTool(record.toolName)
    const post = index === null ? null : POST_DEFINITIONS[index]
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : null
    const finishedAt = typeof record.finishedAt === 'number' ? record.finishedAt : null
    rows.push({
      callId: record.callId,
      at: finishedAt ?? startedAt,
      running: record.outcome === 'running',
      postKey: post === null ? null : post.key,
      postTitle: post === null ? null : post.title,
      toolName: record.toolName,
      // 日志里用短句：去掉"正在"前缀，动作 + 主题
      doing: describeAction(record.toolName, record.argumentsPreview).replace(/^正在/, ''),
      outcome: record.outcome,
      // 耗时只在两端时间都有时才给；缺开始时间就写 null（不补零）
      durationMs: startedAt !== null && finishedAt !== null ? finishedAt - startedAt : null,
      errorMessage: record.errorMessage ?? null,
      startMissing: record.startMissing === true,
      thought: record.thoughtPreview ?? null,
    })
  }
  rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return rows.slice(0, limit)
}

export function buildPosts(state, sessionId) {
  const now = state.now()
  const posts = POST_DEFINITIONS.map((definition, index) => ({
    index,
    key: definition.key,
    title: definition.title,
    doing: definition.doing,
    running: [],
    lastFinished: null,
    started: 0,
    success: 0,
    failure: 0,
    cancelled: 0,
    providers: [],
    lastActivityAt: null,
  }))
  const uncategorized = new Map()

  for (const record of state.calls.values()) {
    if (record.sessionId !== sessionId) continue
    const index = postIndexOfTool(record.toolName)
    if (index === null) {
      const entry = uncategorized.get(record.toolName) ?? { toolName: record.toolName, count: 0, running: 0 }
      entry.count += 1
      if (record.outcome === 'running') entry.running += 1
      uncategorized.set(record.toolName, entry)
      continue
    }
    const post = posts[index]
    // 承包方显示短名（tool-fs），包名留给详情
    const provider = record.employeeLabel ?? record.moduleName ?? null
    if (provider !== null && !post.providers.includes(provider)) post.providers.push(provider)
    if (record.startMissing !== true) post.started += 1
    if (record.outcome === 'running') {
      post.running.push({
        callId: record.callId,
        toolName: record.toolName,
        doing: describeAction(record.toolName, record.argumentsPreview),
        /** 这次任务对应的思维流（可能为 null：模型没产出推理时如实为空） */
        thought: record.thoughtPreview ?? null,
        startedAt: record.startedAt,
      })
      continue
    }
    if (record.outcome === 'success') post.success += 1
    else if (record.outcome === 'failure') post.failure += 1
    else if (record.outcome === 'cancelled') post.cancelled += 1
    if (record.finishedAt !== null && (post.lastActivityAt === null || record.finishedAt > post.lastActivityAt)) {
      post.lastActivityAt = record.finishedAt
    }
    // 最近完成的一件（用于"刚做完：…"）
    if (
      record.finishedAt !== null &&
      (post.lastFinished === null || record.finishedAt > post.lastFinished.finishedAt)
    ) {
      post.lastFinished = {
        toolName: record.toolName,
        doing: describeAction(record.toolName, record.argumentsPreview),
        thought: record.thoughtPreview ?? null,
        outcome: record.outcome,
        finishedAt: record.finishedAt,
      }
    }
  }

  return {
    posts,
    uncategorized: [...uncategorized.values()],
    /** 岗位 → 工位一一对应：岗位是固定的，所以映射也是固定的。 */
    byStation: posts.map((post) => (post.running.length > 0 ? post.key : null)),
    now,
  }
}
