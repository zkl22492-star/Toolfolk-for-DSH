import * as THREE from 'three'

export function createStudioLighting(scene) {
  const ambient = new THREE.HemisphereLight(0xfff3e0, 0x969b91, 1.15)
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.9)
  sun.position.set(-4, 10, 5)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 35 })
  sun.shadow.normalBias = 0.025
  const fill = new THREE.DirectionalLight(0xdfe8f0, 0.5)
  fill.position.set(3, 6, -4)
  const lamps = [[-3.7, -2], [0, -2], [3.4, -2], [-3.7, 2], [0, 2.8], [3.5, 2]].map(([x, z]) => {
    const light = new THREE.SpotLight(0xffd6a0, 0, 12, Math.PI / 3, 1, 2)
    light.position.set(x, 4.5, z)
    light.target.position.set(x, 0, z)
    scene.add(light, light.target)
    return light
  })
  scene.add(ambient, sun, fill)
  scene.add(sun.target)
  return {
    setTarget(center) {
      sun.target.position.copy(center)
      sun.target.updateMatrixWorld()
    },
    setDark(dark) {
      ambient.intensity = dark ? 0.36 : 1.15
      ambient.color.setHex(dark ? 0xd4d9e5 : 0xfff3e0)
      ambient.groundColor.setHex(dark ? 0x535650 : 0x969b91)
      sun.intensity = dark ? 0.28 : 1.9
      fill.intensity = dark ? 0.16 : 0.5
      for (const lamp of lamps) lamp.intensity = dark ? 22 : 0
      scene.traverse((node) => {
        if (node.material?.name === 'window' && node.material?.color) {
          const art = node.material.userData.studioWindow
          if (art) node.material.map = dark ? art.night : art.day
          node.material.color.setHex(art ? 0xffffff : dark ? 0x35435e : 0xffffff)
        }
      })
    },
  }
}

/** Publish the resolved theme as CSS custom properties on one element. */
export function applyStudioThemeVars(element, dark) {
  element.style.setProperty('--studio-surface', dark ? 'rgba(35,36,35,.94)' : 'rgba(255,255,255,.94)')
  element.style.setProperty('--studio-text', dark ? '#deded6' : '#4f5947')
  element.style.setProperty('--studio-muted', dark ? '#a5aaa2' : '#747d6f')
  element.style.setProperty('--studio-border', dark ? '#454740' : '#deded3')
  // 房间底色：canvas 是透明的（scene.background=null），所以看到的其实是这层底色。
  // 深色主题下如果还是奶油白，整块工作室就会在暗色 UI 里"切"出来一块——必须一起换。
  element.style.setProperty('--studio-backdrop', dark ? '#191b18' : '#f0ede6')
  element.style.setProperty('--studio-accent', dark ? '#8ba07c' : '#a8b79c')
  // 错误态：深色下用低饱和暗红，避免一块刺眼的粉
  element.style.setProperty('--studio-error-bg', dark ? 'rgba(90,45,45,.55)' : '#fbeaea')
  element.style.setProperty('--studio-error-border', dark ? '#7d4a4a' : '#d9a3a3')
  element.style.setProperty('--studio-error-text', dark ? '#e0a9a9' : '#8a3b3b')
  // 纸片底色（汇报记录里的每一条）：之前引用了这个变量却没定义 → 深色主题下会变成亮白块
  element.style.setProperty('--studio-bg-sheet', dark ? 'rgba(48,50,45,.97)' : 'rgba(253,250,243,.97)')
}

/** Read the host's resolved theme straight from the DOM field ui-theme writes. */
export function studioThemeIsDark() {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/**
 * Follow the host's resolved theme, including changes made while the view is open.
 * `lighting` is optional: pass it where the scene exists, omit it when only the
 * CSS variables are wanted.
 */
export function observeStudioTheme(element, lighting) {
  const update = () => {
    const dark = studioThemeIsDark()
    lighting?.setDark?.(dark)
    applyStudioThemeVars(element, dark)
  }
  update()
  const observer = new MutationObserver(update)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => observer.disconnect()
}

/**
 * Publish the theme variables on `documentElement` **once, at plugin activation**.
 *
 * Why the root instead of the view element: the opening curtain is on screen while the GLB is
 * still being read and parsed — at that moment `mountStudio` has not run yet, so variables set
 * there did not exist and the curtain fell back to its light-theme value: "一开始还是白色"
 * (user-reported, dark theme). Publishing on the root makes every element of ours correct from
 * the first paint, regardless of mount order.
 * @returns disposer; the client keeps this for the plugin's lifetime (one observer + 9 properties).
 */
export function installStudioThemeRoot() {
  const update = () => applyStudioThemeVars(document.documentElement, studioThemeIsDark())
  update()
  const observer = new MutationObserver(update)
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => observer.disconnect()
}
