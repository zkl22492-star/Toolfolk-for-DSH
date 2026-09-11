import * as THREE from 'three'

/** The room opens toward -X/+Z; the +X wall must stay behind the furniture. */
export function frameStudioCamera(camera, box, width, height) {
  const center = box.getCenter(new THREE.Vector3())
  const radius = box.getSize(new THREE.Vector3()).length() / 2
  const elevation = THREE.MathUtils.degToRad(34)
  const azimuth = THREE.MathUtils.degToRad(-38)
  const direction = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  )
  camera.position.copy(center).addScaledVector(direction, radius * 3)
  camera.lookAt(center)
  camera.updateMatrixWorld(true)
  const projected = new THREE.Box3()
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z])
        projected.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse))
  const aspect = Math.max(width, 1) / Math.max(height, 1)
  const halfHeight = Math.max(projected.max.y - projected.min.y,
    (projected.max.x - projected.min.x) / aspect) * 0.55
  const cx = (projected.min.x + projected.max.x) / 2
  const cy = (projected.min.y + projected.max.y) / 2
  camera.left = cx - halfHeight * aspect
  camera.right = cx + halfHeight * aspect
  camera.bottom = cy - halfHeight
  camera.top = cy + halfHeight
  camera.near = 0.1
  camera.far = Math.max(radius * 8, 100)
  camera.updateProjectionMatrix()
}
