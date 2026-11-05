// Breadth-first path search over the walkable tile grid.

export function findPath(village, start, goal, opts = {}) {
  const { cols, rows } = village;
  const maxNodes = opts.maxNodes || 6000;
  const avoid = opts.avoid || null; // tiles to route around unless one is the goal
  if (village.isSolid(goal.x, goal.y)) return null;

  const total = cols * rows;
  const prev = new Int32Array(total).fill(-1);
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);

  const startIdx = start.y * cols + start.x;
  const goalIdx = goal.y * cols + goal.x;
  if (village.isSolid(start.x, start.y)) return null;

  let head = 0;
  let tail = 0;
  queue[tail++] = startIdx;
  seen[startIdx] = 1;
  let visited = 0;

  while (head < tail) {
    const cur = queue[head++];
    if (cur === goalIdx) break;
    if (++visited > maxNodes) return null;

    const cx = cur % cols;
    const cy = (cur - cx) / cols;

    for (let d = 0; d < 4; d++) {
      const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nIdx = ny * cols + nx;
      if (seen[nIdx] || village.isSolid(nx, ny)) continue;
      if (avoid && nIdx !== goalIdx && avoid.has(nIdx)) continue;
      // A half-width box fills its half for the whole height of the tile, so it is
      // no way through: villagers route around it and stand in its open half instead.
      if (nIdx !== goalIdx && village.blockedValue(nx, ny) !== 0) continue;
      seen[nIdx] = 1;
      prev[nIdx] = cur;
      queue[tail++] = nIdx;
    }
  }

  if (!seen[goalIdx]) return null;

  const path = [];
  let cur = goalIdx;
  while (cur !== startIdx && cur !== -1) {
    const x = cur % cols;
    path.push({ x, y: (cur - x) / cols });
    cur = prev[cur];
  }
  path.reverse();
  return path;
}

// Where a villager stands to step through a door: the door tile itself when it can
// be walked on, otherwise the first open tile beside it (a door in a wall).
export function doorApproach(village, door) {
  if (village.blockedValue(door.x, door.y) === 0) return { x: door.x, y: door.y };
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const x = door.x + dx;
    const y = door.y + dy;
    if (village.blockedValue(x, y) === 0) return { x, y };
  }
  return null;
}

// Flood fill to find the biggest connected walkable region; villagers spawn there.
export function largestRegion(village) {
  const { cols, rows } = village;
  const total = cols * rows;
  const region = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  let bestId = -1;
  let bestSize = 0;
  let id = 0;

  for (let seed = 0; seed < total; seed++) {
    if (village.isSolid(seed % cols, (seed - (seed % cols)) / cols) || region[seed] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    region[seed] = id;
    let size = 0;

    while (head < tail) {
      const cur = queue[head++];
      size++;
      const cx = cur % cols;
      const cy = (cur - cx) / cols;
      for (let d = 0; d < 4; d++) {
        const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nIdx = ny * cols + nx;
        if (village.isSolid(nx, ny) || region[nIdx] !== -1) continue;
        region[nIdx] = id;
        queue[tail++] = nIdx;
      }
    }

    if (size > bestSize) {
      bestSize = size;
      bestId = id;
    }
    id++;
  }

  return { region, bestId, bestSize };
}
