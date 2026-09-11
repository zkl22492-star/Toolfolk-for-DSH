/**
 * 卸载清理验证驱动（仅测试用，不进产品）
 *
 * 回答的问题：插件被卸载后，它通过 ctx 注册的监听器与包装层是否真的被释放？
 * 官方教程承诺「通过 ctx 注册的任何东西在插件卸载时都会被自动清理」，
 * 但这条承诺尚未实测，而它决定我们所有注册逻辑的正确性
 * （残留的 tools/execute 包装层会叠加，改变调用链结构）。
 *
 * 做法：
 *   阶段一  正常状态下发起一次合成工具调用 + 一次合成事件
 *   阶段二  程序化卸载 studio-probe 的 fiber
 *   阶段三  再次发起合成工具调用 + 合成事件
 *   判定    after 阶段若仍出现 studio-probe 的输出 → 监听器泄漏
 *
 * 合成调用用公开 API `ctx.tools.execute(ToolExecutionInput)`，不需要模型。
 */

export const name = 'probe-unload-test'
export const inject = ['tools']

const PREFIX = '[unload-test]'
const TARGET_ID = 'studio-probe'
const READ_TARGET = 'L:/Toolfolk for DSH/package.json'

export function apply(ctx) {
  function log(kind, payload) {
    try {
      process.stdout.write(PREFIX + ' ' + JSON.stringify({ kind, ts: Date.now(), ...payload }) + '\n')
    } catch {
      // 记录失败不得影响宿主
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * 通过公开 API 发起一次真实工具调用。
   * 它会完整穿过 tools/pre-execute → guards → tools/execute → tools/post-execute → tools/result，
   * 因此 studio-probe 的包装层一定会经过——这正是我们要观察的对象。
   */
  async function syntheticCall(tag) {
    const callId = 'probe-unload-' + tag
    const startedAt = Date.now()
    try {
      if (typeof ctx.tools.execute !== 'function') {
        log('synthetic-call', { tag, callId, error: 'ctx.tools.execute 不可用' })
        return
      }
      const result = await ctx.tools.execute({
        callId,
        name: 'read',
        arguments: { file_path: READ_TARGET },
        signal: new AbortController().signal,
      })
      log('synthetic-call', {
        tag,
        callId,
        ok: !(result && result.isError),
        isError: Boolean(result && result.isError),
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      log('synthetic-call-threw', { tag, callId, message: String(error && error.message) })
    }
  }

  /** 合成事件：只有 studio-probe 监听这个自定义事件名。 */
  function syntheticEcho(tag) {
    try {
      if (typeof ctx.emit !== 'function') {
        log('synthetic-echo', { tag, error: 'ctx.emit 不可用' })
        return
      }
      ctx.emit('studio-probe/echo', { tag })
      log('synthetic-echo', { tag, emitted: true })
    } catch (error) {
      log('synthetic-echo', { tag, error: String(error && error.message) })
    }
  }

  function findTarget() {
    try {
      const loader = typeof ctx.get === 'function' ? ctx.get('loader') : ctx.loader
      if (loader === null || loader === undefined || typeof loader.entries !== 'function') return null
      return [...loader.entries()].find(
        (entry) => entry && entry.options && entry.options.id === TARGET_ID,
      ) ?? null
    } catch (error) {
      log('find-target-error', { message: String(error && error.message) })
      return null
    }
  }

  async function run() {
    log('phase', { name: 'before-unload' })
    await syntheticCall('before')
    syntheticEcho('before')
    await sleep(300)

    const target = findTarget()
    if (target === null) {
      log('fatal', { message: '未找到目标插件条目: ' + TARGET_ID })
      return
    }
    const fiber = target.fiber
    log('unload-target', {
      id: target.options.id,
      stateBefore: fiber ? fiber.state : null,
      hasDispose: Boolean(fiber && typeof fiber.dispose === 'function'),
    })

    let disposed = false
    let disposeError = null
    try {
      if (fiber && typeof fiber.dispose === 'function') {
        await fiber.dispose()
        disposed = true
      } else {
        disposeError = 'fiber.dispose 不可用'
      }
    } catch (error) {
      disposeError = String(error && error.message)
    }
    log('unload-done', {
      disposed,
      disposeError,
      stateAfter: fiber ? fiber.state : null,
    })
    await sleep(500)

    log('phase', { name: 'after-unload' })
    await syntheticCall('after')
    syntheticEcho('after')
    await sleep(300)

    log('verdict', {
      howToRead: [
        '看 studio-probe 的输出：',
        'after 阶段的 call-start / echo 消失 → 监听器已随 fiber 释放，自动清理有效',
        'after 阶段仍出现 call-start / echo → 监听器泄漏，卸载未清理',
      ],
    })
  }

  ctx.effect(() => {
    const timer = setTimeout(() => {
      run().catch((error) => log('driver-error', { message: String(error && error.message) }))
    }, 2500)
    return () => clearTimeout(timer)
  })

  log('driver-loaded', { target: TARGET_ID, readTarget: READ_TARGET })
}
