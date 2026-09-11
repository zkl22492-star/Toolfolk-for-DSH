/**
 * 状态桥接自检驱动（仅测试用，不进产品）
 *
 * 回答的问题：`studio-bridge` 是否真的把真实工具调用事件变成了状态快照文件？
 *
 * 为什么用合成调用而不是让模型跑任务：
 *   `ctx.tools.execute(...)` 是公开 API，会完整穿过
 *   pre-execute → guards → tools/execute → post-execute → tools/result 流水线，
 *   **不需要模型、不需要凭据**，因此可以在无人值守下确定性地验证桥接。
 *
 * 覆盖：成功 / 失败 / 取消（进入时已中止）/ 并发，随后读回状态文件逐项核对；
 *       再验一遍**工作区副本 + 相对路径读**——发行形态下客户端就靠这条通路找到宿主状态
 *       （绝对路径是构建期算的，换机器必然指错；相对路径按会话 header.cwd 解析，任何机器都成立）。
 * 局限：合成调用不经过 `session/event`，会话标识为 `unknown`（这与 M1 的实测一致）。
 *       真实会话身份需要模型真实调用，本驱动不覆盖。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { studioStatePath } from '../../packages/studio-panel/src/shared/studio-state-path.mjs'

export const name = 'bridge-selftest'
export const inject = ['tools']

const PREFIX = '[bridge-selftest]'
const READ_OK = 'L:/Toolfolk for DSH/package.json'
const READ_MISSING = 'L:/Toolfolk for DSH/tmp/__bridge-selftest-missing__.txt'
// 状态文件位置与宿主同源：`<DSH_HOME|home>/.dsh/studio/state.json`
const STATE_PATH = studioStatePath(
  process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : homedir(),
  process.env.DSH_STUDIO_STATE,
)

export function apply(ctx) {
  function log(kind, payload) {
    try {
      process.stdout.write(PREFIX + ' ' + JSON.stringify({ kind, ts: Date.now(), ...payload }) + '\n')
    } catch {
      // 记录失败不得影响宿主
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function call(callId, filePath, signal) {
    try {
      const result = await ctx.tools.execute({
        callId,
        name: 'read',
        arguments: { file_path: filePath },
        signal: signal ?? new AbortController().signal,
      })
      return {
        callId,
        isError: Boolean(result && result.isError),
        error: result && result.isError && result.error ? String(result.error.message ?? '') : undefined,
      }
    } catch (error) {
      return { callId, threw: String(error && error.message) }
    }
  }

  async function run() {
    const bridge = typeof ctx.get === 'function' ? ctx.get('studioBridge') : null
    log('bridge-service', bridge === null || bridge === undefined ? { available: false } : { available: true, ...bridge.report() })

    // 1. 成功
    log('call', await call('bt-ok-1', READ_OK))
    // 2. 失败：工具失败**不抛异常**，以 isError 表达（§4.3）
    log('call', await call('bt-fail-1', READ_MISSING))
    // 3. 取消：信号在进入时就已中止 → 流水线被短路，应只产生孤立结果（§4.8.1）
    const aborted = new AbortController()
    aborted.abort()
    log('call', await call('bt-abort-1', READ_OK, aborted.signal))
    // 4. 并发
    const concurrent = await Promise.all([call('bt-par-1', READ_OK), call('bt-par-2', READ_OK)])
    log('concurrent', { results: concurrent })

    // 等写盘防抖（250ms）落盘
    await sleep(1500)

    let snapshot
    try {
      snapshot = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    } catch (error) {
      log('verdict', { pass: false, reason: '状态文件读不到：' + String(error && error.message), statePath: STATE_PATH })
      return
    }

    const stats = snapshot.stats ?? {}
    const sessions = Object.keys(snapshot.sessions ?? {})
    const employees = (snapshot.sessions?.unknown?.employees ?? []).map((item) => ({
      key: item.employeeKey,
      desk: item.desk,
      status: item.status,
      running: item.runningCount,
      success: item.success,
      failure: item.failure,
      cancelled: item.cancelled,
      current: item.currentTools,
    }))

    const checks = [
      ['状态文件已写出', true],
      ['连接状态为 connected', snapshot.connection === 'connected'],
      ['调用被记录（started ≥ 4：1 失败路径 + 1 并发组两条 + 1 成功路径）', stats.started >= 4],
      // 本 profile 无 agent → 工具插件尚未随 preset 加载 → read 不可调用，调用应全部失败；
      // 关键性质是「失败被记为 failure 而不是成功」（§4.3）。
      ['失败被记录为 failure 而不是成功（§4.3）', stats.failure >= 1 && stats.success === 0],
      ['进入时已中止被记为 cancelled（§4.8.1，且不计为成功）', stats.cancelled >= 1],
      ['出现了 unknown 会话桶', sessions.includes('unknown')],
      ['快照带归属模式标注', snapshot.attribution !== null && typeof snapshot.attribution.mode === 'string'],
      ['基础设施包不占工位（无 tools 员工）', !employees.some((item) => item.key === 'tools')],
      ['快照版本为 1', snapshot.version === 1],
    ]

    log('state-file', {
      statePath: STATE_PATH,
      version: snapshot.version,
      connection: snapshot.connection,
      stats,
      sessions,
      employees,
      assignment: snapshot.assignment,
      attribution: snapshot.attribution,
      note: '本 profile 无 agent：工具插件尚未加载，员工列表为空属预期；真实会话（发出消息后）才会有工具插件上岗',
    })

    // ── 工作区副本 + 相对路径读：发行形态能不能找到状态文件，全看这一段 ──────
    // 用户目录那份是构建期算死的绝对路径，换台机器就指错；客户端因此优先读会话工作区里的
    // 相对路径副本。这里用**客户端同一个服务方法**（workspaceFiles.readAll）读一遍，
    // 验证「相对路径按会话 workspaceRoot 解析」这条通路真的成立。
    // 副本去向**问桥接要**（`studioBridge.report().workspaceCopies`），不在这里另抄一份逻辑——
    // 抄一份就会漂移：第一版自检只列了 sandbox 根，看不出漏掉了存储态会话的 cwd。
    const roots = (() => {
      try {
        const bridge = typeof ctx.get === 'function' ? ctx.get('studioBridge') : null
        const copies = bridge !== null && bridge !== undefined && typeof bridge.report === 'function'
          ? bridge.report().workspaceCopies
          : null
        if (!Array.isArray(copies)) return null
        return copies.map((path) => String(path).replace(/\/\.dsh-studio\/state\.json$/, ''))
      } catch (error) {
        log('workspace-roots-error', { message: String(error && error.message) })
        return null
      }
    })()
    if (roots === null) {
      log('workspace-roots', { roots: null, reason: '桥接未提供 workspaceCopies（studioBridge 服务不可用）' })
    } else {
      log('workspace-roots', { roots, snapshotSessionBuckets: sessions.length })
    }

    // 会话可见性：live 列表 vs 持久化列表。
    // 为什么要测：官方 workspaceFiles 解析会话工作区时，对"冷会话"要走 sessionPersistence 兜底，
    // 说明客户端在看的会话**可能不在** sessions.list() 里。若如此，宿主只按 live 会话写副本就会错开。
    try {
      const liveStore = typeof ctx.get === 'function' ? ctx.get('sessions') : null
      const liveIds = liveStore !== null && liveStore !== undefined && typeof liveStore.list === 'function'
        ? liveStore.list().map((item) => ({ id: String(item.id), cwd: item.header?.cwd ?? null }))
        : null
      const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
      const stored = persistence !== null && persistence !== undefined && typeof persistence.list === 'function'
        ? (await persistence.list()).map((item) => ({
          id: String(item.header?.id),
          cwd: item.header?.cwd ?? null,
          createdAt: item.header?.createdAt ?? null,
        }))
        : null
      log('session-visibility', { liveCount: liveIds === null ? null : liveIds.length, live: liveIds, storedCount: stored === null ? null : stored.length, stored })
    } catch (error) {
      log('session-visibility-error', { message: String(error && error.message) })
    }

    let copyOk = false
    const firstId = (() => {
      try {
        const live = ctx.get('sessions')
        const first = typeof live?.list === 'function' ? live.list()[0] : null
        return first !== null && first !== undefined && first.id !== undefined ? first.id : 'bridge-selftest'
      } catch {
        return 'bridge-selftest'
      }
    })()
    for (const root of roots ?? []) {
      const abs = root.replace(/[\\/]+$/, '') + '/.dsh-studio/state.json'
      let onDisk = null
      try {
        onDisk = JSON.parse(readFileSync(abs, 'utf8'))
      } catch {
        // 没写出来 / 不是 JSON —— 下面照实报
      }
      log('workspace-copy', {
        path: abs,
        written: onDisk !== null,
        version: onDisk === null ? null : onDisk.version,
        connection: onDisk === null ? null : onDisk.connection,
      })
      if (onDisk !== null) copyOk = true
      const workspaceFiles = typeof ctx.get === 'function' ? ctx.get('workspaceFiles') : null
      if (workspaceFiles === null || workspaceFiles === undefined || typeof workspaceFiles.readAll !== 'function') {
        log('workspace-relative-read', { ok: false, reason: 'workspaceFiles 服务不可用（headless profile 属预期）' })
        continue
      }
      try {
        const got = await workspaceFiles.readAll(
          { sessionId: firstId, workspaceRoot: root },
          '.dsh-studio/state.json',
          new AbortController().signal,
        )
        const text = Buffer.from(got.data, 'base64').toString('utf8')
        log('workspace-relative-read', {
          ok: true,
          relativePath: '.dsh-studio/state.json',
          workspaceRoot: root,
          absolutePath: got.absolutePath,
          bytes: text.length,
          version: got.version,
          sameAsHomeCopy: text === readFileSync(STATE_PATH, 'utf8'),
        })
      } catch (error) {
        log('workspace-relative-read', { ok: false, message: String(error && error.message) })
      }
    }
    checks.push(['会话工作区里写出了快照副本（客户端相对路径可达）', copyOk])

    for (const [label, pass] of checks) log('check', { label, pass })
    log('verdict', {
      pass: checks.every(([, pass]) => pass),
      note: '本自检只覆盖宿主侧桥接；3D 渲染与工位动画仍需用户目视验证',
    })
  }

  ctx.effect(() => {
    // 等桥接完成首轮名册刷新（loader/tools 就绪）
    const timer = setTimeout(() => {
      run().catch((error) => log('driver-error', { message: String(error && error.message) }))
    }, 3500)
    return () => clearTimeout(timer)
  })

  log('driver-loaded', { statePath: STATE_PATH })
}
