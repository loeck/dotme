# Vegetation

Trees, bushes and foreground undergrowth follow the art direction of Voxen's _Last Signal_
(`pine.model.ts`, `undergrowth.model.ts`, `props.toml`, `forest.toml`). They are micro-voxel
models: ellipsoid, cone and limb operations carve a fine grid, which is meshed once with
exposed faces only, classic per-corner voxel occlusion and a small hashed tone per voxel.
The world worker prepares everything (`vegetation-models.ts`, `vegetation-placement.ts`) and
transfers typed arrays; the render thread only wraps them in instanced meshes (`vegetation.ts`).

## Forms

- Spruce: Last Signal's conical form, a core cone and seven boughs per tier, turned by the
  golden angle, drooping 28°, tapering 84% toward the top; 15% of boughs use the pale needle
  colour. One variant uses the darker spruce needles.
- Pine: Last Signal's mature form, a tall trunk turning orange from 55% of the canopy base,
  bark flakes below, and an uneven crown of scaffold lobes around a dense inner mass.
- Birch: a pale trunk with rotated dark marks and forked leaf sprays. Its bark is the main
  value break against the dark conifers.
- Bush: a dozen overlapping clumps; tree companions in about a third of two slots per tree.
- Grass tufts, ferns and small white or yellow flowers on the mossy foreground bank, in 1.6 m
  clumps inside 8 m patches. Blades arc in two segments and dry toward their tips.

Trees cluster into groves with clearings, keep 1.6 m between trunks and grow up to 35% larger
toward the horizon. Birches stay in the mid-ground band.

## Scale and cost

Micro voxels only read where they build forms of a few pixels. Trees use 8 cm voxels on
desktop and 10 cm on phones, about a third of the 25 cm terrain voxel; the undergrowth, a few
metres from the camera, uses 3.5 cm and 4.5 cm. Each model is one instanced draw: at most
fifteen layers. The undergrowth sits on `UNDERGROWTH_LAYER`, which only the main camera
enables, so the water reflection, the environment probe and the shadow pass never draw it.
Trees cast shadows through the shadow layer. Unit tests bound the layer count and triangles.

## Wind

Sway follows Voxen's ADR 0110: one shear per instance that grows with the square of height,
a rest lean with the wind speed and three buffeting sines (rates 0.53, 0.97, 1.61; weights
0.5, 0.3, 0.2) at 1.2/√H Hz. The world wind direction is rotated into each instance's yawed
model space. Reduced motion freezes the time, keeping only the static lean.
