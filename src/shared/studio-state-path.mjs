/**
 * 工作室状态文件位置（宿主写、客户端读的唯一约定）
 *
 * 为什么用文件而不是自建 Remote 服务：
 *   官方 Gateway 只支持**构建期**登记的 Remote contribution（`registerRemoteEvents`
 *   的转发事件名单是编译期固定的 allowlist），手写 .mjs 插件无法在运行时注册新的
 *   Remote 方法——那需要 Typert 代码生成。而 `workspaceFiles` Remote 服务两端通用
 *   （桌面端不开放 Web 服务，自建路由不可用），已在 M1 实测可读绝对路径。
 *   所以宿主把快照写成 JSON，客户端用同一条 Remote 通道读回。
 *
 * 落点：**用户目录**（默认 `<home>/.dsh/studio/state.json`）。
 *   不再放项目目录——插件装进 profile 后包目录可能只读，而项目目录在别人机器上根本不存在。
 *   `home` 由调用方传入（宿主与构建脚本都用 `process.env.DSH_HOME || os.homedir()`），
 *   本模块保持**纯函数**，浏览器侧也能安全引用。
 *   `DSH_STUDIO_STATE` 可覆盖为绝对文件路径。
 *
 * **为什么要同时写一份到会话工作区**（可移植性的命门，见 `STUDIO_WORKSPACE_STATE`）：
 *   上面这个绝对路径是**构建期**算出来的，烤进 bundle 就固定成"打包那台机器"的路径。
 *   换机器/换账号/设了 DSH_HOME，客户端就再也读不到快照——而快照读不到，
 *   连 GLB 路径都拿不到（资源位置也走快照），工作室会整个打不开。
 *   会话工作区里的那一份用**相对路径**读（`workspaceFiles` 按会话 `header.cwd` 解析），
 *   任何机器上都成立，所以客户端优先读它，绝对路径只作开发形态兜底。
 */

export const STUDIO_STATE_FILE = 'state.json'

/** 会话工作区内的状态目录/文件（相对工作区根，客户端就按这个相对路径读）。 */
export const STUDIO_WORKSPACE_DIR = '.dsh-studio'
export const STUDIO_WORKSPACE_STATE = STUDIO_WORKSPACE_DIR + '/' + STUDIO_STATE_FILE

/** 状态文件所在目录：`<home>/.dsh/studio`；传绝对目录可覆盖。 */
export function studioStateDir(home, override) {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim().replace(/[\\/]+$/, '')
  }
  return String(home).replace(/[\\/]+$/, '') + '/.dsh/studio'
}

/**
 * @param {string} home 用户目录（宿主与构建脚本都用 `process.env.DSH_HOME || os.homedir()`）
 * @param {string} [override] 绝对**文件**路径覆盖（来自 `DSH_STUDIO_STATE`）；
 *   以分隔符结尾时按目录处理（用默认文件名），这样两种直觉写法都能用
 * @returns {string} 状态文件的绝对路径（统一用 `/`，Node 在 Windows 上也接受）
 */
export function studioStatePath(home, override) {
  if (typeof override === 'string' && override.trim().length > 0) {
    const value = override.trim()
    const trimmed = value.replace(/[\\/]+$/, '')
    return /[\\/]$/.test(value) ? trimmed + '/' + STUDIO_STATE_FILE : trimmed
  }
  return studioStateDir(home, undefined) + '/' + STUDIO_STATE_FILE
}

/**
 * 某个会话工作区根下的状态文件绝对路径（宿主往这里**也**写一份）。
 * 用户目录那份是权威落点，这份只为"客户端能用相对路径找到它"。
 * @param {string} workspaceRoot 会话的 `header.cwd`（或 sandbox 工作区根）
 * @returns {string} `<workspaceRoot>/.dsh-studio/state.json`（统一用 `/`）
 */
export function studioWorkspaceStatePath(workspaceRoot) {
  return String(workspaceRoot).replace(/[\\/]+$/, '') + '/' + STUDIO_WORKSPACE_STATE
}
