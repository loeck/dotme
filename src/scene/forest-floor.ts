import { CAMERA_REST } from './camera-rig'
import { appendClump } from './grass'
import { WATER_LEVEL } from './lake-bed'
import type { LakeWorld } from './lake-world'
import { sampleHeight, sampleNormal } from './terrain-field'
import type { MeshBuilder } from './vegetation-meshes'
import { mixRgb, mulberry32, VEGETATION_PALETTE as P, WoodBuilder } from './vegetation-models'
import type { Point } from './vegetation-models'

/** Nearby roots follow the actual ground; litter shares the existing wood/undergrowth draws. */
export function appendForestFloor(
  wood: MeshBuilder,
  cover: MeshBuilder,
  world: LakeWorld,
  seed: number,
  mobile: boolean,
  soft: (x: number, z: number) => boolean,
) {
  const random = mulberry32(seed ^ 0x731ab)
  const reach = mobile ? 18 : 30
  const near = (x: number, y: number, z: number) =>
    Math.hypot(x - CAMERA_REST.x, y - CAMERA_REST.y, z - CAMERA_REST.z) < reach
  const ground = (x: number, z: number) => {
    const y = sampleHeight(world.field, x, z)
    return soft(x, z) && y > WATER_LEVEL + 0.06 ? y : null
  }
  const litter = (cx: number, cz: number, radius: number, count: number) => {
    const twigs = new WoodBuilder(0.55)
    for (let leaf = 0; leaf < count; leaf++) {
      const angle = random() * Math.PI * 2
      const out = (0.3 + random() * 0.7) * radius
      const x = cx + Math.cos(angle) * out,
        z = cz + Math.sin(angle) * out
      const y = ground(x, z)
      if (y === null) continue
      const yaw = random() * Math.PI * 2
      const length = 0.055 + random() * 0.065
      const width = length * (0.3 + random() * 0.15)
      const along: Point = [Math.cos(yaw), 0, Math.sin(yaw)]
      const across: Point = [-along[2], 0, along[0]]
      const colour = mixRgb([0.065, 0.044, 0.018], [0.21, 0.125, 0.037], random())
      const normal = sampleNormal(world.field, x, z)
      const vertex = (u: number, v: number, lift: number) => {
        const px = x + along[0] * u + across[0] * v
        const pz = z + along[2] * u + across[2] * v
        const py = ground(px, pz)
        if (py === null || Math.abs(py - y) > 0.08) return null
        return cover.vertex([px, py + 0.008 + lift, pz], normal, colour, [0, 0, 0, 0])
      }
      // A raised midrib and folded edges give each fallen leaf a small, legible silhouette.
      const tip = vertex(length, 0, 0),
        base = vertex(-length * 0.7, 0, 0)
      const left = vertex(0, width, 0),
        right = vertex(0, -width, 0)
      const ridge = vertex(0, 0, 0.012)
      if (tip !== null && base !== null && left !== null && right !== null && ridge !== null) {
        cover.triangle(tip, ridge, left)
        cover.triangle(left, ridge, base)
        cover.triangle(base, ridge, right)
        cover.triangle(right, ridge, tip)
      }
      if (leaf % 6 === 0) {
        const endX = x + along[0] * length * 3,
          endZ = z + along[2] * length * 3
        const endY = ground(endX, endZ)
        if (endY !== null && Math.abs(endY - y) < 0.12)
          twigs.tube(
            [
              [x, y + 0.012, z],
              [endX, endY + 0.008, endZ],
            ],
            [0.009, 0.004],
            3,
            () => P.barkDead,
          )
      }
    }
    wood.appendWood(
      twigs.build(100),
      { x: 0, y: 0, z: 0, yaw: 0, scale: 1 },
      { phase: 0, omega: 0 },
      0,
    )
  }
  for (const tree of world.trees) {
    if (!near(tree.x, tree.y, tree.z)) continue
    const oak = tree.kind === 'oak'
    const broad = oak || tree.kind === 'beech'
    const radius = tree.scale * (oak ? 0.18 : tree.kind === 'beech' ? 0.13 : 0.08)
    const roots = new WoodBuilder(tree.kind === 'birch' ? 0.14 : tree.kind === 'beech' ? 0.22 : 1)
    const colour =
      tree.kind === 'birch' ? P.birchMark : tree.kind === 'beech' ? P.beechBark : P.bark
    const count = broad ? 5 : 4
    for (let root = 0; root < count; root++) {
      const yaw = tree.yaw + (root / count) * Math.PI * 2 + (random() - 0.5) * 0.5
      const length = radius * (4 + random() * 3)
      const curve = (random() - 0.5) * 0.55
      const points: Point[] = []
      const radii: number[] = []
      for (let ring = 0; ring < 6; ring++) {
        const t = ring / 5
        const angle = yaw + Math.sin(t * 2) * curve
        const x = tree.x + Math.cos(angle) * (radius * 0.4 + length * t)
        const z = tree.z + Math.sin(angle) * (radius * 0.4 + length * t)
        const y = ground(x, z)
        const width = radius * 0.62 * (1 - t) ** 1.3 + 0.004
        const acrossX = Math.sin(angle) * width,
          acrossZ = -Math.cos(angle) * width
        if (
          y === null ||
          Math.abs(y - tree.y) > length * 0.35 + 0.15 ||
          ground(x + acrossX, z + acrossZ) === null ||
          ground(x - acrossX, z - acrossZ) === null
        )
          break
        // Shoulders rise into the flared trunk; narrow tips disappear under the soil.
        points.push([x - tree.x, y - tree.y + radius * 0.6 * (1 - t) ** 2 - t * 0.025, z - tree.z])
        radii.push(width)
      }
      if (points.length !== 6) continue
      roots.tube(points, radii, mobile ? 5 : 7, () => colour)
      const tip = points[3]
      if (tip)
        appendClump(
          cover,
          {
            x: tree.x + tip[0] + Math.cos(yaw + 1.5) * 0.13,
            z: tree.z + tip[2] + Math.sin(yaw + 1.5) * 0.13,
            radius: 0.08,
            form: 'wiry',
            height: 0.16,
            dryness: 0.2,
            value: 0.7,
            seeds: false,
            salt: Math.floor(random() * 1e6),
            phase: yaw,
          },
          ground,
          0.35,
          0.006,
        )
    }
    wood.appendWood(roots.build(100), { ...tree, yaw: 0, scale: 1 }, { phase: 0, omega: 0 }, 0)
    litter(tree.x, tree.z, broad ? 1.2 * tree.scale : 0.7 * tree.scale, mobile ? 12 : 28)
  }
  for (const stone of world.boulders) {
    if (!near(stone.x, stone.y, stone.z)) continue
    litter(stone.x, stone.z, Math.max(stone.size[0], stone.size[2]) + 0.45, mobile ? 6 : 14)
  }
}
