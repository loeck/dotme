import { required } from '../invariant'

type MergedBox = {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

const MERGE_EPS = 1e-4
// Normalize -0 so both sides of the origin share merge keys.
const quantize = (value: number) => Math.round(value / MERGE_EPS) + 0

function spans(box: MergedBox, axis: 0 | 1 | 2) {
  const cross =
    axis === 0
      ? [box.y0, box.y1, box.z0, box.z1]
      : axis === 1
        ? [box.x0, box.x1, box.z0, box.z1]
        : [box.x0, box.x1, box.y0, box.y1]
  return {
    key: cross.map(quantize).join(','),
    start: axis === 0 ? box.x0 : axis === 1 ? box.y0 : box.z0,
    end: axis === 0 ? box.x1 : axis === 1 ? box.y1 : box.z1,
  }
}

function mergeAlong(entries: MergedBox[], axis: 0 | 1 | 2): MergedBox[] {
  // String order only needs equal keys adjacent; starts order within each run.
  const keyed = entries
    .map((box) => ({ box, ...spans(box, axis) }))
    .toSorted((a, b) => (a.key === b.key ? a.start - b.start : a.key < b.key ? -1 : 1))
  const merged: MergedBox[] = []
  let key = ''
  let end = 0
  for (const entry of keyed) {
    const current = merged[merged.length - 1]
    if (current && entry.key === key && entry.start <= end + MERGE_EPS) {
      end = Math.max(end, entry.end)
      if (axis === 0) current.x1 = end
      else if (axis === 1) current.y1 = end
      else current.z1 = end
    } else {
      key = entry.key
      end = entry.end
      merged.push({ ...entry.box })
    }
  }
  return merged
}

/** Greedy exact merge of axis-aligned boxes into few solid cuboids. */
export function mergeStaticBoxes(boxes: Float64Array): Float64Array {
  let entries: MergedBox[] = []
  for (let i = 0; i + 5 < boxes.length; i += 6) {
    entries.push({
      x0: required(boxes[i]),
      y0: required(boxes[i + 1]),
      z0: required(boxes[i + 2]),
      x1: required(boxes[i + 3]),
      y1: required(boxes[i + 4]),
      z1: required(boxes[i + 5]),
    })
  }
  for (const axis of [0, 2, 1] as const) entries = mergeAlong(entries, axis)
  const merged = new Float64Array(entries.length * 6)
  entries.forEach((box, i) => {
    merged.set([box.x0, box.y0, box.z0, box.x1, box.y1, box.z1], i * 6)
  })
  return merged
}
