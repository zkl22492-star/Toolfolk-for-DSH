/**
 * 工具 → 员工的归属解析
 *
 * 依据 docs/integration-findings.md §4.6.5：官方运行时**不提供**工具归属信息
 * （注册表无 owner 字段、schema 无归属、fiber 不可枚举），唯一可用的显式映射是
 * 官方生成式工具目录 `tool-package-map.json`（工具名 ↔ 插件包名）。
 *
 * **归属以官方目录为准，员工身份 = 插件包名（moduleName）。**
 *
 * 为什么不再要求"插件必须在 loader 名册里"（2026-09-11 实测纠正，两次）：
 *   - 第一次错在把「运行时工具名册」当过滤条件：一次成功的 `read` 调用，全局名册只有
 *     4 个工具且不含 `read`（工具注册在 agent 作用域层，全局视图看不到），于是这笔调用
 *     被错记成「外包」。→ 名册只提升置信度，不做过滤。
 *   - 第二次错在把「loader 插件名册」当必需项：**web profile 下工具插件根本不进
 *     `ctx.loader.entries()`**（实测 159 条里 0 条命中目录），于是全部调用都落「外包」、
 *     一个工位都建不出来，3D 里什么都看不到。headless 下同一份代码却能解出 12 个员工。
 *
 *   → 结论：**一笔真实调用本身就是"该插件存在"的证据**。工具名在官方目录里能唯一落到
 *     某个包，就直接归属给那个包；loader 名册只用来拿更好看的显示名与提升置信度。
 *     仍然**不做命名猜测**：只有目录里明确写着的工具才算数，同名跨包保持歧义不猜。
 */

/** 置信度：运行时名册确认过 / 只由官方目录确认。 */
export const ATTRIBUTION = Object.freeze({
  EXACT: 'catalog',
  PLUGIN_ONLY: 'catalog-plugin',
})

/**
 * 基础设施包：它们**不占普通工位**（规划 MVP 要求）。
 *
 * `@deepseek-ai/dsh-tools` 是工具注册表本体，官方目录把 `run_code`（PTC 代码运行）
 * 映到它。实测它随基础包在启动时就已加载，若不过滤，工作室会凭空多出一个
 * 「tools 员工」——而它其实是工位本身，不是工人。
 */
export const INFRASTRUCTURE_MODULES = Object.freeze(new Set(['@deepseek-ai/dsh-tools']))

/** 由包名取一个短显示名：`@deepseek-ai/dsh-tool-fs` → `tool-fs`。 */
export function deriveLabel(moduleName) {
  return String(moduleName).replace(/^@[^/]+\//, '').replace(/^dsh-/, '')
}

export function createEmployeeResolver(catalog, plugins = [], tools = []) {
  const runtimeNames = new Set(
    tools.map((tool) => (typeof tool === 'string' ? tool : tool?.name)).filter((name) => typeof name === 'string'),
  )
  // 包名 → 已加载的插件条目（可能多个条目共用一个包；员工按包算，不按条目算）
  const loadedByModule = new Map()
  for (const plugin of plugins) {
    if (plugin === null || plugin === undefined || plugin.enabled === false) continue
    if (typeof plugin.moduleName !== 'string' || plugin.moduleName.length === 0) continue
    const list = loadedByModule.get(plugin.moduleName) ?? []
    list.push(plugin)
    loadedByModule.set(plugin.moduleName, list)
  }

  const candidates = new Map()
  for (const table of [catalog.map, catalog.aliases]) {
    for (const [tool, moduleName] of Object.entries(table ?? {})) {
      if (tool.startsWith('_')) continue
      if (INFRASTRUCTURE_MODULES.has(moduleName)) continue
      const matches = new Map()
      for (const plugin of loadedByModule.get(moduleName) ?? []) {
        matches.set(moduleName, {
          key: moduleName,
          label: plugin.label ?? deriveLabel(moduleName),
          moduleName,
        })
      }
      // 工具名同时出现在 map 与 aliases 里且指向不同包 → 候选变多 → 保持歧义不猜
      const existing = candidates.get(tool)
      if (existing === undefined) {
        candidates.set(tool, matches)
      } else {
        for (const [key, value] of matches) existing.set(key, value)
      }
    }
  }

  // 目录里写着、包名可确定的工具，即使插件条目暂时看不到，也允许归属。
  // 置信度只表示"运行时名册是否也确认了它"。
  const catalogOnly = new Map()
  for (const table of [catalog.map, catalog.aliases]) {
    for (const [tool, moduleName] of Object.entries(table ?? {})) {
      if (tool.startsWith('_')) continue
      if (INFRASTRUCTURE_MODULES.has(moduleName)) continue
      if (!catalogOnly.has(tool)) catalogOnly.set(tool, new Set())
      catalogOnly.get(tool).add(moduleName)
    }
  }

  const resolve = (toolName) => {
    const confidence = runtimeNames.has(toolName) ? ATTRIBUTION.EXACT : ATTRIBUTION.PLUGIN_ONLY
    const matches = candidates.get(toolName)
    if (matches !== undefined && matches.size > 0) {
      // 运行时已知归属：同名跨包（如 bash 的一次性版与持久版同时在场）不猜
      if (matches.size !== 1) return null
      return { ...matches.values().next().value, confidence }
    }
    // 运行时看不到该工具（agent 平面）→ 退回目录：目录唯一指向一个包就归属
    const modules = catalogOnly.get(toolName)
    if (modules === undefined || modules.size !== 1) return null
    const moduleName = [...modules][0]
    return { key: moduleName, label: deriveLabel(moduleName), moduleName, confidence }
  }

  // 员工名册：目录里能**唯一**归属到某个包的工具，其所属包才建工位。
  const rosterEntries = new Map()
  const addRoster = (moduleName) => {
    if (INFRASTRUCTURE_MODULES.has(moduleName)) return
    if (rosterEntries.has(moduleName)) return
    const plugin = (loadedByModule.get(moduleName) ?? [])[0]
    rosterEntries.set(moduleName, {
      entryId: moduleName,
      moduleName,
      label: plugin?.label ?? deriveLabel(moduleName),
    })
  }
  for (const [tool, modules] of catalogOnly) {
    if (modules.size !== 1) continue
    const moduleName = [...modules][0]
    // 空工位只给**确实已安装**的插件：目录里列着但本机没装的包不该出现在工作室里，
    // 否则会凭空多出一屋子"员工"。真实调用仍然可以归属（见 resolve）——
    // 那种情况下调用本身就是插件存在的证据，由调用创建工位。
    if (!loadedByModule.has(moduleName)) continue
    // 运行时已知的同名歧义（map 与 aliases 指向不同包且都在场）不建工位
    const matches = candidates.get(tool)
    if (matches !== undefined && matches.size > 1) continue
    addRoster(moduleName)
  }

  resolve.roster = [...rosterEntries.values()]
  /** 名册级状态：运行时名册是否有内容（有内容才有工具能被"确认"）。 */
  resolve.runtimeToolCount = runtimeNames.size
  return resolve
}
