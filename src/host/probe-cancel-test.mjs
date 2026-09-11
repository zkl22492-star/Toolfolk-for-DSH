/**
 * 取消行为验证驱动（仅测试用，不进产品）
 *
 * 回答两个问题：
 *   场景 A「进入时已中止」：信号在入口就已中止 → 官方契约说流水线被短路
 *     （跳过 pre-execute / 审批 / tools/execute / post-execute / 工具主体），
 *     只发布一次 tools/result。预期：我们的 tools/execute 包装层**收不到**，
 *     但 tools/result 会收到 —— 也就是只能看到一个"孤立结束"。
 *   场景 B「执行中取消」：工具主体已启动后取消 → 预期得到 ABORTED，
 *     且注册表**不会与 promise 竞速**，会等主体完全停稳后才返回。
 *     因此要测量"从取消到返回"的真实耗时，这决定 3D 场景里
 *     "取消后员工还要忙多久"。
 *
 * 官方契约：.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.zh.md
 */

export const name = 'probe-cancel-test'
export const inject = ['tools']

const PREFIX = '[cancel-test]'

export function apply(ctx) {
  function log(kind, payload) {
    try {
      process.stdout.write(PREFIX + ' ' + JSON.stringify({ kind, ts: Date.now(), ...payload }) + '\n')
    } catch {
      // 记录失败不得影响宿主
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 发起一次调用，返回耗时与结果摘要；不抛异常，把异常也当数据记录。 */
  async function call(callId, name, args, signal) {
    const startedAt = Date.now()
    try {
      const result = await ctx.tools.execute({ callId, name, arguments: args, signal })
      return {
        returned: true,
        durationMs: Date.now() - startedAt,
        isError: Boolean(result && result.isError),
        errorMessage: result && result.isError && result.error ? String(result.error.message ?? '') : undefined,
        signalAborted: signal.aborted,
      }
    } catch (error) {
      return {
        threw: true,
        durationMs: Date.now() - startedAt,
        errorName: error && error.name,
        errorMessage: String(error && error.message),
        signalAborted: signal.aborted,
      }
    }
  }

  async function run() {
    // ── 场景 A：进入时已中止 ───────────────────────────────────────────
    log('phase', { name: 'A-aborted-at-entry', expect: 'ABORTED_BEFORE_DISPATCH，且 tools/execute 不应被调用' })
    const preAborted = new AbortController()
    preAborted.abort()
    const a = await call('probe-cancel-entry', 'read', { file_path: 'L:/Toolfolk for DSH/package.json' }, preAborted.signal)
    log('scenario-A', { ...a })
    await sleep(400)

    // ── 场景 B：执行中取消 ─────────────────────────────────────────────
    log('phase', {
      name: 'B-abort-mid-flight',
      expect: '得到 ABORTED；注册表等主体停稳，因此耗时应接近脚本自身停止时间而非取消时刻',
    })
    const mid = new AbortController()
    const abortAt = 400
    setTimeout(() => {
      log('abort-fired', { atMs: abortAt })
      mid.abort()
    }, abortAt)
    const b = await call(
      'probe-cancel-mid',
      'pwsh',
      { command: 'Start-Sleep -Seconds 5; Write-Output done', description: 'cancel probe sleep' },
      mid.signal,
    )
    log('scenario-B', { abortAtMs: abortAt, ...b })

    log('verdict', {
      howToRead: [
        '对比 [studio-probe] 的 call-start / call-end / result：',
        'A: 若只有 result 没有 call-start → 流水线确实被短路，包装层未参与',
        'A: call-end.cancelled 与 result 的 errorMessage 应指向 aborted',
        'B: call-end 应出现 cancelled:true；durationMs 反映「取消后还要等多久」',
      ],
    })
  }

  ctx.effect(() => {
    const timer = setTimeout(() => {
      run().catch((error) => log('driver-error', { message: String(error && error.message) }))
    }, 2500)
    return () => clearTimeout(timer)
  })

  log('driver-loaded', { scenarios: ['A-aborted-at-entry', 'B-abort-mid-flight'] })
}
