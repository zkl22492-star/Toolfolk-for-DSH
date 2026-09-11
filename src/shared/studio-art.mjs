import * as THREE from 'three'

export const ART_FILES = { day: 'window-day.png', night: 'window-night.png', chibi: 'chibi.png', motto: 'motto.png' }

export async function loadStudioArt(readUrl) {
  const textures = {}
  try {
    await Promise.all(Object.entries(ART_FILES).map(async ([key, file]) => {
      const texture = await new THREE.TextureLoader().loadAsync(await readUrl(file))
      texture.colorSpace = THREE.SRGBColorSpace
      textures[key] = texture
    }))
    return textures
  } catch (error) {
    for (const texture of Object.values(textures)) texture.dispose()
    throw error
  }
}

export function installStudioArt(model, textures) {
  if (!textures.day) return
  model.traverse(node => {
    if (node.material?.name !== 'window') return
    textures.day.flipY = true
    textures.night.flipY = true
    node.material.map?.dispose()
    node.material.map = textures.day
    node.material.userData.studioWindow = { day: textures.day, night: textures.night }
    node.material.color.setHex(0xffffff)
    node.material.needsUpdate = true
  })
  const group = new THREE.Group()
  group.name = 'StudioPosters'
  model.add(group)
  // Slightly uneven heights, sizes and angles keep this a lived-in pinboard wall.
  for (const [key, z, y, width, angle] of [
    ['chibi', -2.7, 2.1, 0.94, -0.09],
    ['motto', -0.9, 2.25, 1.14, 0.05],
    ['chibi', 0.75, 2.12, 0.79, 0.12],
  ]) {
    const poster = new THREE.Group()
    poster.position.set(5.825, y, z)
    poster.rotation.set(0, -Math.PI / 2, 0)
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 4 / 3), new THREE.MeshStandardMaterial({ map: textures[key], roughness: 1, side: THREE.DoubleSide }))
    paper.rotation.z = angle
    poster.add(paper)
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.10), new THREE.MeshStandardMaterial({ color: 0xd9c99a, roughness: 1, side: THREE.DoubleSide }))
    tape.position.set(-0.08, width * 2 / 3, 0.012)
    tape.rotation.z = -angle * 1.7
    poster.add(tape)
    group.add(poster)
  }
}
