// Recolouring a villager's shirt, hair or skin.
//
// The sprites are pixel art with a hard, very dark outline. A recolour must keep that
// linework and the internal shading, so this works through the existing pixels rather
// than painting over them: anything as dark as the outline is left exactly as authored,
// and the garment/hair tones are remapped onto the chosen hue while keeping their place
// in the palette's light-to-dark order. No pixel changes shape, only colour.

const OUTLINE_CHANNEL = 48; // colours this dark are linework, never recoloured

// Garment pixels are recognised by hue, not by an exact list of colours: every frame of
// the walk cycle shades the shirt and its red trim a little differently, and the bright
// reds plus the pink highlight only appear on some frames. Matching fixed hex values
// therefore left whole patches of the animation unwritten. The shirt body is blue and
// the trim is red; skin and boots are warm but dull, so they fall outside both windows.
const GARMENT = {
  blue: { minHue: 195, maxHue: 265, minSat: 0.15, maxLum: 0.45 },
  red: { minHue: 340, maxHue: 8, minSat: 0.55, minLum: 0.25, maxLum: 0.8 },
};

// How much light-to-dark spread a recoloured palette keeps, and where the chosen
// colour's own lightness is allowed to sit. The artwork is far harsher than this - the
// shirt alone runs from 0.20 to 0.71 - so squeezing the tones into a narrow band is
// what stops highlights and shadows from fighting each other.
const CONTRAST = { shirt: 0.24, hair: 0.28, skin: 0.16 };
const CENTRE = { shirt: [0.30, 0.70], hair: [0.28, 0.72], skin: [0.38, 0.84] };

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

function isOutline(r, g, b) {
  return Math.max(r, g, b) < OUTLINE_CHANNEL;
}

function isGarment(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const deg = h * 360;
  const { blue, red } = GARMENT;

  if (deg >= blue.minHue && deg <= blue.maxHue && s >= blue.minSat && l <= blue.maxLum) {
    return true;
  }
  if (
    (deg >= red.minHue || deg <= red.maxHue) &&
    s >= red.minSat &&
    l >= red.minLum &&
    l <= red.maxLum
  ) {
    return true;
  }
  return false;
}

// Skin is the one palette that also appears in the hair strips, because the head's face
// shows through the hair. Several hair styles are warm oranges and reds that sit right
// next to skin in hue, so skin cannot be classified by colour alone: the body strips are
// scanned first for their face tones and a pixel counts as skin only if it is within a
// few steps of one of those. An orange-haired villager therefore keeps their hair when
// the skin colour changes.
const SKIN_WINDOW = { minHue: 12, maxHue: 35, minSat: 0.35, maxSat: 0.9, minLum: 0.5, maxLum: 0.8 };
const SKIN_MATCH = 12;
const skinAnchors = [];

function inSkinWindow(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const deg = h * 360;
  return (
    deg >= SKIN_WINDOW.minHue &&
    deg <= SKIN_WINDOW.maxHue &&
    s >= SKIN_WINDOW.minSat &&
    s <= SKIN_WINDOW.maxSat &&
    l >= SKIN_WINDOW.minLum &&
    l <= SKIN_WINDOW.maxLum
  );
}

function nearSkin(a, r, g, b) {
  return (
    Math.abs(a[0] - r) <= SKIN_MATCH &&
    Math.abs(a[1] - g) <= SKIN_MATCH &&
    Math.abs(a[2] - b) <= SKIN_MATCH
  );
}

function isSkin(r, g, b) {
  if (skinAnchors.length) return skinAnchors.some((a) => nearSkin(a, r, g, b));
  return inSkinWindow(r, g, b);
}

// Remember the face tones of a body strip. Hair strips reuse them by proximity.
export function registerSkinSource(img) {
  if (!img) return;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (isOutline(r, g, b) || !inSkinWindow(r, g, b)) continue;
    if (skinAnchors.some((a) => nearSkin(a, r, g, b))) continue;
    skinAnchors.push([r, g, b]);
  }
}

// Which pixels of this strip belong to the given palette.
function selected(palette, r, g, b) {
  if (isOutline(r, g, b)) return false;
  if (palette === 'shirt') return isGarment(r, g, b);
  if (palette === 'skin') return isSkin(r, g, b);
  // the hair strip takes hair colour everywhere, so a recoloured hair style has no
  // untouched patches left behind
  return palette === 'hair';
}

// The lightness band the darkest and lightest selected tone land in.
function band(palette, pickLum) {
  const spread = CONTRAST[palette];
  const [lowest, highest] = CENTRE[palette];
  const centre = Math.min(highest, Math.max(lowest, pickLum));
  return [centre - spread / 2, centre + spread / 2];
}

const cache = new WeakMap();

function prepared(img, palette) {
  let entry = cache.get(img);
  if (!entry) {
    entry = new Map();
    cache.set(img, entry);
  }
  if (entry.has(palette)) return entry.get(palette);

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;

  const targets = [];
  let min = 1;
  let max = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (!selected(palette, r, g, b)) continue;
    const l = rgbToHsl(r, g, b)[2];
    targets.push(i);
    if (l < min) min = l;
    if (l > max) max = l;
  }

  const result = { data: px, targets, min, max, width: canvas.width, height: canvas.height };
  entry.set(palette, result);
  return result;
}

// Returns a canvas of the strip with that palette recoloured to `color`
// (pass null/'' for the original artwork).
export function recolour(img, palette, color) {
  if (!img) return null;
  if (!color) return img;
  if (palette !== 'shirt' && palette !== 'hair' && palette !== 'skin') return img;

  const base = prepared(img, palette);
  if (base.targets.length === 0) return img;

  const canvas = document.createElement('canvas');
  canvas.width = base.width;
  canvas.height = base.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const px = new Uint8ClampedArray(base.data);
  const [hue, sat, lum] = rgbToHsl(...hexToRgb(color));
  const [lo, hi] = band(palette, lum);
  const span = base.max - base.min || 1;

  for (const i of base.targets) {
    const l = rgbToHsl(px[i], px[i + 1], px[i + 2])[2];
    const t = (l - base.min) / span;
    const [r, g, b] = hslToRgb(hue, sat, lo + t * (hi - lo));
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    // alpha is untouched, so silhouette and outline pixels are unchanged
  }

  ctx.putImageData(new ImageData(px, canvas.width, canvas.height), 0, 0);
  return canvas;
}
