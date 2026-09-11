/**
 * dsh-studio-panel · 客户端图自检（开发用，**不进分发包**）
 *
 * 职责：验证「官方 UI 扩展入口」这条链路的**宿主部分**——
 *   1. 宿主是否扫描到本包的 `dsh.client` 声明
 *   2. 组合出的启动图（window.__DSH_BOOT__）里是否出现本包的行
 *   3. 该行的 bundle 路径与 `/plugins` combo URL 是否可解析
 *
 * 浏览器半侧（视图注册）在 `src/client/`。
 *
 * 契约来源（reference/deepseek-harness）：
 *   - docs/subsystems/client-modules.zh.md —— 扫描、bundle 路由、启动图
 *   - packages/client/modules/README.zh.md —— dsh.client 声明与构建要求
 */

export const name = 'dsh-studio-panel-graph-check'

/** clientModules = ctx.clientModules（ClientModuleRegistry，扫描与启动图服务） */
export const inject = ['clientModules']

const PREFIX = '[studio-panel]'
const PACKAGE_NAME = 'dsh-studio-panel'

export function apply(ctx) {
  function log(kind, payload) {
    try {
      process.stdout.write(PREFIX + ' ' + JSON.stringify({ kind, ts: Date.now(), ...payload }) + '\n')
    } catch {
      // 记录失败不得影响宿主
    }
  }

  function reportGraph(why) {
    const report = { why }
    try {
      const graph = ctx.clientModules.graph()
      report.graphRev = graph.rev
      report.entryCount = graph.entries.length
      report.batches = graph.batches.map((batch) => ({ phase: batch.phase, url: batch.url, entries: batch.entries }))

      const ours = graph.entries.find((entry) => entry.id === PACKAGE_NAME)
      report.hasOurRow = Boolean(ours)
      report.ourRow = ours
        ? { id: ours.id, url: ours.url, rev: ours.rev, immediately: ours.immediately ?? null, external: ours.external ?? null }
        : null

      if (typeof ctx.clientModules.clientPath === 'function') {
        report.clientPath = ctx.clientModules.clientPath(PACKAGE_NAME) ?? null
      }
      report.allRowIds = graph.entries.map((entry) => entry.id)
    } catch (error) {
      report.error = String(error && error.message)
    }
    log('client-graph', report)
  }

  log('host-loaded', { inject: ['clientModules'] })

  // 宿主异步组合启动图，启动瞬间可能还没扫到；分两次采样。
  ctx.effect(() => {
    const early = setTimeout(() => reportGraph('t+2s'), 2000)
    const late = setTimeout(() => reportGraph('t+6s'), 6000)
    return () => {
      clearTimeout(early)
      clearTimeout(late)
    }
  })

  ctx.effect(() => ctx.clientModules.onGraphChanged(() => reportGraph('graph-changed')))
}
