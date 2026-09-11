/**
 * toolfolk-for-dsh · 浏览器半侧源码
 *
 * 形态：在会话的视图切换器里增加第三个选项 —— **对话 / 轨迹 / 3D 工作室**。
 * （标签就叫「3D 工作室」：用户第一次进来不知道它是什么、在哪，名字里带 3D 更容易被找到。）
 * 选中「工作室」时，3D 场景铺满会话区，而**发消息的输入框保持原位**
 * （输入框是 `conversation.composer`，与 `conversation.view` 是兄弟 slot，天然不被覆盖）。
 *
 * 为什么这样做而不是浮动面板：
 *   - 产品文档 30.7 要求「从当前会话工作室开始」；第五原则要求「3D 不应该增加操作复杂度」。
 *     一个默认铺开、挡住工作区的浮动面板违反后者；视图切换器是用户已经熟悉的交互。
 *   - `conversation.view` 是「一次只渲染一个」的 list slot → **切走即卸载**，
 *     我们的清理逻辑自动执行，GPU 资源免费释放（对应 M5「连续开关 20 次无残留」）。
 *
 * 数据来源（本文件的核心，M3）：
 *   宿主桥接插件把状态引擎快照写成 JSON（studio-bridge.mjs），
 *   这里经 `remote.workspaceFiles.readAll` 读回，按**会话**匹配后驱动各工位动画。
 *   为什么走 Remote 读文件而不是自建接口：官方 Gateway 的 Remote 名单是构建期固定的，
 *   手写插件无法在运行时注册新的 Remote 方法；`workspaceFiles` 是唯一两端通用（含桌面端）
 *   且 M1 已实测可用的通道。详见 src/shared/studio-state-path.mjs（`src/shared/`，与宿主同一份）。
 *
 * 注册契约（reference/deepseek-harness @ c291e79）：
 *   ui-conversation/src/client/contract/slots.ts:156
 *     'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }
 *   参考实现：ui-trajectory/src/client/index.ts:77（轨迹视图就是注册进这个 slot 的）
 *   list 类 slot 的选项必须带 `id`（实测：缺 id 会报 `list slot "X" requires options.id`）。
 *
 * 为什么要打包：宿主提供的平台模块不含 three（`packages/client/web/src/platform.ts` 实测），
 * three 必须打进自己的 bundle。构建：node scripts/build-client.mjs
 */

import React from 'react'
import { loadStudioArt, installStudioArt } from '../shared/studio-art.mjs'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createStudioLighting, installStudioThemeRoot, observeStudioTheme } from '../shared/studio-lighting.mjs'
import { frameStudioCamera } from '../shared/studio-camera.mjs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export const name = 'toolfolk-for-dsh'

/** remote.workspaceFiles 是嵌套服务名，必须整体声明。 */
export const inject = ['slots', 'remote', 'remote.workspaceFiles', 'sessions']

const PACKAGE_NAME = 'toolfolk-for-dsh'
const VIEW_ID = 'studio'
/** 排在「轨迹」（order 10）之后。 */
const VIEW_ORDER = 20
/** 由构建脚本注入（见 scripts/build-client.mjs），避免把开发机绝对路径写死在源码里。 */
/* global __STUDIO_GLB_PATH__ */
const STUDIO_GLB =
  typeof __STUDIO_GLB_PATH__ === 'string' ? __STUDIO_GLB_PATH__ : 'assets/3d/v2/studio.glb'
const SESSION_RETRY_MS = 2000
const SESSION_MAX_ATTEMPTS = 6

/** 状态文件轮询间隔：数据层很便宜（一个小 JSON）。取 500ms 是为了不漏掉短调用。 */
const STATE_POLL_MS = 500
/** 失败高亮的保持时长，与状态引擎的活动窗口一致（30 秒）。 */
const ERROR_HOLD_MS = 30_000
/**
 * 一次调用结束后仍保留"刚干完活"动作的时长。
 *
 * 为什么需要：工具调用常常只有十几毫秒（实测 `read` 12ms），轮询无论如何都会整段错过，
 * 于是工位看起来永远不动。这是**展示平滑**，不是虚构状态——它只把刚发生过的真实活动
 * 多显示一会儿，不制造没有发生过的活动；面板同时显示真实的活动时间，不冒充"正在工作"。
 *
 * 取值依据（实测）：1.5 秒时用户从对话切到工作室就已经错过，看到的是全待机，
 * 会以为"根本没工作"。6 秒足够覆盖"发消息 → 切视图 → 看画面"这段操作时间。
 */
const RECENT_ACTIVE_MS = 6000
/** 工位动画的淡入淡出时长：产品要求动作平缓，不大面积闪烁。 */
const FADE_SECONDS = 0.35
/** 组合场景里的工位数，与 Station_0..5 一致。 */
const STATION_COUNT = 6

/**
 * 由构建脚本注入（`src/shared/studio-state-path.mjs` 计算，宿主用同一个函数）。
 * **只作开发形态兜底**：这是打包那台机器的绝对路径，换机器/换账号必然指错。
 */
/* global __STUDIO_STATE_PATH__ */
const STATE_PATH = typeof __STUDIO_STATE_PATH__ === 'string' ? __STUDIO_STATE_PATH__ : null

/**
 * 引导用的**会话工作区相对路径**——主路径。
 *
 * 为什么不是绝对路径：绝对路径在构建期算死（`DSH_HOME || homedir()`），装到别人机器上
 * 指的就是打包者的用户目录；而快照读不到时连 GLB 路径都拿不到（资源位置也走快照），
 * 工作室会整个打不开。`workspaceFiles.readAll` 官方支持工作区相对路径
 * （宿主实现按会话 `header.cwd` 解析，没有 cwd 时回退到 sandbox 工作区根），
 * 相对路径在任何机器上都成立，所以宿主在会话工作区里也写一份快照，这里优先读它。
 * 这个字符串必须与 host.mjs 的写入位置一致（同在 studio-state-path.mjs 定义）。
 */
const WORKSPACE_STATE_PATH = '.dsh-studio/state.json'

// ── 小工具 ────────────────────────────────────────────────────────────

/**
 * 解包 Remote 返回的信封。
 * 实测：Remote 结果形如 `{ ok, value }`，直接取 `.data` 会什么也拿不到。
 *
 * 失败时**必须把真实原因带出来**（`error.code` / `error.message`）：
 * 官方信封是 `{ ok:false, error:{ code, message, details } }`（gateway/client/index.ts）。
 * 早先这里只抛一句「Remote 调用被拒绝」，排查时看不出是"文件不存在"还是"服务不可用"——
 * 用户实测就撞上了这个：面板只说"被拒绝"，我无从判断。现在把 code 与 message 原样透出。
 */
function unwrapRemote(raw) {
  if (raw === null || raw === undefined) return raw
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const hasOk = Object.prototype.hasOwnProperty.call(raw, 'ok')
    const hasValue = Object.prototype.hasOwnProperty.call(raw, 'value')
    if (hasOk || hasValue) {
      if (raw.ok === false) throw new Error(describeRemoteError(raw.error))
      return hasValue ? raw.value : raw
    }
  }
  return raw
}

/** 把 Remote 的 error 字段压成一行可读原因（缺失字段就照实省略，不编造）。 */
function describeRemoteError(error) {
  if (error === null || error === undefined) return 'Remote 调用被拒绝（未带原因）'
  if (typeof error === 'string') return error
  const code = typeof error.code === 'string' ? error.code : ''
  const message = typeof error.message === 'string' ? error.message : ''
  const detail = code.length > 0 && message.length > 0 ? code + '：' + message : code || message
  return detail.length > 0 ? detail : 'Remote 调用被拒绝'
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function decodeUtf8(buffer) {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(buffer)
  return Buffer.from(buffer).toString('utf8')
}

/**
 * 读一份宿主状态快照，返回**第一个读到的**候选路径与快照。
 *
 * 候选顺序：上次生效的路径 → 会话工作区相对路径（可移植主路径）→ 构建期注入的绝对路径（开发兜底）。
 * 读不到不抛异常：把每条候选的失败原因收集起来交给调用方显示——排查时"为什么没读到"必须看得见，
 * 而不是一句"未知"。
 *
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 当前视图的会话 id（Remote 的 scope，也决定相对路径按哪个工作区解析）
 * @param {string|null} preferred 上次成功读到的路径，优先重试
 * @returns {Promise<{path: string|null, snapshot: object|null, failures: string[]}>}
 */
async function readStudioSnapshot(ctx, sessionId, preferred = null) {
  const candidates = []
  if (typeof preferred === 'string' && preferred.length > 0) candidates.push(preferred)
  candidates.push(WORKSPACE_STATE_PATH)
  if (typeof STATE_PATH === 'string' && STATE_PATH.length > 0 && !candidates.includes(STATE_PATH)) {
    candidates.push(STATE_PATH)
  }
  const failures = []
  for (const path of candidates) {
    try {
      const raw = unwrapRemote(
        await ctx.remote.workspaceFiles.readAll(sessionId, path, new AbortController().signal),
      )
      if (raw === null || raw === undefined || typeof raw.data !== 'string') {
        failures.push(path + '：没有返回数据')
        continue
      }
      return { path, snapshot: JSON.parse(decodeUtf8(base64ToArrayBuffer(raw.data))), failures }
    } catch (error) {
      failures.push(path + '：' + (error && error.message ? error.message : String(error)))
    }
  }
  return { path: null, snapshot: null, failures }
}

/**
 * 取一个可用于 Remote 调用的会话 id。
 * 实测：插件启动瞬间 `sessions.list` 还是 `phase='pending'`、`ids` 为空，**必须重试**。
 */
function resolveSessionId(ctx) {
  const list = ctx.sessions && ctx.sessions.list
  if (list === undefined || list === null) return null
  const snap = typeof list.getSnapshot === 'function' ? list.getSnapshot() : list
  const preferred = snap && (snap.current || snap.currentAddress)
  if (typeof preferred === 'string' && preferred.length > 0) return preferred
  const ids = snap && snap.ids
  if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'string') return ids[0]
  return null
}

function waitForSessionId(ctx, attempt = 1) {
  return new Promise((resolve) => {
    const found = resolveSessionId(ctx)
    if (found !== null) {
      resolve(found)
      return
    }
    if (attempt >= SESSION_MAX_ATTEMPTS) {
      resolve(null)
      return
    }
    setTimeout(() => {
      waitForSessionId(ctx, attempt + 1).then(resolve)
    }, SESSION_RETRY_MS)
  })
}

/**
 * 选择要展示的会话数据。
 *
 * 优先用视图自己的会话；宿主快照里没有时退回「最近有调用的会话」，
 * 再退回第一个会话——并**把实际用了哪一个显示出来**，不做无声兜底。
 */
function pickSession(snapshot, ownSessionId) {
  const sessions = snapshot && snapshot.sessions ? snapshot.sessions : {}
  if (ownSessionId !== null && sessions[ownSessionId] !== undefined) {
    return { sessionId: ownSessionId, data: sessions[ownSessionId], exact: true }
  }
  const active = snapshot ? snapshot.activeSession : null
  if (active !== null && active !== undefined && sessions[active] !== undefined) {
    return { sessionId: active, data: sessions[active], exact: false }
  }
  const keys = Object.keys(sessions)
  if (keys.length > 0) return { sessionId: keys[0], data: sessions[keys[0]], exact: false }
  return { sessionId: null, data: { employees: [] }, exact: false }
}

/**
 * 由**岗位**的实时活动决定该工位播什么动作。
 *
 * 岗位职责固定，所以"哪个工位在做哪类事"是固定的：工位 i = 岗位 i。
 * 取消**不算故障态**（产品文档 30.5-3）。
 */
/**
 * 临时关掉官方画在会话体两侧的 40px 拖拽条。
 *
 * 背景（用户实测反馈）：官方会话根渲染两个 `.widthHandle`——透明的 40px 条，
 * 绝对定位在会话体上、z-index 8，用来调聊天内容列宽；悬停时会画一条 3px 光晕
 * 并把光标改成 col-resize。工作室铺满会话区，这两条正好压在卡片左右边缘上，
 * 用户反馈"鼠标放上去就显示的可拉动条，有点不适"。
 *
 * 为什么不用官方开关 `data-conversation-composer-overlay`：那个属性在官方 CSS 里有
 * **四条**规则，除了把它俩 `display:none`，还会把视图改成全幅、输入框改成绝对定位浮层
 * （轨迹视图就是这种形态），会推翻当前"卡片 + 与输入框留间距"的布局。
 * 这里只精准关掉那两条，不动任何布局。
 *
 * 选择器用元素上的 `data-width-handle` 属性（官方自己写的稳定属性），不依赖哈希类名；
 * 将来若属性改名，规则匹配不到就什么都不发生，不会报错，也不会破坏页面。
 * 只在工作室挂载期间存在，卸载即移除，不影响对话/轨迹视图。
 * 用引用计数是为了防 HMR 重挂载时"我卸载时把别人注入的样式删掉"。
 */
let widthHandleMutes = 0

function muteWidthHandles() {
  const STYLE_ID = 'dsh-studio-hide-width-handles'
  widthHandleMutes += 1
  if (widthHandleMutes === 1) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = '[data-width-handle]{display:none !important}'
    document.head.appendChild(style)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    widthHandleMutes = Math.max(0, widthHandleMutes - 1)
    if (widthHandleMutes === 0) {
      const style = document.getElementById(STYLE_ID)
      if (style !== null) style.remove()
    }
  }
}

/**
 * 头顶气泡（CSS2D）。
 *
 * 用户要求：员工干活时头上冒气泡，气泡里是**他在做什么 / 在想什么**，
 * 而不是让人低头看面板。用 DOM 文字而不是画进贴图，是因为本环境读不到画面——
 * 气泡文字可以被选中复制，是唯一能核对的通道。
 */
function createBubbleElement() {
  const root = document.createElement('div')
  root.style.pointerEvents = 'none'
  const inner = document.createElement('div')
  inner.style.cssText = [
    'position:relative',
    'max-width:230px',
    'padding:6px 10px',
    'border-radius:11px',
    'background:var(--studio-surface,rgba(255,255,255,.94))',
    'border:1px solid var(--studio-border, #d9d5c6)',
    'color:var(--studio-text)',
    'font:12px/1.55 "Segoe UI","Microsoft YaHei",sans-serif',
    'box-shadow:0 3px 8px rgba(90,80,60,.14)',
    'white-space:pre-wrap',
    'opacity:0',
    'transition:opacity .25s ease',
  ].join(';')
  const text = document.createElement('div')
  // 第二行：这个员工这次任务对应的思维流（较小、较淡）
  const sub = document.createElement('div')
  sub.style.cssText = 'margin-top:3px;padding-top:3px;border-top:1px dashed var(--studio-border);color:var(--studio-muted);font-size:11px;line-height:1.45;display:none'
  const tail = document.createElement('div')
  tail.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:-5px',
    'width:9px',
    'height:9px',
    'margin-left:-5px',
    'background:var(--studio-surface,rgba(255,255,255,.94))',
    'border-right:1px solid var(--studio-border, #d9d5c6)',
    'border-bottom:1px solid var(--studio-border, #d9d5c6)',
    'transform:rotate(45deg)',
  ].join(';')
  inner.appendChild(text)
  inner.appendChild(sub)
  inner.appendChild(tail)
  root.appendChild(inner)
  return { root, inner, text, sub }
}

/** 更新气泡内容与显隐。内容为空即隐藏——不留空壳气泡。 */
function setBubble(bubble, message, opacity = 1, detail = '') {
  if (bubble === null || bubble === undefined) return
  const next = typeof message === 'string' ? message : ''
  const extra = typeof detail === 'string' ? detail : ''
  if (bubble.lastText !== next) {
    bubble.lastText = next
    bubble.text.textContent = next
  }
  if (bubble.lastDetail !== extra) {
    bubble.lastDetail = extra
    bubble.sub.textContent = extra
    bubble.sub.style.display = extra === '' ? 'none' : 'block'
    // 量一次尺寸供避让判定用（只在内容变化时量，不在每帧 getBoundingClientRect）
    bubble.lastWidth = bubble.inner.offsetWidth
    bubble.lastHeight = bubble.inner.offsetHeight
  }
  const visible = next.length > 0
  const target = visible ? opacity : 0
  if (bubble.visible !== visible || bubble.lastOpacity !== target) {
    bubble.visible = visible
    bubble.lastOpacity = target
    bubble.inner.style.opacity = String(target)
  }
}

function postAnimationState(post, now) {
  if (post === null || post === undefined) return 'idle'
  if (Array.isArray(post.running) && post.running.length > 0) return 'working'
  const last = post.lastFinished
  if (last !== null && last !== undefined && last.outcome === 'failure' && now - last.finishedAt < ERROR_HOLD_MS) {
    return 'error'
  }
  // 刚干完活（哪怕只有十几毫秒）也让它看得见
  if (post.lastActivityAt !== null && post.lastActivityAt !== undefined && now - post.lastActivityAt < RECENT_ACTIVE_MS) {
    return 'working'
  }
  return 'idle'
}



// ── Three.js 场景 ─────────────────────────────────────────────────────

/**
 * 把 GLB 挂进容器并渲染，返回 `{ unmount, applyState }`。
 *
 * 动画的关键约束（M1 资产实测）：`studio.glb` 的 Idle / Working / Error 三段剪辑
 * **同时作用于全部 6 名员工**（轨道名形如 `Employee_3_Head.quaternion`）。
 * 直接把剪辑交给一个 mixer 会让六个人一起切动作，违反产品文档第二原则
 * 「任何动画都应该代表真实系统状态」。所以这里按员工**过滤轨道**，
 * 每人得到自己的三段剪辑，再由真实状态驱动。
 */
// ── 交付纸（A4，可滚动）─────────────────────────────────────────────────
/**
 * 回答结束后，把"交付"做成一张递到眼前的微皱 A4。
 *
 * 用户要求（2026-09-11）：① 纸要能**滚动**看全文；② **不显示滚动条**，用一个小小的
 * 动态巧思提示可以滑；③ 只有点**「已阅」印章**才收起（点纸别处不关）。
 *
 * 实现分三层：
 *   - `staticCanvas`：纸基色、折痕、艺术字抬头、页脚、印章（滚动时不动，像文档页眉页脚）；
 *   - `bodyCanvas`：**全部**正文（不截断），高度按实际行数撑开；
 *   - `composedCanvas`：合成结果 —— 把正文层按 `scrollY` 偏移、**裁剪到正文窗口**画进去。
 *   滚动 = 只改 `scrollY` 重量合成层，再把 `texture.needsUpdate` 置上，代价很低。
 *   滚动提示是**独立的 DOM 小件**（CSS 动画，不占画布重绘）：一枚会上下浮动的雪佛龙 +
 *   一条细进度条，滚到底自动淡出。
 */
const DELIVERY_HOLD_MS = 45_000
const A4_RATIO = 297 / 210
const A4_PAGE_W = 1024
const A4_PAGE_H = Math.round(A4_PAGE_W * A4_RATIO)

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** 逐字换行（中文没有空格，按字宽折行最稳）。返回全部行，不再截断。 */
function wrapCanvasText(ctx, text, maxWidth, maxLines) {
  const lines = []
  for (const paragraph of String(text).split(String.fromCharCode(10))) {
    let line = ''
    for (const ch of paragraph) {
      if (line !== '' && ctx.measureText(line + ch).width > maxWidth) {
        lines.push(line)
        line = ch
        if (lines.length >= maxLines) return lines
      } else {
        line += ch
      }
    }
    lines.push(line)
    if (lines.length >= maxLines) return lines
  }
  return lines
}

/** 排版一张纸：静态层 + 全文正文层 + 正文窗口与印章的矩形。 */
function layoutDelivery(delivery) {
  const width = A4_PAGE_W
  const height = A4_PAGE_H
  const pad = 92

  const stat = document.createElement('canvas')
  stat.width = width
  stat.height = height
  const sctx = stat.getContext('2d')

  const base = sctx.createLinearGradient(0, 0, width, height)
  base.addColorStop(0, '#fdfaf3')
  base.addColorStop(1, '#f3ecdd')
  sctx.fillStyle = base
  sctx.fillRect(0, 0, width, height)

  // 微皱：暗一条、亮一条，透明度很低才像纸而不是脏
  for (const [position, slope] of [[0.17, -0.22], [0.44, 0.16], [0.7, -0.14], [0.88, 0.26]]) {
    const y = height * position
    sctx.beginPath()
    sctx.moveTo(0, y)
    sctx.lineTo(width, y + width * slope * 0.12)
    sctx.lineWidth = 28
    sctx.strokeStyle = 'rgba(120,105,80,.05)'
    sctx.stroke()
    sctx.beginPath()
    sctx.moveTo(0, y + 12)
    sctx.lineTo(width, y + 12 + width * slope * 0.12)
    sctx.lineWidth = 9
    sctx.strokeStyle = 'rgba(255,255,255,.4)'
    sctx.stroke()
  }

  // 抬头艺术字
  sctx.save()
  sctx.translate(pad, pad + 58)
  sctx.rotate(-0.02)
  sctx.font = '600 70px "KaiTi","STKaiti","KaiTi_GB2312","Segoe Script",serif'
  sctx.fillStyle = '#2f3a2c'
  sctx.fillText('老大请过目', 0, 0)
  sctx.beginPath()
  sctx.moveTo(-8, 24)
  sctx.bezierCurveTo(140, 40, 320, 10, 452, 28)
  sctx.lineWidth = 5
  sctx.strokeStyle = 'rgba(180,67,58,.72)'
  sctx.stroke()
  sctx.restore()

  // 页脚（写实情：性质 + 字数 + 怎么收起）
  sctx.font = '26px "Songti SC","SimSun","Microsoft YaHei",serif'
  sctx.fillStyle = '#8a8f83'
  const kind = delivery.reasonKind
  const verdict = kind === null || kind === undefined
    ? delivery.historical === true
      ? '历史记录'
      : '本轮结束'
    : kind === 'completed'
      ? '本轮已完成'
      : '本轮未完成（' + kind + '）'
  sctx.fillText(verdict + ' · 全文 ' + delivery.chars + ' 字', pad, height - pad - 78)
  if (delivery.truncated === true) {
    sctx.fillStyle = '#b08a6a'
    sctx.fillText('（正文过长，纸面只印到上限，全文见对话）', pad, height - pad - 54)
  }
  sctx.fillStyle = '#a8aca0'
  sctx.fillText('点右下角「已阅」收起', pad, height - pad - 30)

  // 红章：既装饰，也是唯一的关闭按钮
  const seal = 132
  const sealRect = { x: width - pad - seal, y: height - pad - seal - 34, w: seal, h: seal }
  sctx.save()
  sctx.globalAlpha = 0.84
  sctx.fillStyle = '#b4433a'
  roundRectPath(sctx, sealRect.x, sealRect.y, seal, seal, 18)
  sctx.fill()
  sctx.fillStyle = '#fdf6ee'
  sctx.font = '700 52px "KaiTi","STKaiti",serif'
  sctx.textAlign = 'center'
  sctx.textBaseline = 'middle'
  sctx.fillText('已阅', sealRect.x + seal / 2, sealRect.y + seal / 2 - 4)
  sctx.restore()

  // 正文窗口
  const bodyTop = pad + 168
  const bodyBottom = height - pad - 120
  const bodyRect = { x: pad, y: bodyTop, w: width - pad * 2, h: Math.max(60, bodyBottom - bodyTop) }

  // 正文层：全部内容，高度按行数撑开
  const bodyFont = '30px "Songti SC","SimSun","Microsoft YaHei",serif'
  const lineHeight = 50
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = bodyFont
  const allLines = wrapCanvasText(probe, delivery.text, bodyRect.w, 4000)
  // canvas 高度有引擎上限（Chrome 约 32767px），超了就整张变空白——
  // 所以先按安全高度截断行数，并在页脚如实写明"只印到此处"。
  const MAX_BODY_H = 15000
  const maxLines = Math.max(1, Math.floor((MAX_BODY_H - 40) / lineHeight))
  const lines = allLines.length > maxLines ? allLines.slice(0, maxLines) : allLines
  const overflow = allLines.length > maxLines
  const body = document.createElement('canvas')
  body.width = bodyRect.w
  body.height = Math.max(bodyRect.h, lines.length * lineHeight + 40)
  const bctx = body.getContext('2d')
  bctx.font = bodyFont
  bctx.fillStyle = '#3b4038'
  lines.forEach((line, index) => bctx.fillText(line, 0, 30 + index * lineHeight))

  const composed = document.createElement('canvas')
  composed.width = width
  composed.height = height

  const maxScroll = Math.max(0, body.height - bodyRect.h)
  return {
    width,
    height,
    staticCanvas: stat,
    bodyCanvas: body,
    composedCanvas: composed,
    ctx: composed.getContext('2d'),
    bodyRect,
    sealRect,
    /** 纸面是否装不下全部正文（快照截断 或 画布高度上限）。 */
    overflow: overflow || delivery.truncated === true,
    scrollY: 0,
    maxScroll,
    scrollable: maxScroll > 1,
  }
}

/** 合成：静态层 + 按 scrollY 裁剪的正文窗口 + 底部渐隐（暗示还有内容）。 */
function composeDelivery(state) {
  const ctx = state.ctx
  const bodyRect = state.bodyRect
  ctx.clearRect(0, 0, state.width, state.height)
  ctx.drawImage(state.staticCanvas, 0, 0)
  ctx.save()
  ctx.beginPath()
  ctx.rect(bodyRect.x, bodyRect.y, bodyRect.w, bodyRect.h)
  ctx.clip()
  ctx.drawImage(state.bodyCanvas, bodyRect.x, bodyRect.y - state.scrollY)
  ctx.restore()
  if (state.scrollable && state.scrollY < state.maxScroll - 2) {
    const gradient = ctx.createLinearGradient(0, bodyRect.y + bodyRect.h - 96, 0, bodyRect.y + bodyRect.h)
    gradient.addColorStop(0, 'rgba(250,246,238,0)')
    gradient.addColorStop(1, 'rgba(250,246,238,.94)')
    ctx.fillStyle = gradient
    ctx.fillRect(bodyRect.x, bodyRect.y + bodyRect.h - 96, bodyRect.w, 96)
  }
}

/** 造一张纸：平面 + 极小法线起伏 + 自发光贴图（深色主题也读得清）。 */
function createDeliverySheet(delivery) {
  const state = layoutDelivery(delivery)
  composeDelivery(state)
  const texture = new THREE.CanvasTexture(state.composedCanvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const geometry = new THREE.PlaneGeometry(1, A4_RATIO, 20, 28)
  const position = geometry.attributes.position
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index)
    const y = position.getY(index)
    const z = Math.sin(x * 9.5) * 0.006 + Math.sin(y * 7.2 + 1.3) * 0.005 + Math.sin((x + y) * 5.1) * 0.004
    position.setZ(index, z)
  }
  geometry.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0.18,
  })
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry, material))
  return { group, geometry, material, texture, state }
}

function mountStudio(host, glbBuffer, onStatus, onSelect, artTextures = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  host.appendChild(renderer.domElement)

  // 头顶气泡用 CSS2D 标签：渲染成真实 DOM 文字，中文清晰、可选中复制
  // （本环境读不到画面，能复制的文字是唯一可靠的核对通道）。
  const labelRenderer = new CSS2DRenderer()
  labelRenderer.domElement.style.position = 'absolute'
  labelRenderer.domElement.style.top = '0'
  labelRenderer.domElement.style.left = '0'
  labelRenderer.domElement.style.pointerEvents = 'none'
  host.appendChild(labelRenderer.domElement)

  const scene = new THREE.Scene()
  scene.background = null
  renderer.setClearColor(0x000000, 0)

  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400)
  // 交付纸挂在相机下（"被递到眼前"），而挂在相机下的对象只有相机本身在场景里才会被渲染
  scene.add(camera)
  camera.position.set(6, 6, 8)
  camera.lookAt(0, 0.8, 0)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.enablePan = false
  controls.enableZoom = false
  let viewLocked = false
  controls.minPolarAngle = Math.PI / 8
  controls.maxPolarAngle = Math.PI / 2.2
  let framed = false

  // 暖色日光 + 漫射环境光，对应「柔和日光、避免刺眼高光」的视觉方向。
  // 资产说明明确写了「光照由预览器提供，导入其他工具需配置相应灯光」。
  const lighting = createStudioLighting(scene)
  const stopTheme = observeStudioTheme(host.parentElement, lighting)

  let disposed = false
  let model = null
  let mixer = null
  /** 房间包围盒与 8 个角：取景按屏幕空间拟合时要用 */
  let modelBox = null
  let modelCorners = null
  /** 工位序号 → { actions: {idle,working,error}, current }。 */
  const actionSets = new Array(STATION_COUNT).fill(null)
  /** 工位序号 → Employee_N 节点，用于点击命中与选中框。 */
  const stationNodes = new Map()
  const clock = new THREE.Clock()
  /**
   * 模型自己的活动阶段（由宿主快照驱动）。资产中央的总控台上有一个 `Coordinator` 机器人，
   * 位置天生就是"模型本人"。这里用**程序化动作**表现它，而不是给它新造一段动作剪辑——
   * 阶段本身来自真实增量流（见 model-activity.mjs），动作只是把它演出来。
   */
  let coordinator = null
  let modelPhase = 'idle'
  let elapsed = 0
  /**
   * 开场面：房间就绪时镜头做一个缓推（0.9 → 1.0 倍），给"开幕"一点仪式感。
   * 只叠在 camera.zoom 上，**不动用户的取景数学**；推完把控制权交回缩放滑杆。
   */
  const INTRO_FROM = 0.9
  const INTRO_MS = 1400
  let intro = 0
  let introRunning = false
  let userZoom = 1
  /** 交付纸（回答结束后递到眼前的那张 A4）。 */
  let deliverySheet = null
  let deliveryAnim = null
  let deliverySeenAt = null
  let deliveryBaseScale = 1
  /** 滚动提示小件（会上下浮动的雪佛龙 + 细进度条）。CSS 动画，不占画布重绘。 */
  let scrollHint = null
  /** 工位下标 → 头顶气泡；以及总控台（模型）自己的气泡。 */
  const bubbles = new Array(STATION_COUNT).fill(null)
  let coordinatorBubble = null
  /**
   * 气泡避让交付纸。
   *
   * 为什么必须做：气泡是 **CSS2D（DOM）**，纸画在 **WebGL 画布**里；DOM 层整体盖在画布之上，
   * 所以气泡必定压在纸上（用户实测截图确认）。层次改不了（除非把纸也做成 DOM，
   * 那会丢掉光照下的"微皱"），所以每帧把纸投影成屏幕矩形，**只隐藏与它重叠的气泡**。
   */
  const PAPER_CORNERS = [
    new THREE.Vector3(-0.5, -A4_RATIO / 2, 0),
    new THREE.Vector3(0.5, -A4_RATIO / 2, 0),
    new THREE.Vector3(0.5, A4_RATIO / 2, 0),
    new THREE.Vector3(-0.5, A4_RATIO / 2, 0),
  ]
  const OCCLUSION_VEC = new THREE.Vector3()
  /** 最近一次算出的气泡文字，供诊断显示（本环境看不到画面，只能靠文字核对） */
  const bubbleTexts = new Array(STATION_COUNT).fill('')

  // ── 选中（VIS-05 / MVP-04）────────────────────────────────────────────
  // 用射线拾取：点员工/桌子/椅子都算选中该工位。高亮用 BoxHelper 线框——
  // 它不需要改材质（改材质会影响我们按状态控制的动画与释放逻辑），也不改变画面色调。
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let selectedStation = null
  let selectionBox = null

  function setSelection(index) {
    if (selectionBox !== null) {
      scene.remove(selectionBox)
      selectionBox.geometry.dispose()
      selectionBox.material.dispose()
      selectionBox = null
    }
    selectedStation = index
    const node = index === null ? null : stationNodes.get(index)
    if (node !== null && node !== undefined) {
      selectionBox = new THREE.BoxHelper(node, 0x7d8f6a)
      scene.add(selectionBox)
    }
    if (typeof onSelect === 'function') onSelect(index)
  }

  /** 从命中的网格往上找，判断它属于哪个工位。 */
  function stationIndexOf(object) {
    let node = object
    while (node !== null && node !== undefined) {
      const name = typeof node.name === 'string' ? node.name : ''
      const match = /^(?:Employee|Desk|Chair|Station)_(\d+)$/.exec(name)
      if (match !== null) {
        const index = Number(match[1])
        if (index >= 0 && index < STATION_COUNT) return index
      }
      node = node.parent
    }
    return null
  }

  let press = null
  const rememberPress = (event) => { press = [event.clientX, event.clientY] }
  function onPointerDown(event) {
    if (!press || Math.hypot(event.clientX - press[0], event.clientY - press[1]) > 5) return
    press = null
    if (disposed || model === null) return
    const rect = renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    // 纸在最前面：只有点到「已阅」印章才收起；点纸别处不关，也不穿透到工位
    if (deliverySheet !== null && deliveryAnim !== null && deliveryAnim.phase !== 'out') {
      const sheetHits = raycaster.intersectObject(deliverySheet.group, true)
      if (sheetHits.length > 0) {
        const uv = sheetHits[0].uv
        const state = deliverySheet.state
        if (uv !== undefined && uv !== null) {
          const px = uv.x * state.width
          const py = (1 - uv.y) * state.height
          const seal = state.sealRect
          const inSeal = px >= seal.x && px <= seal.x + seal.w && py >= seal.y && py <= seal.y + seal.h
          if (inSeal) hideDeliverySheet()
        }
        return
      }
    }
    const hits = raycaster.intersectObject(model, true)
    for (const hit of hits) {
      const index = stationIndexOf(hit.object)
      if (index !== null) {
        // 再点一次同一个工位 = 取消选中，避免"点不掉"
        setSelection(index === selectedStation ? null : index)
        return
      }
    }
    setSelection(null)
  }
  renderer.domElement.addEventListener('pointerdown', rememberPress)
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
  renderer.domElement.addEventListener('pointerup', onPointerDown)

  function frameModel() {
    if (model === null || modelBox === null) return
    const oldPosition = camera.position.clone()
    frameStudioCamera(camera, modelBox, host.clientWidth, host.clientHeight)
    controls.target.copy(modelBox.getCenter(new THREE.Vector3()))
    if (framed) camera.position.copy(oldPosition)
    framed = true
    controls.update()
  }

  /**
   * 按**容器**尺寸重排。
   *
   * 为什么不能只听 `window.resize`（用户实测 bug）：agent 弹出选择题卡片时，输入区被顶高、
   * 3D 容器被压扁，但**窗口尺寸没变**，所以 resize 根本不会触发；画布的 CSS 尺寸跟着容器缩了，
   * 绘图缓冲却还是旧尺寸，浏览器把旧画面拉伸 → "比例和分辨率都乱了"；卡片消失后也回不来。
   * 现在由 ResizeObserver 盯容器，任何布局变化都会重排。
   */
  const resize = () => {
    if (disposed) return
    diag.resizeCount += 1
    const w = host.clientWidth || 2
    const h = host.clientHeight || 2
    renderer.setSize(w, h, false)
    labelRenderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    frameModel()
    // 交付纸的尺寸是按视口算的，容器一变就要跟着重算，否则会溢出画面
    if (deliverySheet !== null) {
      const halfHeight = Math.abs(camera.top - camera.bottom) / 2 || 3
      const halfWidth = Math.abs(camera.right - camera.left) / 2 || 4
      deliveryBaseScale = (halfHeight * 1.12) / A4_RATIO
      deliverySheet.group.scale.setScalar(deliveryBaseScale)
      deliverySheet.group.position.set(halfWidth * 0.44, 0, -1.2)
    }
    renderer.render(scene, camera)
  }

  /**
   * 渲染诊断。**全部做成可复制文字**——本环境无法截图，用户能贴回来的只有文字。
   * 它回答三个问题：循环在不在跑、页面被判成隐藏没有、动作到底建出来没有。
   */
  const diag = {
    /** 重排次数：agent 弹卡片/收起时这个数应该增加（证明容器变化被接住） */
    resizeCount: 0,
    frames: 0,
    hiddenFrames: 0,
    lastDeltaMs: 0,
    lastHidden: null,
    clips: [],
    matchedStations: 0,
    fallback: false,
    stationStates: new Array(STATION_COUNT).fill('—'),
    note: null,
  }
  /** 被判为隐藏时的降频间隔。 */
  const HIDDEN_FRAME_INTERVAL_MS = 1000
  let lastHiddenRenderAt = 0

  /**
   * 连续渲染（Idle 本身在动）。页面隐藏时**降频**而不是完全停。
   *
   * 为什么不能直接 return（2026-09-11 实测症状修正）：内置浏览器面板可能把页面判定为
   * 隐藏，原实现一 return 就只剩解析时画的那一帧，用户看到的是**整个工作室一点动静
   * 都没有**。降频既保留"隐藏时不持续提交 WebGL 帧"的意图（对应 REL-03），又不会让
   * 画面彻底冻住；是否被误判可以从面板文字直接看出来。
   */
  const tick = () => {
    if (disposed) return
    requestAnimationFrame(tick)
    const delta = clock.getDelta()
    diag.lastDeltaMs = Math.round(delta * 1000)
    const hidden = document.hidden === true
    diag.lastHidden = hidden
    if (hidden) {
      diag.hiddenFrames += 1
      const now = Date.now()
      if (now - lastHiddenRenderAt < HIDDEN_FRAME_INTERVAL_MS) return
      lastHiddenRenderAt = now
    }
    diag.frames += 1
    if (introRunning) {
      intro = Math.min(1, intro + (delta * 1000) / INTRO_MS)
      if (intro >= 1) introRunning = false
      applyZoom()
    }
    animateDeliverySheet()
    updateScrollHint()
    updateBubbleOcclusion()
    controls.update()
    elapsed += delta
    if (mixer !== null) mixer.update(delta)
    animateCoordinator(delta)
    // 选中框跟着动画走（员工在动，线框要跟着更新）
    if (selectionBox !== null) selectionBox.update()
    renderer.render(scene, camera)
    // 气泡跟随相机朝向（CSS2D 自己处理投影，这里只负责每帧同步）
    labelRenderer.render(scene, camera)
  }

  /** 总控台机器人：按模型真实阶段做程序化动作，阶段回 idle 时平滑归位。 */
  function animateCoordinator(delta) {
    if (coordinator === null) return
    const ease = Math.min(1, delta * 6)
    let targetY = 0
    let targetX = 0
    if (modelPhase === 'thinking') {
      targetY = Math.sin(elapsed * 1.1) * 0.20 // 缓慢左右思考
      targetX = -0.07 + Math.sin(elapsed * 0.8) * 0.03
    } else if (modelPhase === 'writing') {
      targetY = Math.sin(elapsed * 5.5) * 0.06 // 快速小幅，像在敲字
      targetX = 0.13
    } else if (modelPhase === 'calling') {
      targetY = Math.sin(elapsed * 2.2) * 0.42 // 转向工位"派活"
      targetX = 0.02
    } else if (modelPhase === 'retrying') {
      targetY = Math.sin(elapsed * 8) * 0.10
      targetX = -0.10
    }
    coordinator.rotation.y += (targetY - coordinator.rotation.y) * ease
    coordinator.rotation.x += (targetX - coordinator.rotation.x) * ease
  }

  /** 按员工序号建立独立剪辑：只保留属于自己的轨道。 */
  function buildActions(animations) {
    const clips = new Map()
    diag.clips = []
    for (const clip of animations ?? []) {
      clips.set(clip.name, clip)
      diag.clips.push({
        name: clip.name,
        tracks: clip.tracks.length,
        sample: clip.tracks.length > 0 ? clip.tracks[0].name : null,
      })
    }
    let matched = 0
    for (let index = 0; index < STATION_COUNT; index++) {
      const actions = {}
      const prefix = 'Employee_' + index + '_'
      for (const stateName of ['idle', 'working', 'error']) {
        const source = clips.get(stateName === 'idle' ? 'Idle' : stateName === 'working' ? 'Working' : 'Error')
        if (source === undefined) continue
        const tracks = source.tracks.filter((track) => track.name.startsWith(prefix))
        if (tracks.length === 0) continue
        const clip = new THREE.AnimationClip(source.name + '_' + index, source.duration, tracks)
        const action = mixer.clipAction(clip)
        action.enabled = true
        action.setLoop(THREE.LoopRepeat, Infinity)
        actions[stateName] = action
      }
      if (Object.keys(actions).length > 0) {
        actionSets[index] = { actions, current: null }
        // 默认全部待机，等真实状态来驱动
        setStationState(index, 'idle')
        matched += 1
      }
    }
    diag.matchedStations = matched
    // 兜底：一条轨道都没匹配上（说明轨道命名与 `Employee_<i>_` 不符）。
    // 整体播放 Idle，至少让房间活着；面板会写明这是兜底并给出真实轨道名，
    // 便于据此修正过滤规则，而不是让用户对着一个死画面猜。
    if (matched === 0) {
      const idle = clips.get('Idle')
      if (idle !== undefined) {
        const whole = mixer.clipAction(idle)
        whole.setLoop(THREE.LoopRepeat, Infinity)
        whole.play()
        diag.fallback = true
        diag.note = '按员工过滤没匹配到轨道，已回退为整体播放 Idle'
      } else {
        diag.note = '资产里没有 Idle 剪辑'
      }
    }
    return matched
  }

  function setStationState(index, next) {
    const set = actionSets[index]
    if (set === null || set === undefined) return
    const action = set.actions[next]
    if (action === undefined || set.current === next) return
    const previous = set.current === null ? null : set.actions[set.current]
    action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play()
    if (previous !== null && previous !== undefined) action.crossFadeFrom(previous, FADE_SECONDS, false)
    set.current = next
    diag.stationStates[index] = next
  }

  const loader = new GLTFLoader()
  loader.parse(
    glbBuffer,
    '',
    (gltf) => {
      if (disposed) return
      model = gltf.scene
      installStudioArt(model, artTextures)
      scene.add(model)
      lighting.setDark(document.body.hasAttribute('data-ds-dark-theme'))
      mixer = new THREE.AnimationMixer(model)

      // 取景：按**屏幕空间**拟合，而不是按包围球估算。
      // 原实现用 max(尺寸)/2 当球半径 + sin(fov/2) 估距离，对 12.6×10.1 的扁房间是错的：
      // 房间被裁到画面外、内容也不居中（用户实测截图确认）。
      // 现在把 8 个包围盒角投影到 NDC，迭代求"缩放倍数"与"居中偏移"，
      // 再据此回推相机距离与目标点 —— 与宽高比变化无关。
      modelBox = new THREE.Box3().setFromObject(model)
      modelCorners = []
      for (const x of [modelBox.min.x, modelBox.max.x]) {
        for (const y of [modelBox.min.y, modelBox.max.y]) {
          for (const z of [modelBox.min.z, modelBox.max.z]) {
            modelCorners.push(new THREE.Vector3(x, y, z))
          }
        }
      }
      frameModel()

      const center = modelBox.getCenter(new THREE.Vector3())
      const size = modelBox.getSize(new THREE.Vector3())
      lighting.setTarget(center)

      // 建立工位 → 员工节点的映射，供点击拾取与选中框使用
      for (let index = 0; index < STATION_COUNT; index++) {
        const node = model.getObjectByName('Employee_' + index)
        if (node !== null && node !== undefined) stationNodes.set(index, node)
      }
      // 中央总控台上的机器人 = 模型本人
      coordinator = model.getObjectByName('Coordinator') ?? null

      // 气泡挂在角色节点上方；员工约 1.7m 高，所以抬到 2.05m
      for (let index = 0; index < STATION_COUNT; index++) {
        const node = stationNodes.get(index)
        if (node === null || node === undefined) continue
        const bubble = createBubbleElement()
        const object = new CSS2DObject(bubble.root)
        // 底部锚定（center=(0.5,1)）：气泡整体向上生长，**永远压不到员工的头/脸**。
        // 锚点定在 1.92m（员工约 1.7m 高），所以气泡底边就在头顶上方。
        object.center.set(0.5, 1)
        object.position.set(0, 1.92, 0)
        node.add(object)
        bubble.object = object
        bubbles[index] = bubble
      }
      if (coordinator !== null) {
        const bubble = createBubbleElement()
        const object = new CSS2DObject(bubble.root)
        object.center.set(0.5, 1)
        object.position.set(0, 0.78, 0)
        coordinator.add(object)
        bubble.object = object
        coordinatorBubble = bubble
      }

      const stations = buildActions(gltf.animations)
      resize()
      clock.getDelta() // 丢弃解析耗时，避免首帧跳变

      onStatus(
        `场景已渲染 · 尺寸 ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)} m · ` +
          `${countMeshes(model)} 网格 · ${stations} 个员工动作就绪`,
      )
      // 开幕：镜头从略远处缓推到位（尊重 prefers-reduced-motion 时直接到位）
      let reduceMotion = false
      try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { reduceMotion = false }
      if (reduceMotion) { intro = 1; introRunning = false; applyZoom() } else { intro = 0; introRunning = true; applyZoom() }
    },
    (error) => {
      if (disposed) return
      onStatus('GLB 解析失败：' + (error && error.message ? error.message : String(error)))
    },
  )

  /** 清掉旧纸（几何/材质/贴图都要释放，否则翻几轮就积一堆）。 */
  function disposeDeliverySheet() {
    if (deliverySheet === null) return
    if (deliverySheet.group.parent !== null) deliverySheet.group.parent.remove(deliverySheet.group)
    deliverySheet.geometry.dispose()
    deliverySheet.material.dispose()
    deliverySheet.texture.dispose()
    deliverySheet = null
    deliveryAnim = null
    if (scrollHint !== null) scrollHint.style.opacity = '0'
  }

  /** 懒创建滚动提示：一枚浮动雪佛龙 + 一条细进度条 + 一行小字。 */
  function ensureScrollHint() {
    if (scrollHint !== null) return scrollHint
    const wrap = document.createElement('div')
    wrap.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity .3s ease',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'gap:3px',
      'will-change:transform',
    ].join(';')
    const chev = document.createElement('div')
    chev.textContent = '⌄'
    chev.style.cssText = 'font:16px/1 "Segoe UI",sans-serif;color:var(--studio-muted,#8a9182);will-change:transform'
    const rail = document.createElement('div')
    rail.style.cssText = 'width:58px;height:2px;border-radius:2px;background:var(--studio-border,#d9d5c6);overflow:hidden'
    const fill = document.createElement('i')
    fill.style.cssText = 'display:block;height:100%;width:0%;background:var(--studio-accent,#a8b79c);transition:width .18s ease'
    rail.appendChild(fill)
    const txt = document.createElement('div')
    txt.textContent = '滑动查看全文'
    txt.style.cssText = 'font:11px/1.3 "Segoe UI","Microsoft YaHei",sans-serif;color:var(--studio-muted,#8a9182)'
    wrap.appendChild(chev)
    wrap.appendChild(rail)
    wrap.appendChild(txt)
    const host = renderer.domElement.parentElement ?? document.body
    host.appendChild(wrap)
    wrap.__chev = chev
    wrap.__fill = fill
    scrollHint = wrap
    return wrap
  }

  /** 提示小件每帧跟随纸张底边定位，并按滚动进度更新；滚到底自动淡出。 */
  function updateScrollHint() {
    if (scrollHint === null) return
    if (deliverySheet === null || deliveryAnim === null) {
      scrollHint.style.opacity = '0'
      return
    }
    const state = deliverySheet.state
    const remaining = state.maxScroll - state.scrollY
    const shouldShow = state.scrollable && remaining > 4 && deliveryAnim.phase !== 'out'
    scrollHint.style.opacity = shouldShow ? '1' : '0'
    if (!shouldShow) return
    const local = new THREE.Vector3(0, -A4_RATIO / 2, 0)
    const projected = local.applyMatrix4(deliverySheet.group.matrixWorld).project(camera)
    const canvasRect = renderer.domElement.getBoundingClientRect()
    const cardRect = (renderer.domElement.parentElement ?? document.body).getBoundingClientRect()
    const px = canvasRect.left + (projected.x * 0.5 + 0.5) * canvasRect.width - cardRect.left
    const py = canvasRect.top + (-projected.y * 0.5 + 0.5) * canvasRect.height - cardRect.top
    const bob = Math.sin(elapsed * 3.1) * 5
    scrollHint.style.transform = 'translate(-50%,-100%) translate(' + px.toFixed(1) + 'px,' + (py - 8 + bob).toFixed(1) + 'px)'
    scrollHint.__chev.style.transform = 'translateY(' + (Math.sin(elapsed * 3.1) * 2).toFixed(1) + 'px)'
    scrollHint.__fill.style.width = ((state.scrollY / state.maxScroll) * 100).toFixed(1) + '%'
  }

  /** 每帧：把纸投影成屏幕矩形，与它重叠的气泡临时隐藏（其余照常）。 */
  function updateBubbleOcclusion() {
    const rect = renderer.domElement.getBoundingClientRect()
    let paper = null
    if (deliverySheet !== null && deliveryAnim !== null && rect.width > 0 && rect.height > 0) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const corner of PAPER_CORNERS) {
        OCCLUSION_VEC.copy(corner).applyMatrix4(deliverySheet.group.matrixWorld).project(camera)
        const x = (OCCLUSION_VEC.x * 0.5 + 0.5) * rect.width
        const y = (-OCCLUSION_VEC.y * 0.5 + 0.5) * rect.height
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
      paper = { minX: minX - 8, maxX: maxX + 8, minY: minY - 8, maxY: maxY + 8 }
    }
    for (const bubble of bubbles) applyBubbleOcclusion(bubble, paper, rect)
    applyBubbleOcclusion(coordinatorBubble, paper, rect)
  }

  function applyBubbleOcclusion(bubble, paper, rect) {
    if (bubble === null || bubble === undefined || bubble.object === undefined) return
    let hidden = false
    if (paper !== null && typeof bubble.lastWidth === 'number' && bubble.lastWidth > 0) {
      OCCLUSION_VEC.setFromMatrixPosition(bubble.object.matrixWorld).project(camera)
      const x = (OCCLUSION_VEC.x * 0.5 + 0.5) * rect.width
      const y = (-OCCLUSION_VEC.y * 0.5 + 0.5) * rect.height
      // 气泡底部锚定：以锚点为底边中点向上展开
      const left = x - bubble.lastWidth / 2
      const right = x + bubble.lastWidth / 2
      const top = y - bubble.lastHeight
      const bottom = y
      hidden = !(right < paper.minX || left > paper.maxX || bottom < paper.minY || top > paper.maxY)
    }
    const next = hidden ? 'hidden' : ''
    if (bubble.hiddenState !== next) {
      bubble.hiddenState = next
      bubble.root.style.visibility = next
    }
  }

  /** 滚轮：只有指针在纸上时才接管，滚的是正文窗口。 */
  function onWheel(event) {
    if (disposed || deliverySheet === null || deliveryAnim === null || deliveryAnim.phase === 'out') return
    const state = deliverySheet.state
    if (!state.scrollable) return
    const rect = renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    if (raycaster.intersectObject(deliverySheet.group, true).length === 0) return
    event.preventDefault()
    const next = Math.min(state.maxScroll, Math.max(0, state.scrollY + event.deltaY * 1.15))
    if (next === state.scrollY) return
    state.scrollY = next
    composeDelivery(state)
    deliverySheet.texture.needsUpdate = true
  }

  /** 把一张纸递到眼前：尺寸按当前正交视口算，位置略偏右，不挡房间正中。 */
  function showDeliverySheet(delivery, options = {}) {
    disposeDeliverySheet()
    const sheet = createDeliverySheet(delivery)
    const halfHeight = Math.abs(camera.top - camera.bottom) / 2 || 3
    const halfWidth = Math.abs(camera.right - camera.left) / 2 || 4
    deliveryBaseScale = (halfHeight * 1.12) / A4_RATIO
    sheet.group.scale.setScalar(deliveryBaseScale * 0.9)
    sheet.group.position.set(halfWidth * 0.44, 0, -1.2)
    sheet.group.rotation.set(0.05, -0.06, -0.03)
    sheet.material.opacity = 0
    camera.add(sheet.group)
    deliverySheet = sheet
    // persist：历史汇报不自动消失（只有点「已阅」才收），新交付仍是 45 秒后淡出
    deliveryAnim = { phase: 'in', start: Date.now(), persist: options.persist === true }
    ensureScrollHint()
  }

  /** 收起（点击或超时）。 */
  function hideDeliverySheet() {
    if (deliverySheet === null || deliveryAnim === null || deliveryAnim.phase === 'out') return
    deliveryAnim = { phase: 'out', start: Date.now() }
  }

  /** 每帧：淡入 → 停住（极轻浮动）→ 超时淡出并释放。 */
  function animateDeliverySheet() {
    if (deliverySheet === null || deliveryAnim === null) return
    const elapsedMs = Date.now() - deliveryAnim.start
    if (deliveryAnim.phase === 'in') {
      const t = Math.min(1, elapsedMs / 420)
      const ease = 1 - Math.pow(1 - t, 3)
      deliverySheet.group.scale.setScalar(deliveryBaseScale * (0.9 + 0.1 * ease))
      deliverySheet.material.opacity = ease
      if (t >= 1) deliveryAnim = { phase: 'hold', start: Date.now() }
      return
    }
    if (deliveryAnim.phase === 'hold') {
      deliverySheet.group.position.y = Math.sin(elapsed * 1.5) * 0.012
      if (deliveryAnim.persist !== true && elapsedMs > DELIVERY_HOLD_MS) {
        deliveryAnim = { phase: 'out', start: Date.now() }
      }
      return
    }
    const t = Math.min(1, elapsedMs / 520)
    deliverySheet.material.opacity = Math.max(0, 1 - t)
    deliverySheet.group.scale.setScalar(deliveryBaseScale * (1 - 0.05 * t))
    if (t >= 1) disposeDeliverySheet()
  }

  /** 把"用户缩放 × 开场缓推系数"合成到 camera.zoom。 */
  function applyZoom() {
    const ease = introRunning ? 1 - Math.pow(1 - intro, 3) : 1
    camera.zoom = userZoom * (INTRO_FROM + (1 - INTRO_FROM) * ease)
    camera.updateProjectionMatrix()
  }

  window.addEventListener('resize', resize)
  // 容器自身尺寸变化（输入区被顶高/收起、侧栏折叠等）也必须重排
  let resizeFrame = 0
  const scheduleResize = () => {
    if (disposed || resizeFrame !== 0) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      resize()
    })
  }
  const containerObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleResize) : null
  if (containerObserver !== null) containerObserver.observe(host)
  tick()

  return {
    setZoom(value) {
      if (viewLocked) return
      userZoom = Math.min(1.8, Math.max(0.65, Number(value) || 1))
      applyZoom()
    },
    setViewLocked(locked) {
      viewLocked = Boolean(locked)
      if (viewLocked) {
        const position = camera.position.clone()
        controls.enableDamping = false
        controls.update()
        camera.position.copy(position)
        camera.lookAt(controls.target)
      }
      controls.enabled = !viewLocked
      controls.enableDamping = !viewLocked
    },
    /** 把一份宿主快照套到工位上。找不到工位的员工由文字面板兜底显示。 */
    applyState(snapshot, sessionId) {
      if (disposed) return
      // 模型阶段先取：即使 3D 还没就绪，总控台也该知道现在在不在思考
      modelPhase = snapshot.model !== null && snapshot.model !== undefined ? snapshot.model.phase : 'idle'
      // 新的交付 → 递纸（用 at 去重，同一份不会反复重放）
      const delivery = snapshot.model !== null && snapshot.model !== undefined ? snapshot.model.delivery : null
      if (
        delivery !== null &&
        delivery !== undefined &&
        typeof delivery.at === 'number' &&
        typeof delivery.text === 'string' &&
        delivery.text.length > 0
      ) {
        if (deliverySeenAt !== delivery.at) {
          deliverySeenAt = delivery.at
          showDeliverySheet(delivery)
        }
      }
      if (mixer === null) return
      const picked = pickSession(snapshot, sessionId)
      const posts = picked.data.posts ?? []
      const now = typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : Date.now()
      // 工位 i = 岗位 i（职责固定），所以直接按岗位活动驱动
      for (let index = 0; index < STATION_COUNT; index++) {
        const post = posts[index]
        setStationState(index, postAnimationState(post, now))
        const bubble = bubbleForPost(post, now)
        setBubble(bubbles[index], bubble.text, bubble.opacity, bubble.detail)
        bubbleTexts[index] = bubble.detail === '' ? bubble.text : bubble.text + ' ／ ' + bubble.detail
      }
      // 总控台气泡显示模型**真正在想的内容**（思维流尾巴），不是套话
      setBubble(coordinatorBubble, bubbleTextForModel(snapshot.model))
    },
    /** 打开一份历史汇报：按 A4 递到眼前，只有点「已阅」才收起。 */
    openDelivery(delivery) {
      if (delivery === null || delivery === undefined || typeof delivery.text !== 'string') return
      showDeliverySheet(delivery, { persist: true })
    },
    /** 渲染侧诊断快照，供文字面板显示（本环境无法截图）。 */
    getDiagnostics() {
      diag.bubbleTexts = [...bubbleTexts]
      diag.canvas = {
        cssW: host.clientWidth,
        cssH: host.clientHeight,
        bufferW: renderer.domElement.width,
        bufferH: renderer.domElement.height,
        dpr: renderer.getPixelRatio(),
        resizes: diag.resizeCount,
      }
      return { ...diag, stationStates: [...diag.stationStates], clips: diag.clips.map((clip) => ({ ...clip })) }
    },
    unmount() {
      for (const texture of Object.values(artTextures)) texture.dispose()
      controls.dispose()
      stopTheme()
      disposed = true
      window.removeEventListener('resize', resize)
      if (containerObserver !== null) containerObserver.disconnect()
      if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame)
      renderer.domElement.removeEventListener('pointerdown', rememberPress)
      renderer.domElement.removeEventListener('wheel', onWheel)
      disposeDeliverySheet()
      if (scrollHint !== null) {
        scrollHint.remove()
        scrollHint = null
      }
      renderer.domElement.removeEventListener('pointerup', onPointerDown)
      for (const bubble of bubbles) if (bubble !== null) bubble.root.remove()
      if (coordinatorBubble !== null) coordinatorBubble.root.remove()
      labelRenderer.domElement.remove()
      if (selectionBox !== null) {
        scene.remove(selectionBox)
        selectionBox.geometry.dispose()
        selectionBox.material.dispose()
        selectionBox = null
      }
      stationNodes.clear()
      if (mixer !== null) {
        mixer.stopAllAction()
        mixer.uncacheRoot(mixer.getRoot())
        mixer = null
      }
      scene.traverse((node) => {
        if (node.geometry && typeof node.geometry.dispose === 'function') node.geometry.dispose()
        const material = node.material
        if (material === undefined) return
        for (const item of Array.isArray(material) ? material : [material]) {
          for (const key of Object.keys(item)) {
            const value = item[key]
            if (value !== null && typeof value === 'object' && value.isTexture) value.dispose()
          }
          if (typeof item.dispose === 'function') item.dispose()
        }
      })
      if (model !== null) scene.remove(model)
      model = null
      renderer.dispose()
      if (renderer.domElement.parentNode !== null) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
    },
  }
}

function countMeshes(root) {
  let count = 0
  root.traverse((node) => {
    if (node.isMesh) count += 1
  })
  return count
}

// ── 视图组件 ──────────────────────────────────────────────────────────

/**
 * 布局：外面留一圈间距、里面是一张圆角卡片。
 *
 * 原因（用户实测反馈）：原先把 3D 铺满整个会话区，底部与输入框直接相撞，"很突兀"。
 * 现在整块缩进 10~14px、圆角 14px、加一层很轻的阴影，视觉上成为一张卡片，
 * 与下面的输入框之间有呼吸空间。卡片背景与场景底色一致，所以看不出边界。
 */
/**
 * 开幕幕布。
 *
 * 用户要求：点开工作室要有**仪式感**，而不是显示"正在读取 13.20 MB / 已取回 / 场景已渲染"
 * 这类技术字眼。所以加载期用同色幕布遮住，只留一个安静的名字与两段氛围文字，
 * 进度条按**真实阶段**推进（不是假计时器）：读完字节 → 0.62，场景就绪 → 1。
 * 载入耗时不算丢掉，挪进可收起的状态面板里（那是不看画面时唯一的核对通道）。
 */
const CURTAIN_STYLE = {
  position: 'absolute',
  top: '0',
  left: '0',
  right: '0',
  bottom: '0',
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '16px',
  background: 'var(--studio-backdrop, #f0ede6)',
  pointerEvents: 'none',
  transition: 'opacity .75s ease',
}

const CURTAIN_WORD_STYLE = {
  fontSize: '19px',
  letterSpacing: '.34em',
  textIndent: '.34em',
  color: 'var(--studio-text, #5f6a55)',
  fontFamily: '"Segoe UI","Microsoft YaHei",sans-serif',
}

const CURTAIN_NOTE_STYLE = {
  fontSize: '12px',
  letterSpacing: '.18em',
  color: 'var(--studio-muted, #9aa192)',
  minHeight: '18px',
  transition: 'opacity .5s ease',
}

const CURTAIN_BAR_STYLE = {
  width: '168px',
  height: '2px',
  borderRadius: '2px',
  background: 'var(--studio-border, #e3dfd2)',
  overflow: 'hidden',
}

const CURTAIN_FILL_STYLE = {
  height: '100%',
  background: 'var(--studio-accent, #a8b79c)',
  transition: 'width .9s cubic-bezier(.22,.61,.36,1)',
}

const HOST_STYLE = {
  position: 'relative',
  width: '100%',
  height: '100%',
  padding: '0',
  boxSizing: 'border-box',
  background: 'transparent',
}

const CARD_STYLE = {
  position: 'relative',
  width: '100%',
  height: '100%',
  borderRadius: '0',
  overflow: 'hidden',
  background: 'transparent',
  border: 'none',
  boxShadow: 'none',
}

const CANVAS_STYLE = { position: 'absolute', top: '0', left: '0', right: '0', bottom: '0' }

const PANEL_BASE = {
  position: 'absolute',
  left: '12px',
  top: '10px',
  maxWidth: 'min(520px, 62%)',
  padding: '8px 11px',
  borderRadius: '9px',
  background: 'var(--studio-surface)',
  border: '1px solid var(--studio-border)',
  color: 'var(--studio-text)',
  font: '12px/1.6 "Segoe UI","Microsoft YaHei",sans-serif',
  // 必须可选中：本环境无法截图，验证要靠用户复制页面文字（见 MEMORY.md）
  userSelect: 'text',
  pointerEvents: 'auto',
}

const STATUS_STYLE = { ...PANEL_BASE, pointerEvents: 'none' }

/** 思维流区块：与工位列表之间加一条分隔线，便于区分"模型"和"员工"。 */
const STREAM_STYLE = {
  marginTop: '6px',
  paddingTop: '6px',
  borderTop: '1px dashed var(--studio-border, #d8d8cc)',
  color: 'var(--studio-muted)',
}

/**
 * 员工日志：**头部固定、主体滚动**。
 *
 * 用户反馈的痛点（原话）：「那个收起按钮，往下滑后还要往上滑才能点，太难用」——
 * 原因是整个面板（包括标题和按钮）都在同一个滚动容器里。现在拆成 flex 列：
 * 头 `flexShrink:0` 不参与滚动，主体 `overflowY:auto` 单独滚，收起按钮永远在手边。
 */
const LOG_STYLE = {
  ...PANEL_BASE,
  top: 'auto',
  bottom: '12px',
  left: '12px',
  width: 'min(430px, 48%)',
  maxHeight: '46%',
  padding: '0',
  display: 'flex',
  flexDirection: 'column',
  whiteSpace: 'normal',
}

const LOG_HEAD_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '7px 10px',
  borderBottom: '1px solid var(--studio-border, #deded3)',
  flexShrink: 0,
}

const LOG_TITLE_STYLE = { fontWeight: 600, color: 'var(--studio-text, #3f4938)' }

const LOG_BODY_STYLE = {
  overflowY: 'auto',
  minHeight: 0,
  padding: '8px 11px 10px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

/**
 * 右上角汇报记录：**默认收起**，点开才展开，点别处收回。
 *
 * 用户要求（2026-09-11）：① 一直摆一叠纸太占空间 → 收起；② 展开后**必须全部列出来**，
 * 不能再写"还有 N 份更早"；③ 放不下就让面板自己滚，并提示"可以滚动"（不显滚动条）。
 */
const REPORTS_STYLE = {
  position: 'absolute',
  top: '10px',
  right: '12px',
  width: 'min(300px, 38%)',
  zIndex: 6,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  pointerEvents: 'auto',
}

const REPORTS_TRIGGER_STYLE = {
  padding: '4px 11px',
  borderRadius: '9px',
  background: 'var(--studio-surface, rgba(250,248,242,.92))',
  border: '1px solid var(--studio-border, #deded3)',
  color: 'var(--studio-text, #4f5947)',
  font: '11px/1.6 "Segoe UI","Microsoft YaHei",sans-serif',
  cursor: 'pointer',
  boxShadow: '0 2px 6px rgba(90,80,60,.12)',
}

const REPORTS_PANEL_STYLE = {
  position: 'relative',
  width: '100%',
  marginTop: '6px',
  maxHeight: '58vh',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: '10px',
  background: 'var(--studio-surface, rgba(250,248,242,.94))',
  border: '1px solid var(--studio-border, #deded3)',
  boxShadow: '0 6px 18px rgba(90,80,60,.18)',
  overflow: 'hidden',
}

const REPORTS_LIST_STYLE = {
  overflowY: 'auto',
  minHeight: 0,
  padding: '7px',
  // 底部留白：给"可滚动"提示让位，免得压住最后一条
  paddingBottom: '20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

/** 展开后每一条：一张小纸，信息完整，点开看全文。 */
const REPORT_SHEET_STYLE = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  overflow: 'hidden',
  padding: '5px 9px',
  borderRadius: '5px',
  background: 'var(--studio-bg-sheet, rgba(253,250,243,.97))',
  border: '1px solid var(--studio-border, #deded3)',
  boxShadow: '0 1px 4px rgba(90,80,60,.14)',
  color: 'var(--studio-text, #4f5947)',
  font: '11px/1.5 "Segoe UI","Microsoft YaHei",sans-serif',
  cursor: 'pointer',
}

/** 滚动提示：贴在面板底部，浮动一下；不显示滚动条。 */
const REPORTS_SCROLL_HINT_STYLE = {
  position: 'absolute',
  left: '50%',
  bottom: '2px',
  transform: 'translateX(-50%)',
  padding: '0 8px',
  borderRadius: '8px',
  background: 'var(--studio-surface, rgba(250,248,242,.9))',
  color: 'var(--studio-muted, #8a9182)',
  font: '12px/1.4 "Segoe UI",sans-serif',
  pointerEvents: 'none',
}

const REPORT_META_STYLE = { color: 'var(--studio-muted, #8a9182)', fontSize: '10px' }
const REPORT_PREVIEW_STYLE = {
  marginTop: '1px',
  opacity: 0.9,
  // 单行 + 省略号：列表要清爽，完整正文点开在 A4 里看
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}


/** 面板头部的收起按钮。 */
const PANEL_TOGGLE_STYLE = {
  float: 'right',
  marginLeft: '8px',
  padding: '1px 7px',
  borderRadius: '7px',
  border: '1px solid var(--studio-border)',
  background: 'var(--studio-surface)',
  color: 'var(--studio-muted)',
  font: '11px/1.6 "Segoe UI","Microsoft YaHei",sans-serif',
  cursor: 'pointer',
  pointerEvents: 'auto',
}

/** 收起后只留这么一个小按钮，不挡画面。 */
const PANEL_CHIP_STYLE = {
  position: 'absolute',
  right: '16px',
  bottom: '68px',
  padding: '4px 10px',
  borderRadius: '9px',
  border: '1px solid var(--studio-border)',
  background: 'var(--studio-surface)',
  color: 'var(--studio-text)',
  font: '11px/1.6 "Segoe UI","Microsoft YaHei",sans-serif',
  cursor: 'pointer',
}
const STATE_META_STYLE = { color: 'var(--studio-muted)', fontSize: '11px', marginTop: '4px' }

/**
 * 工作室视图。
 *
 * `props.sessionId` 是**本视图所属的会话**——会话作用域的 slot 会把它作为属性注入
 * （`ui-session` 对 `SessionStandardProps` 的声明合并，轨迹视图也用它取数据）。
 * 早期版本忽略了这个属性、改用 `ctx.sessions.list` 去猜会话，很可能一直在看
 * **别的会话**：那样即使你在对话里调用了工具，工作室也永远是一片待机。
 */
/** 一条调用事件 → 日志行。缺什么写什么，不补零。 */
function eventLine(row) {
  const time = typeof row.at === 'number' ? new Date(row.at).toLocaleTimeString() : '--:--:--'
  const where = row.postTitle === null ? '未归类' : row.postTitle
  const verdict = row.running
    ? '进行中'
    : row.outcome === 'success'
      ? '成功'
      : row.outcome === 'failure'
        ? '失败'
        : row.outcome === 'cancelled'
          ? '取消'
          : '未知'
  const duration = row.durationMs === null ? '耗时未知' : row.durationMs + 'ms'
  const error = typeof row.errorMessage === 'string' && row.errorMessage.length > 0 ? ' · ' + row.errorMessage : ''
  return time + ' · ' + where + ' · ' + row.doing + ' · ' + verdict + ' · ' + duration + error
}

/**
 * 从**当前会话**里读历史回答（汇报记录的主要来源）。
 *
 * 为什么不能只靠宿主快照（用户实测反馈："明明有历史对话啊"）：桥接只记录**插件启动之后**实时抓到的
 * `assistant/message`，所以这次对话里早先的回答一份都没有。而会话内容客户端本来就读得到——
 * `ctx.uiConversation.binding(sessionId).target('chat')` 的节点里，助手节点形如
 *   { kind: 'assistant', time, turn, step, blocks: [{ kind: 'text', text }, …], interrupted? }
 * 同一轮取最后一条助手消息（那才是这一轮的最终答复）。
 *
 * 用 `ctx.get(...)` 而不是 `inject`：没有 uiConversation 时也不能让整个插件加载失败。
 * 全程 try/catch —— 宿主内部结构不能因为我们的猜测而崩。
 */
function readChatHistory(ctx, sessionId, limit = 12) {
  const probes = []
  const safe = (fn) => { try { return fn() } catch (error) { probes.push('err:' + (error && error.message ? error.message : String(error)).slice(0, 40)); return null } }
  try {
    const conversation = typeof ctx.get === 'function' ? safe(() => ctx.get('uiConversation')) : null
    if (conversation === null || conversation === undefined || typeof conversation.binding !== 'function') {
      return { entries: [], note: '没有 uiConversation 服务', source: null }
    }
    const binding = safe(() => conversation.binding(sessionId))
    if (binding === null || binding === undefined || typeof binding.target !== 'function') {
      return { entries: [], note: 'binding 不可用', source: null }
    }

    // 三条候选来源（同一套节点结构），逐个试，能出结果就用它
    const chatSnapshot = safe(() => binding.target('chat').getSnapshot())
    const chatNodes = safe(() => {
      const fromStore = chatSnapshot !== null && chatSnapshot !== undefined && chatSnapshot.nodes !== undefined && typeof chatSnapshot.nodes.values === 'function'
        ? [...chatSnapshot.nodes.values()]
        : []
      if (fromStore.length > 0) return fromStore
      // chat 快照里还有一个兼容投影 legacy.nodes
      return chatSnapshot !== null && chatSnapshot !== undefined && chatSnapshot.legacy !== undefined && Array.isArray(chatSnapshot.legacy.nodes)
        ? [...chatSnapshot.legacy.nodes]
        : []
    }) ?? []
    probes.push('chat ' + chatNodes.length)

    let entries = extractAnswers(chatNodes, limit)
    let source = entries.length > 0 ? 'chat' : null

    if (entries.length === 0) {
      const trajectory = safe(() => binding.target('trajectory').getSnapshot())
      const trajNodes = trajectory !== null && trajectory !== undefined && Array.isArray(trajectory.eventNodes) ? [...trajectory.eventNodes] : []
      probes.push('轨迹 ' + trajNodes.length)
      const fromTrajectory = extractAnswers(trajNodes, limit)
      if (fromTrajectory.length > 0) {
        entries = fromTrajectory
        source = '轨迹'
      }
    }

    const keys = chatSnapshot !== null && chatSnapshot !== undefined && typeof chatSnapshot === 'object'
      ? Object.keys(chatSnapshot).slice(0, 8).join(',')
      : String(chatSnapshot)
    return { entries, note: probes.join(' · ') + ' · chat 快照键 ' + keys, source }
  } catch (error) {
    return { entries: [], note: '读取失败：' + (error && error.message ? error.message : String(error)), source: null }
  }
}

/** 从节点数组里抽每轮的回答：同一轮取 seq 最大的助手消息，只取 text 块。 */
function extractAnswers(nodes, limit) {
  const byTurn = new Map()
  for (const node of nodes ?? []) {
    if (node === null || node === undefined || node.kind !== 'assistant') continue
    if (!Array.isArray(node.blocks)) continue
    const text = node.blocks
      .filter((block) => block !== null && block !== undefined && block.kind === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(String.fromCharCode(10, 10))
      .trim()
    if (text.length === 0) continue
    const turn = typeof node.turn === 'number' ? node.turn : 0
    const seq = typeof node.seq === 'number' ? node.seq : 0
    const existing = byTurn.get(turn)
    if (existing === undefined || seq >= existing.seq) {
      byTurn.set(turn, {
        turn,
        seq,
        at: typeof node.time === 'number' ? node.time : null,
        text,
        chars: text.length,
        interrupted: node.interrupted === true,
        historical: true,
      })
    }
  }
  return [...byTurn.values()].sort((a, b) => b.turn - a.turn).slice(0, limit)
}

/** 一条交付 → 日志行。 */
function deliveryLogLine(item) {
  const time = typeof item.at === 'number' ? new Date(item.at).toLocaleTimeString() : '--:--:--'
  const verdict = item.completed ? '已完成' : item.reasonKind ? '未完成（' + item.reasonKind + '）' : '本轮结束'
  return time + ' · 交付 · ' + verdict + ' · 全文 ' + item.chars + ' 字'
}

/**
 * 员工日志正文：把**调用事件**与**交付**按时间合并，新的在上。
 * 这是"记录事件"的主体，所以只写真实发生过的事，不做汇总美化。
 */
function formatEventLog(snapshot, ownSessionId) {
  if (snapshot === null) return '（状态尚未就绪）'
  const picked = pickSession(snapshot, ownSessionId)
  const events = Array.isArray(picked.data.events) ? picked.data.events : []
  const deliveries = snapshot.model !== null && snapshot.model !== undefined && Array.isArray(snapshot.model.deliveries)
    ? snapshot.model.deliveries
    : []
  const rows = []
  for (const row of events) rows.push({ at: typeof row.at === 'number' ? row.at : 0, text: eventLine(row) })
  for (const item of deliveries) rows.push({ at: typeof item.at === 'number' ? item.at : 0, text: deliveryLogLine(item) })
  rows.sort((a, b) => b.at - a.at)
  if (rows.length === 0) return '（还没有事件——员工只在工具被调用时开工）'
  const shown = rows.slice(0, 40)
  const lines = shown.map((row) => row.text)
  if (rows.length > shown.length) lines.push('…（更早的 ' + (rows.length - shown.length) + ' 条未显示）')
  return lines.join(String.fromCharCode(10))
}

/** 汇报记录里一张纸的抬头：时间 + 性质 + 字数。 */
function reportMeta(item) {
  const at = typeof item.at === 'number' ? new Date(item.at).toLocaleString() : '未知时间'
  const verdict = item.historical === true
    ? item.interrupted === true
      ? '已停止'
      : '历史'
    : item.completed
      ? '已完成'
      : item.reasonKind
        ? '未完成（' + item.reasonKind + '）'
        : '本轮结束'
  return at + ' · ' + verdict + ' · ' + item.chars + ' 字'
}

/**
 * 汇报记录里一条的摘要：把正文压成**一行可读的文字**。
 *
 * 为什么必须清洗：正文是 Markdown，直接取首行会露出 `**加粗**`、`` `代码` ``、`- 列表` 这些记号，
 * 列表里看起来就是乱码（用户实测截图里的 `**135 /…`）。这里去掉记号、压平空白，再交给 CSS 省略号截断。
 */
function reportPreview(item) {
  const raw = String(item.text === undefined || item.text === null ? '' : item.text)
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/`([^`]*)`/g, '$1')                 // 行内代码
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')  // 链接/图片
    .replace(/^[>#]+\s*/gm, '')                 // 引用与标题记号
    .replace(/^\s*[-*+]\s+/gm, '')             // 列表记号
    .replace(/\*\*|__|~~/g, '')                // 加粗/斜体/删除线
    .replace(/\s+/g, ' ')
    .trim()
  const text = cleaned.length > 0 ? cleaned : raw.replace(/\s+/g, ' ').trim()
  return text.length > 64 ? text.slice(0, 64) + '…' : text
}

function StudioView(props) {
  const hostRef = React.useRef(null)
  const mountedRef = React.useRef(null)
  const [zoom, setZoom] = React.useState(1)
  const [viewLocked, setViewLocked] = React.useState(false)
  const viewLockedRef = React.useRef(false)
  const viewSessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' && props.sessionId.length > 0
    ? props.sessionId
    : null
  // status 现在只承载**错误**：正常载入的文案由幕布负责，技术字样不上屏
  const [status, setStatus] = React.useState('')
  const [diagText, setDiagText] = React.useState('')
  /** 汇报记录：默认收起，点开才展开。 */
  const [reportsOpen, setReportsOpen] = React.useState(false)
  const [reportsScroll, setReportsScroll] = React.useState({ overflow: false, atBottom: false })
  const reportsRef = React.useRef(null)
  /** 会话历史里的回答（供汇报记录）；每轮轮询时刷新。 */
  const historyRef = React.useRef({ entries: [], note: '尚未读取' })
  const [snapshot, setSnapshot] = React.useState(null)
  const [selected, setSelected] = React.useState(null)
  // 面板挡画面（用户明确反馈），所以可收起，并把选择记在本地
  // 加载/取景提示是一次性信息，就位后自动淡出，别长期占着画面
  const [statusVisible, setStatusVisible] = React.useState(true)
  React.useEffect(() => {
    if (!status.startsWith('场景已渲染')) {
      setStatusVisible(true)
      return undefined
    }
    const timer = setTimeout(() => setStatusVisible(false), 8000)
    return () => clearTimeout(timer)
  }, [status])
  /** 开幕幕布：phase 'in' 显示 / 'out' 淡出 / 'gone' 卸载。 */
  const [curtain, setCurtain] = React.useState({ phase: 'in', note: '点亮工位…', progress: 0.18 })
  const [loadInfo, setLoadInfo] = React.useState(null)
  const [panelOpen, setPanelOpen] = React.useState(() => {
    try {
      return localStorage.getItem('studio.panel') !== 'closed'
    } catch {
      return true
    }
  })
  const togglePanel = () => {
    setPanelOpen((open) => {
      const next = !open
      try {
        localStorage.setItem('studio.panel', next ? 'open' : 'closed')
      } catch {
        /* 存不了就只在本次会话生效 */
      }
      return next
    })
  }

  React.useEffect(() => {
    let cancelled = false
    let mounted = null
    let pollTimer = null
    let polling = false
    /** 上次成功读到快照的路径（相对优先），此后优先重试它，少走弯路。 */
    let statePathInUse = null

    // 载入耗时：只在面板里显示，不进画面
    let loadStartedAt = Date.now()
    let readFinishedAt = 0
    let payloadMb = 0

    /** 场景回调：就绪 → 收幕（技术文案不上屏）；出错 → 保留错误，幕布上只留一句平静的话。 */
    const handleSceneStatus = (message) => {
      const text = typeof message === 'string' ? message : ''
      if (text.startsWith('场景已渲染')) {
        const totalMs = Date.now() - loadStartedAt
        setLoadInfo({
          readMs: Math.max(0, readFinishedAt - loadStartedAt),
          parseMs: Math.max(0, totalMs - Math.max(0, readFinishedAt - loadStartedAt)),
          totalMs,
          mb: payloadMb,
        })
        setCurtain({ phase: 'out', note: '', progress: 1 })
        setTimeout(() => setCurtain((current) => (current.phase === 'out' ? { ...current, phase: 'gone' } : current)), 900)
        return
      }
      // 失败必须说清楚：幕布上给一句人话，技术原因进面板。
      // 幕布随后自己退开——否则它盖住面板和错误提示，我就看不到失败原因了。
      setStatus(text)
      setCurtain({ phase: 'in', note: '3D 工作室暂时进不去', progress: 1 })
      setTimeout(() => setCurtain((current) => (current.phase === 'in' ? { ...current, phase: 'gone' } : current)), 1400)
    }

    const boot = async () => {
      try {
        const ctx = ctxRef.current
        if (ctx === null) {
          handleSceneStatus('内部错误：插件上下文未就绪')
          return
        }
        // 优先用本视图自己的会话；拿不到才退回 sessions.list（并等它就绪）
        const sessionId = viewSessionId ?? (await waitForSessionId(ctx))
        if (cancelled) return
        if (sessionId === null) {
          handleSceneStatus('取不到会话 id，无法读取资源；切换视图后再回来可重试')
          return
        }
        setCurtain({ phase: 'in', note: '点亮工位…', progress: 0.34 })
        loadStartedAt = Date.now()

        // 资源位置：**优先读宿主写好的路径**（宿主按包位置解析，装到谁的机器上都成立），
        // 读不到才退回构建期注入的路径（开发形态）。这样同一个 bundle 不必写死绝对路径。
        let glbPath = STUDIO_GLB
        let artRoot = typeof __STUDIO_ART_ROOT__ === 'string' ? __STUDIO_ART_ROOT__ : null
        let foundSnapshot = false
        let assetsResolved = false
        let snapshotFailures = []
        // 重试窗口 8×500ms ≈ 4 秒：宿主刚起来时首份快照可能还没落盘（防抖 250ms + 存储态会话枚举），
        // 窗口太短会让用户看到一次"读不到"再手动刷新。
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const found = await readStudioSnapshot(ctx, sessionId, statePathInUse)
          if (cancelled) return
          if (found.snapshot !== null) {
            foundSnapshot = true
            statePathInUse = found.path
            const assets = found.snapshot.assets
            if (assets !== null && assets !== undefined && typeof assets.glb === 'string') {
              glbPath = assets.glb
              assetsResolved = true
              if (typeof assets.art === 'string') artRoot = assets.art
              break
            }
            // 快照读到了但里面没有资源路径：再等也没用，宿主确实没解析到
            snapshotFailures = ['快照里没有资源路径（宿主 assets 解析为空）']
            break
          }
          snapshotFailures = found.failures
          // 宿主可能还没写出快照：等一会儿再试
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (cancelled) return
        }
        // 失败要报**真正卡住的那一步**：快照读不到就说快照，别丢给下游报成"GLB 读不到"
        if (!foundSnapshot) {
          handleSceneStatus('读不到宿主状态快照：' + (snapshotFailures.join('；') || '原因未知'))
          return
        }
        if (!assetsResolved) {
          handleSceneStatus('宿主快照里没有模型路径：' + snapshotFailures.join('；'))
          return
        }
        const payload = unwrapRemote(
          await ctx.remote.workspaceFiles.readAll(sessionId, glbPath, new AbortController().signal),
        )
        if (cancelled) return
        if (!payload || typeof payload.data !== 'string') {
          handleSceneStatus('readAll 未返回字节数据')
          return
        }
        const buffer = base64ToArrayBuffer(payload.data)
        const magic = String.fromCharCode(...new Uint8Array(buffer.slice(0, 4)))
        if (magic !== 'glTF') {
          handleSceneStatus('取回的数据不是 GLB（magic="' + magic + '"）')
          return
        }
        readFinishedAt = Date.now()
        payloadMb = Number((buffer.byteLength / 1048576).toFixed(2))
        setCurtain({ phase: 'in', note: '唤醒员工…', progress: 0.62 })
        if (cancelled || hostRef.current === null) return
        const artTextures = await loadStudioArt(async file => {
          if (artRoot === null) throw new Error('宿主未提供美术图目录')
          const payload = unwrapRemote(await ctx.remote.workspaceFiles.readAll(sessionId, artRoot + '/' + file, new AbortController().signal))
          if (typeof payload?.data !== 'string') throw new Error('海报资源读取失败：' + file)
          return 'data:image/png;base64,' + payload.data
        })
        if (cancelled) { for (const texture of Object.values(artTextures)) texture.dispose(); return }
        mounted = mountStudio(hostRef.current, buffer, handleSceneStatus, setSelected, artTextures)
        mountedRef.current = mounted
        mounted.setZoom(zoom)
        mounted.setViewLocked(viewLockedRef.current)

        // 开始轮询宿主状态快照
        const poll = async () => {
          if (cancelled || polling) return
          polling = true
          try {
            const found = await readStudioSnapshot(ctx, sessionId, statePathInUse)
            if (cancelled) return
            if (found.snapshot === null) {
              // 每条候选都读不到：把原因写出来（宿主没启动桥接 / 会话没有工作区 / 路径不对 都在这儿区分）
              setStateText('等待宿主状态…（' + found.failures.join('；') + '）')
              return
            }
            statePathInUse = found.path
            const snapshot = found.snapshot
            if (mounted === null) return
            mounted.applyState(snapshot, sessionId)
            // 汇报记录的主要来源：从当前会话读历史回答（宿主快照只含插件启动后抓到的）
            historyRef.current = readChatHistory(ctx, sessionId)
            setDiagText(formatDiagnostics(mounted.getDiagnostics()))
            setSnapshot(snapshot)
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            setStateText('等待宿主状态…（' + message + '）')
          } finally {
            polling = false
          }
        }
        await poll()
        pollTimer = setInterval(poll, STATE_POLL_MS)
      } catch (error) {
        if (!cancelled) handleSceneStatus('加载失败：' + (error && error.message ? error.message : String(error)))
      }
    }

    // 工作室视图内隐藏那两条拖拽条；离开视图立刻恢复（切回对话即可拖拽调宽）
    const releaseWidthHandles = muteWidthHandles()
    boot()
    return () => {
      cancelled = true
      releaseWidthHandles()
      if (pollTimer !== null) clearInterval(pollTimer)
      if (mounted !== null) mounted.unmount()
      mountedRef.current = null
    }
    // 会话变了要重新挂载：数据源与 Remote 读取都按会话寻址
  }, [viewSessionId])

  /** 展开后量一次：内容是否溢出（决定要不要给"可滚动"提示）。 */
  const measureReportsScroll = React.useCallback(() => {
    const node = reportsRef.current === null ? null : reportsRef.current.querySelector('.dsh-studio-scroll')
    if (node === null || node === undefined) {
      setReportsScroll({ overflow: false, atBottom: false })
      return
    }
    const overflow = node.scrollHeight - node.clientHeight > 4
    const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 4
    setReportsScroll({ overflow, atBottom })
  }, [])

  React.useEffect(() => {
    if (!reportsOpen) {
      setReportsScroll({ overflow: false, atBottom: false })
      return undefined
    }
    measureReportsScroll()
    return undefined
  }, [reportsOpen, measureReportsScroll])

  const detail = selected === null ? null : formatPostDetail(snapshot, viewSessionId, selected)
  // 汇报记录 = 会话历史（读 chat 节点） + 插件实时抓到的交付，按轮次去重（实时的优先，它带结束性质）
  const liveDeliveries = snapshot !== null && snapshot.model !== null && snapshot.model !== undefined && Array.isArray(snapshot.model.deliveries)
    ? snapshot.model.deliveries
    : []
  const historyRead = historyRef.current
  const seenTurns = new Set(liveDeliveries.map((item) => item.turn))
  const reports = [
    ...liveDeliveries,
    ...(historyRead.entries ?? []).filter((item) => !seenTurns.has(item.turn)),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const eventCount = (() => {
    if (snapshot === null) return 0
    const picked = pickSession(snapshot, viewSessionId)
    const events = Array.isArray(picked.data.events) ? picked.data.events.length : 0
    return events + reports.length
  })()

  return React.createElement(
    'div',
    {
      style: HOST_STYLE,
      // 点空白处（含 3D 画面）就收起汇报记录；点面板内部不收起
      onClick: (event) => {
        if (!reportsOpen) return
        const panel = reportsRef.current
        if (panel !== null && panel !== undefined && panel.contains(event.target)) return
        setReportsOpen(false)
      },
    },
    React.createElement(
      'div',
      { style: CARD_STYLE },
      React.createElement('div', { style: { position: 'absolute', zIndex: 2, right: '16px', bottom: '20px', width: 'min(300px, calc(100% - 32px))', display: 'flex', gap: '10px', alignItems: 'center', color: 'var(--studio-text)' } },
        React.createElement('span', { 'aria-hidden': true }, '−'),
        React.createElement('input', { type: 'range', min: 0.65, max: 1.8, step: 0.01, value: zoom, disabled: viewLocked, 'aria-label': '场景缩放', title: viewLocked ? '视角已固定' : '场景缩放', style: { width: '100%', minWidth: 0, accentColor: '#92a68a', opacity: viewLocked ? 0.45 : 1 }, onChange: (event) => { const value = Number(event.target.value); setZoom(value); mountedRef.current?.setZoom(value) } }),
        React.createElement('span', { 'aria-hidden': true }, '+'),
        React.createElement('button', {
          type: 'button', 'aria-pressed': viewLocked, title: viewLocked ? '解锁旋转和缩放' : '锁定当前角度和远近',
          style: { ...PANEL_TOGGLE_STYLE, float: 'none', marginLeft: 0, flexShrink: 0, width: '84px', height: '30px', padding: '4px 8px' },
          onClick: () => { const next = !viewLockedRef.current; viewLockedRef.current = next; setViewLocked(next); mountedRef.current?.setViewLocked(next) },
        }, viewLocked ? '解除固定' : '固定视角')),
      React.createElement('div', { ref: hostRef, style: CANVAS_STYLE }),
      status !== '' ? React.createElement('div', { style: STATUS_STYLE }, status) : null,
      React.createElement(
        'div',
        { style: REPORTS_STYLE, ref: reportsRef },
        React.createElement(
          'button',
          { type: 'button', style: REPORTS_TRIGGER_STYLE, onClick: () => setReportsOpen((open) => !open), title: reportsOpen ? '收起汇报记录' : '展开汇报记录' },
          '汇报记录 · ' + reports.length + (reportsOpen ? ' ⌃' : ' ⌄'),
        ),
        reportsOpen
          ? React.createElement(
            'div',
            { style: REPORTS_PANEL_STYLE },
            React.createElement(
              'div',
              {
                className: 'dsh-studio-scroll',
                style: REPORTS_LIST_STYLE,
                onScroll: () => {
                  const node = reportsRef.current === null ? null : reportsRef.current.querySelector('.dsh-studio-scroll')
                  if (node === null || node === undefined) return
                  const overflow = node.scrollHeight - node.clientHeight > 4
                  const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 4
                  setReportsScroll({ overflow, atBottom })
                },
              },
              reports.length === 0
                ? React.createElement(
                  'div',
                  { style: { ...REPORT_SHEET_STYLE, cursor: 'default', opacity: 0.9 } },
                  React.createElement('div', { style: REPORT_META_STYLE }, '还没有汇报'),
                  React.createElement('div', { style: REPORT_PREVIEW_STYLE }, 'AI 回答结束后，这里会叠上第一张'),
                  React.createElement(
                    'div',
                    { style: { ...REPORT_META_STYLE, marginTop: '3px', opacity: 0.85 } },
                    '读取：' + (historyRead.note ?? '尚未读取'),
                  ),
                )
                : reports.map((item, index) =>
                  React.createElement(
                    'button',
                    {
                      key: String(item.at) + '-' + index,
                      type: 'button',
                      title: '点开这份汇报（A4 全文）',
                      style: REPORT_SHEET_STYLE,
                      onClick: () => {
                        setReportsOpen(false)
                        mountedRef.current?.openDelivery({
                          text: item.text,
                          chars: item.chars,
                          truncated: item.truncated === true || item.abridged === true,
                          reasonKind: item.reasonKind === undefined ? null : item.reasonKind,
                          historical: item.historical === true,
                        })
                      },
                    },
                    React.createElement('div', { style: REPORT_META_STYLE }, reportMeta(item)),
                    React.createElement('div', { style: REPORT_PREVIEW_STYLE }, reportPreview(item)),
                  ),
                ),
            ),
            reportsScroll.overflow && !reportsScroll.atBottom
              ? React.createElement('div', { className: 'dsh-studio-bob', style: REPORTS_SCROLL_HINT_STYLE }, '⌄ 可滚动')
              : null,
          )
          : null,
      ),
      panelOpen
        ? React.createElement(
          'div',
          { style: LOG_STYLE },
          React.createElement(
            'div',
            { style: LOG_HEAD_STYLE },
            React.createElement('span', { style: LOG_TITLE_STYLE }, '员工日志'),
            React.createElement(
              'span',
              { style: { ...STATE_META_STYLE, marginTop: '0', marginLeft: 'auto' } },
              '事件 ' + eventCount + ' 条',
            ),
            React.createElement('button', { style: PANEL_TOGGLE_STYLE, onClick: togglePanel }, '收起'),
          ),
          React.createElement(
            'div',
            { style: LOG_BODY_STYLE },
            detail === null ? null : React.createElement('div', { style: { marginBottom: '7px' } }, detail),
            React.createElement('div', { style: STREAM_STYLE }, formatModel(snapshot)),
            snapshot !== null && snapshot.model !== null && snapshot.model !== undefined && snapshot.model.delivery !== null && snapshot.model.delivery !== undefined
              ? React.createElement('div', { style: STREAM_STYLE }, formatDelivery(snapshot.model.delivery))
              : null,
            React.createElement('div', { style: STREAM_STYLE }, formatEventLog(snapshot, viewSessionId)),
            React.createElement(
              'div',
              { style: STATE_META_STYLE },
              '汇报历史：' + (historyRead.note ?? '') + '（并入汇报记录 ' + reports.length + ' 份）',
            ),
            diagText === '' ? null : React.createElement('div', { style: STATE_META_STYLE }, diagText),
            loadInfo === null
              ? null
              : React.createElement(
                'div',
                { style: STATE_META_STYLE },
                `载入：读回 ${loadInfo.readMs}ms · 解析 ${loadInfo.parseMs}ms · 合计 ${(loadInfo.totalMs / 1000).toFixed(2)}s · ${loadInfo.mb} MB`,
              ),
            React.createElement(
              'div',
              { style: STATE_META_STYLE },
              '点击员工或工位可查看详情（再点一次取消）。中央总控台上的机器人是模型本人。',
            ),
          ),
        )
        : React.createElement('button', { style: PANEL_CHIP_STYLE, onClick: togglePanel }, '▴ 员工日志'),
      curtain.phase === 'gone'
        ? null
        : React.createElement(
          'div',
          { style: { ...CURTAIN_STYLE, opacity: curtain.phase === 'out' ? 0 : 1 } },
          React.createElement('div', { style: CURTAIN_WORD_STYLE }, '3D 工作室'),
          React.createElement('div', { style: CURTAIN_NOTE_STYLE }, curtain.note),
          React.createElement(
            'div',
            { style: CURTAIN_BAR_STYLE },
            React.createElement('div', { style: { ...CURTAIN_FILL_STYLE, width: (curtain.progress * 100).toFixed(0) + '%' } }),
          ),
        ),
    ),
  )
}

/** 交付摘要（面板里可复制的那份）：性质 + 字数 + 开头一段原文。 */
function formatDelivery(delivery) {
  if (delivery === null || delivery === undefined) return ''
  const kind = delivery.reasonKind
  const verdict = kind === null || kind === undefined
    ? '本轮结束'
    : kind === 'completed'
      ? '已完成'
      : '未完成（' + kind + '）'
  const text = String(delivery.text)
  const short = text.length > 220 ? text.slice(0, 220) + '…' : text
  const note = delivery.truncated ? `（快照只带前 ${text.length} 字 / 全文 ${delivery.chars} 字）` : ''
  return `【交付】${verdict} · 全文 ${delivery.chars} 字${note}
${short}`
}

/** 模型阶段的中文显示名。 */
const MODEL_PHASE_TEXT = {
  idle: '待机',
  thinking: '思考中',
  writing: '撰写中',
  calling: '派活中',
  retrying: '重试中',
}

/**
 * 模型自己的活动（思维流 / 撰写 / 派活 / token）。
 *
 * **显示纪律**：token 只在适配器真的上报过时才显示数字；没上报就写"未上报"，
 * 不写 0（产品文档第二原则 —— 动画与数字都必须代表真实系统状态）。
 */
function formatModel(snapshot) {
  if (snapshot === null || snapshot.model === null || snapshot.model === undefined) {
    return '【模型】活动：未知（宿主未上报）'
  }
  const model = snapshot.model
  const lines = []
  const phase = MODEL_PHASE_TEXT[model.phase] ?? model.phase
  lines.push(`【模型】${phase} · 轮次 ${model.turn ?? '未知'} 步骤 ${model.step ?? '未知'}`)
  if (model.usageReports > 0) {
    const t = model.totals
    lines.push(
      `token 累计：读取 ${t.inputTokens}（缓存命中 ${t.cacheReadTokens}）· 编写 ${t.outputTokens} · 思维 ${t.reasoningTokens}`,
    )
  } else {
    lines.push('token：未上报')
  }
  lines.push(`本次活动：思维 ${model.reasoningChars} 字 · 输出 ${model.textChars} 字 · 工具调用 ${model.toolCallCount} 次`)
  if (model.reasoningTail !== '') lines.push(`思维流… ${model.reasoningTail}`)
  if (model.textTail !== '') lines.push(`输出… ${model.textTail}`)
  return lines.join('\n')
}

/**
 * 工位详情（VIS-05 / MVP-04）：当前任务、运行中的调用、本会话调用次数、最近结果/错误。
 * 全部来自宿主快照，**没有的项写"未知"**，不用零代替（规划第 10 节的风险项）。
 */
function formatPostDetail(snapshot, ownSessionId, stationIndex) {
  const lines = [`岗位 ${stationIndex + 1} 详情`]
  if (snapshot === null) {
    lines.push('（状态尚未就绪）')
    return lines.join('\n')
  }
  const picked = pickSession(snapshot, ownSessionId)
  const post = (picked.data.posts ?? [])[stationIndex]
  if (post === undefined) {
    lines.push('（该岗位没有数据）')
    return lines.join('\n')
  }
  // 主文案是"正在做某件事"，不是统计
  lines.push(`${post.title} · ${post.doing}`)
  const running = Array.isArray(post.running) ? post.running : []
  if (running.length > 0) {
    lines.push('正在做：')
    for (const item of running) {
      const at = typeof item.startedAt === 'number' ? new Date(item.startedAt).toLocaleTimeString() : '未知'
      lines.push(`  · ${item.doing}（${item.toolName}，${at} 开始）`)
      if (typeof item.thought === 'string' && item.thought.length > 0) lines.push(`    ${item.thought}`)
    }
  } else {
    lines.push('正在做：无（在岗待命）')
  }
  const last = post.lastFinished
  if (last !== null && last !== undefined) {
    const at = typeof last.finishedAt === 'number' ? new Date(last.finishedAt).toLocaleTimeString() : '未知'
    lines.push(`刚做完：${last.doing} · ${last.outcome} · ${at}`)
    if (typeof last.thought === 'string' && last.thought.length > 0) lines.push(`  ${last.thought}`)
  }
  // 承包方：这个岗位上的活是哪个插件在干（岗位固定，插件轮换）
  lines.push(`承包方：${post.providers.length > 0 ? post.providers.join('、') : '未记录'}`)
  lines.push(`本会话：成功${post.success} 失败${post.failure} 取消${post.cancelled}`)
  return lines.join('\n')
}

/** 渲染诊断的可复制文本。答三个问题：循环在跑吗、页面被判隐藏吗、动作建出来了吗。 */
function formatDiagnostics(diag) {
  if (diag === null || diag === undefined) return ''
  const lines = []
  lines.push(
    `渲染：第 ${diag.frames} 帧 · dt=${diag.lastDeltaMs}ms · 页面隐藏=${diag.lastHidden}` +
      (diag.hiddenFrames > 0 ? `（隐藏帧 ${diag.hiddenFrames}）` : ''),
  )
  lines.push(
    `动作：匹配工位 ${diag.matchedStations}/${STATION_COUNT}` + (diag.fallback ? ' · ⚠ 已回退为整体播放' : ''),
  )
  if (diag.clips.length > 0) {
    lines.push('剪辑：' + diag.clips.map((clip) => `${clip.name}(${clip.tracks}轨)`).join(' · '))
    const sample = diag.clips.find((clip) => clip.sample !== null && clip.sample !== undefined)
    if (sample !== undefined) lines.push('示例轨道名：' + sample.sample)
  }
  if (typeof diag.historyNote === 'string') lines.push('汇报历史：' + diag.historyNote)
  lines.push('工位动作：' + diag.stationStates.map((state, index) => `${index}:${state}`).join(' '))
  if (diag.canvas !== undefined && diag.canvas !== null) {
    const c = diag.canvas
    const expectedW = Math.round(c.cssW * c.dpr)
    const expectedH = Math.round(c.cssH * c.dpr)
    const ok = Math.abs(c.bufferW - expectedW) <= 2 && Math.abs(c.bufferH - expectedH) <= 2
    lines.push(
      `画布：容器 ${c.cssW}×${c.cssH} · 缓冲 ${c.bufferW}×${c.bufferH} · dpr ${c.dpr} · 重排 ${c.resizes} 次 · ` +
        (ok ? '缓冲与容器匹配 ✅' : '⚠ 缓冲未跟随容器（比例/清晰度会不对）'),
    )
  }
  if (typeof document !== 'undefined') {
    const handles = document.querySelectorAll('[data-width-handle]').length
    lines.push(`宽度拖拽条：文档里 ${handles} 个（3D 工作室视图内已隐藏；切回「对话」可拖拽调宽）`)
  }
  if (Array.isArray(diag.bubbleTexts)) {
    const shown = diag.bubbleTexts.map((text, index) => `${index}:${text === '' ? '—' : text}`).join(' | ')
    lines.push('气泡文字：' + shown)
  }
  if (diag.note !== null) lines.push('说明：' + diag.note)
  return lines.join('\n')
}

/**
 * 气泡停留时长：干完活之后再留这么久，然后淡出消失。
 *
 * 用户口径（2026-09-11）：**完成了停留一会儿就好，不要作为"上次"一直留在那**；
 * 也不要任何"上次 / 刚完成 / 思维："之类的标签——标签一加就从"同事在想什么"
 * 变成"系统在报告"。所以时间信息只用**透明度**表达：说的时候是亮的，
 * 说完的这段时间里缓缓淡出，然后彻底消失。
 */
const BUBBLE_LINGER_MS = 25_000

/**
 * 气泡内容。
 *   正在做 → 亮着：在做的那件事 + 此刻的想法（真实推理原文，无前缀）
 *   刚做完 → 同样的内容，25 秒内从接近全亮线性淡到透明，然后消失
 *   更早   → 不显示（不留"上次"）
 */
function bubbleForPost(post, now) {
  if (post === null || post === undefined) return { text: '', opacity: 0, detail: '' }
  const running = Array.isArray(post.running) ? post.running : []
  if (running.length > 0) {
    // 一个气泡装一个念头：多件同时进行时只呈现第一件，不堆清单
    return { text: running[0].doing, opacity: 1, detail: running[0].thought ?? '' }
  }
  const last = post.lastFinished
  const at = post.lastActivityAt
  if (last === null || last === undefined || at === null || at === undefined) return { text: '', opacity: 0, detail: '' }
  const age = now - at
  if (age >= BUBBLE_LINGER_MS) return { text: '', opacity: 0, detail: '' }
  const fade = 1 - age / BUBBLE_LINGER_MS
  return { text: String(last.doing), opacity: 0.95 * fade, detail: last.thought ?? '' }
}

/** 总控台气泡：模型真正在想/在写的内容（真实推理尾巴，不是套话）。 */
function bubbleTextForModel(model) {
  if (model === null || model === undefined) return ''
  const tail = (text, limit) => {
    const flat = String(text).replace(/\s+/g, ' ').trim()
    return flat.length > limit ? '…' + flat.slice(flat.length - limit) : flat
  }
  if (model.phase === 'thinking') {
    const text = tail(model.reasoningTail ?? '', 90)
    return text.length > 0 ? '思考中：' + text : '思考中…'
  }
  if (model.phase === 'writing') {
    const text = tail(model.textTail ?? '', 90)
    return text.length > 0 ? '撰写中：' + text : '撰写中…'
  }
  if (model.phase === 'calling') return '派活中…'
  if (model.phase === 'retrying') return '重试中…'
  return ''
}


// ── 插件入口 ──────────────────────────────────────────────────────────

/** 组件外部拿不到 Cordis ctx，用 ref 传递；apply 时写入。 */
const ctxRef = { current: null }

/** 视图标签。宿主会把它渲染在「对话 / 轨迹」旁边。 */
function viewLabel() {
  return '3D 工作室'
}

/**
 * 主题变量要**在插件激活时就挂到 documentElement**，不能等到 mountStudio。
 * 原因：开幕幕布显示的时候 GLB 还在读/解析，mountStudio 还没跑，变量不存在 →
 * 幕布落到浅色回退值 → 深色主题下"一开始还是白色"（用户实测反馈）。
 * 挂一次即可；插件生命周期内一个 MutationObserver + 九个属性，不构成泄漏。
 */
let themeRootInstalled = false
/** 我们自己的 chrome 样式：滚动条隐藏 + "可滚动"提示的浮动动画。只影响带 dsh-studio-* 类的元素。 */
let chromeStyleInstalled = false

export function apply(ctx) {
  if (!chromeStyleInstalled) {
    chromeStyleInstalled = true
    try {
      const style = document.createElement('style')
      style.id = 'dsh-studio-chrome'
      style.textContent = [
        '.dsh-studio-scroll{scrollbar-width:none;-ms-overflow-style:none}',
        '.dsh-studio-scroll::-webkit-scrollbar{width:0;height:0;display:none}',
        '@keyframes dsh-studio-bob{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(3px);opacity:1}}',
        '.dsh-studio-bob{animation:dsh-studio-bob 1.25s ease-in-out infinite}',
      ].join(String.fromCharCode(10))
      document.head.appendChild(style)
    } catch (error) {
      console.error('[' + PACKAGE_NAME + '] chrome 样式注入失败：', error)
    }
  }
  if (!themeRootInstalled) {
    themeRootInstalled = true
    try {
      installStudioThemeRoot()
    } catch (error) {
      console.error('[' + PACKAGE_NAME + '] 主题变量初始化失败：', error)
    }
  }
  ctxRef.current = ctx

  ctx.slots.inject('conversation.view', () => {
    try {
      ctx.slots.register(
        {
          name: 'conversation.view',
          id: VIEW_ID,
          order: VIEW_ORDER,
          label: viewLabel,
        },
        StudioView,
      )
      console.log('[' + PACKAGE_NAME + '] 已注册「3D 工作室」视图到 conversation.view')
    } catch (error) {
      // 注册失败时**把原因显示出来**，否则表现只是"tab 没出现"，属于无提示失败。
      console.error('[' + PACKAGE_NAME + '] conversation.view 注册失败：', error)
      showRegistrationFailure(ctx, error)
    }
  })
}

/** 注册失败时把错误落到侧栏可见处——排查时不必依赖浏览器控制台。 */
function showRegistrationFailure(ctx, error) {
  const message = '3D 工作室视图注册失败：' + (error && error.message ? error.message : String(error))
  try {
    ctx.slots.inject('sidebar.footer.action', () => {
      try {
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: PACKAGE_NAME + '-error' },
          () =>
            React.createElement(
              'div',
              {
                style: {
                  padding: '6px 10px',
                  margin: '4px',
                  borderRadius: '8px',
                  border: '1px solid var(--studio-error-border, #d9a3a3)',
                  background: 'var(--studio-error-bg, #fbeaea)',
                  color: 'var(--studio-error-text, #8a3b3b)',
                  font: '12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif',
                },
              },
              message,
            ),
        )
      } catch {
        /* 连错误都显示不出来时只能放弃，避免二次抛错影响宿主 */
      }
    })
  } catch {
    /* 同上 */
  }
}
