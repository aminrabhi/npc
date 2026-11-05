// Tile rendering. Values keep the GameMaker encoding exported from the room:
// low 28 bits = atlas index, bits 28/29/30 = flip / mirror / diagonal flags.

const FLIP_X = 0x10000000;
const FLIP_Y = 0x20000000;
const DIAGONAL = 0x40000000;

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function flipMatrix(t) {
  return [-1, 0, 0, 1, t, 0];
}

function mirrorMatrix(t) {
  return [1, 0, 0, -1, 0, t];
}

export function drawTile(ctx, atlas, value, dx, dy, tileSize, atlasCols) {
  const index = value & 0x0fffffff;
  if (index === 0) return; // atlas cell 0 is the empty tile

  const sx = (index % atlasCols) * tileSize;
  const sy = Math.floor(index / atlasCols) * tileSize;

  const fx = value & FLIP_X;
  const fy = value & FLIP_Y;
  const dg = value & DIAGONAL;

  if (!fx && !fy && !dg) {
    ctx.drawImage(atlas, sx, sy, tileSize, tileSize, dx, dy, tileSize, tileSize);
    return;
  }

  // Compose as mirrorY(mirrorX(transpose(tile))), matching how the room data
  // was decoded when the reference render was produced.
  let m = IDENTITY;
  if (dg) m = multiply([0, 1, 1, 0, 0, 0], m); // transpose
  if (fx) m = multiply(flipMatrix(tileSize), m);
  if (fy) m = multiply(mirrorMatrix(tileSize), m);

  ctx.save();
  ctx.translate(dx, dy);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(atlas, sx, sy, tileSize, tileSize, 0, 0, tileSize, tileSize);
  ctx.restore();
}

// Composites every layer, bottom to top, into one offscreen canvas.
export function buildWorldCanvas(village, atlas) {
  const T = village.tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = village.width;
  canvas.height = village.height;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  for (const layer of village.layers) {
    for (let y = 0; y < layer.h; y++) {
      const row = y * layer.w;
      for (let x = 0; x < layer.w; x++) {
        drawTile(ctx, atlas, layer.cells[row + x], x * T, y * T, T, village.atlasCols);
      }
    }
  }
  return canvas;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image ${src}`));
    img.src = src;
  });
}

// Body and hair are separate strips drawn onto the same 96x64 cell grid, so
// compositing them cell-for-cell attaches the hair to the head exactly as authored.
export function composeLayers(body, hair) {
  const canvas = document.createElement('canvas');
  canvas.width = body.width;
  canvas.height = body.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(body, 0, 0);
  ctx.drawImage(hair, 0, 0);
  return canvas;
}
