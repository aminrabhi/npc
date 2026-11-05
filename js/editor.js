// In-page tile editor.
//
// Lets you repaint the village by hand using only the pack's tiles: paint a tile,
// erase one, lift a tile off the map, or select a rectangle and copy every layer
// of it (so a whole cottage or tree moves as one piece). "Export code" produces a
// compact layout string to hand back for baking into the project.

import { drawTile } from './tiles.js';
import { ROOM_LAYERS } from './interior.js';

const SOLID_LAYERS = ['building', 'walls', 'decoration_01', 'decoration_02', 'decoration_03'];
const SOLID_COVERAGE = 0.5;
const TILE = 16;

// Which atlas cells are solid enough to block walking (same rule as the builder).
function buildSolidTable(img, atlasCols) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const { data } = cx.getImageData(0, 0, c.width, c.height);

  const tileRows = Math.floor(img.height / TILE);
  const total = atlasCols * tileRows;
  const out = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const tx = (i % atlasCols) * TILE;
    const ty = Math.floor(i / atlasCols) * TILE;
    let opaque = 0;
    for (let y = 0; y < TILE; y++) {
      const rowStart = ((ty + y) * c.width + tx) * 4;
      for (let x = 0; x < TILE; x++) {
        if (data[rowStart + x * 4 + 3] > 200) opaque++;
      }
    }
    out[i] = opaque / (TILE * TILE) >= SOLID_COVERAGE ? 1 : 0;
  }
  return out;
}

function rle(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1]++;
    else out.push([v, 1]);
  }
  return out;
}

function layerLabel(name) {
  return name.replace(/_0(\d)/, ' $1').replace(/_/g, ' ');
}

export function createEditor({ canvas, state, atlas, onEditingChanged, onLayoutChanged }) {
  const village = state.village;
  const cols = village.cols;
  const rows = village.rows;
  const T = village.tileSize;
  const atlasCols = village.atlasCols;

  const solidTable = buildSolidTable(atlas, atlasCols);

  if (!village.rooms) village.rooms = [];
  // Manual collision marks: 0 follows the atlas, 1 forces a block, 2 forces walkable.
  if (!village.manual) village.manual = new Int8Array(village.blocked.length);

  let open = false;
  let tool = 'paint';
  let brush = 0;
  let layerIdx = Math.max(0, village.layers.findIndex((l) => l.name === 'decoration_02'));
  let clipboard = null;
  let clipboardName = '';
  let brushBlock = { w: 1, h: 1, cells: Int32Array.of(0) };
  let brushAnchor = null;
  let mode = 'map';
  let collideValue = 1;
  // Collision boxes can cover a whole tile or only half of it, so a narrow chair
  // blocks just the side it stands on and villagers can slip past the other side.
  let collideBox = 0; // 0 full, 1 left half, 2 right half
  let activeRoom = null;
  let roomLayer = 'floor';
  let roomCollideValue = 1;
  let roomDrag = null;
  let selection = null;
  let dragging = null;
  let painting = false;
  let lastPaint = null;
  let hover = null;
  const undoStack = [];

  // ---------------------------------------------------------------- drawing
  let worldCtx = null;
  function wctx() {
    if (!worldCtx) worldCtx = state.worldCanvas.getContext('2d');
    return worldCtx;
  }

  // ---- doors and rooms -----------------------------------------------------
  // A door is a single map tile; its room is a rectangle of map tiles holding the
  // hand-drawn interior. The room art only shows while this door view is on, or
  // while a villager has stepped through the door.
  function roomByDoor(x, y) {
    return village.rooms.find((r) => r.door.x === x && r.door.y === y);
  }

  function newRoom(x, y) {
    const room = { door: { x, y }, x, y, w: 0, h: 0, canvas: null, blocked: new Int32Array(0) };
    for (const name of ROOM_LAYERS) room[name] = new Int32Array(0);
    village.rooms.push(room);
    return room;
  }

  function insideRoom(room, x, y) {
    return room.w > 0 && x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
  }

  // Resize a room, keeping whatever was already drawn where the rectangles overlap.
  function setRoomArea(room, x, y, w, h) {
    const next = { blocked: new Int32Array(w * h) };
    for (const name of ROOM_LAYERS) next[name] = new Int32Array(w * h);
    for (let ty = 0; ty < room.h; ty++) {
      for (let tx = 0; tx < room.w; tx++) {
        const gx = room.x + tx;
        const gy = room.y + ty;
        if (gx < x || gy < y || gx >= x + w || gy >= y + h) continue;
        for (const name of ROOM_LAYERS) {
          next[name][(gy - y) * w + (gx - x)] = room[name][ty * room.w + tx];
        }
        next.blocked[(gy - y) * w + (gx - x)] = room.blocked ? room.blocked[ty * room.w + tx] : 0;
      }
    }
    room.x = x;
    room.y = y;
    room.w = w;
    room.h = h;
    for (const name of ROOM_LAYERS) room[name] = next[name];
    room.blocked = next.blocked;
    room.canvas = null;
    // a room's footprint is solid ground: move the mask now, not on the next reload
    if (village.rebuildSolid) village.rebuildSolid();
    syncRoomBoxes();
  }

  // Furniture inside a room can be made solid, so a villager walks around a bed
  // instead of through it. The value is the box itself: 0 open, 1 whole tile,
  // 2 left half, 3 right half. The doorway tile always stays open, otherwise the
  // room could never be entered or left.
  function setRoomCollision(x, y, value) {
    const room = activeRoom;
    if (!room || !room.blocked || !insideRoom(room, x, y)) return false;
    if (x === room.door.x && y === room.door.y) return false;
    room.blocked[(y - room.y) * room.w + (x - room.x)] = value;
    return true;
  }

  function roomBlockedValue(room, x, y) {
    if (!room || !room.blocked || !insideRoom(room, x, y)) return 0;
    return room.blocked[(y - room.y) * room.w + (x - room.x)];
  }

  function roomBlockedAt(room, x, y) {
    return roomBlockedValue(room, x, y) !== 0;
  }

  // A box painted on the map inside a house also has to exist in the room's own mask:
  // indoors the room art covers those map tiles, and that mask is what villagers read.
  function syncRoomBoxes() {
    for (const room of village.rooms) {
      if (!room.blocked || room.w <= 0 || room.h <= 0) continue;
      for (let y = room.y; y < room.y + room.h; y++) {
        for (let x = room.x; x < room.x + room.w; x++) {
          if (x === room.door.x && y === room.door.y) continue;
          const mark = village.manual[y * cols + x];
          if (mark !== 1 && mark !== 3 && mark !== 4) continue;
          room.blocked[(y - room.y) * room.w + (x - room.x)]
            = mark === 1 ? 1 : mark === 3 ? 2 : 3;
        }
      }
    }
  }

  function paintRoom(x, y, value) {
    const room = activeRoom;
    if (!room || !insideRoom(room, x, y)) return false;
    room[roomLayer][(y - room.y) * room.w + (x - room.x)] = value;
    room.canvas = null;
    return true;
  }

  function stampRoom(x, y, erase) {
    if (!onStampGrid(x, y)) return;
    const b = brushBlock;
    for (let dy = 0; dy < b.h; dy++) {
      for (let dx = 0; dx < b.w; dx++) {
        paintRoom(x + dx, y + dy, erase ? 0 : b.cells[dy * b.w + dx]);
      }
    }
  }

  function redrawCell(x, y) {
    const c = wctx();
    c.clearRect(x * T, y * T, T, T);
    for (const layer of village.layers) {
      drawTile(c, atlas, layer.cells[y * cols + x], x * T, y * T, T, atlasCols);
    }
  }

  function redrawAll() {
    const c = wctx();
    c.clearRect(0, 0, village.width, village.height);
    for (const layer of village.layers) {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          drawTile(c, atlas, layer.cells[y * cols + x], x * T, y * T, T, atlasCols);
        }
      }
    }
  }

  function snapshot() {
    const rooms = village.rooms.map((r) => {
      const copy = { door: { ...r.door }, x: r.x, y: r.y, w: r.w, h: r.h };
      for (const name of ROOM_LAYERS) copy[name] = r[name].slice();
      copy.blocked = r.blocked ? r.blocked.slice() : new Int32Array(r.w * r.h);
      return copy;
    });
    undoStack.push({ layers: village.layers.map((l) => l.cells.slice()), rooms });
    if (undoStack.length > 40) undoStack.shift();
  }

  function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    snap.layers.forEach((cells, i) => village.layers[i].cells.set(cells));
    village.rooms.length = 0;
    for (const room of snap.rooms) {
      const restored = {
        door: { ...room.door },
        x: room.x, y: room.y, w: room.w, h: room.h,
        canvas: null,
        blocked: room.blocked ? room.blocked.slice() : new Int32Array(room.w * room.h),
      };
      for (const name of ROOM_LAYERS) restored[name] = room[name].slice();
      village.rooms.push(restored);
    }
    activeRoom = null;
    redrawAll();
  }

  // ---------------------------------------------------------------- editing
  function setCell(x, y, value) {
    const layer = village.layers[layerIdx];
    layer.cells[y * cols + x] = value;
    redrawCell(x, y);
  }

  function setSingleBrush(value) {
    brush = value;
    brushBlock = { w: 1, h: 1, cells: Int32Array.of(value) };
  }

  // A multi-tile selection is stamped whole. Stamps land on a grid measured from
  // where the stroke started, so the block never overwrites itself mid-drag.
  function onStampGrid(x, y) {
    const b = brushBlock;
    if (b.w === 1 && b.h === 1) return true;
    const ax = brushAnchor ? brushAnchor.x : x;
    const ay = brushAnchor ? brushAnchor.y : y;
    if (((x - ax) % b.w + b.w) % b.w !== 0) return false;
    if (((y - ay) % b.h + b.h) % b.h !== 0) return false;
    return true;
  }

  function paintAt(x, y) {
    if (!onStampGrid(x, y)) return;
    const b = brushBlock;
    for (let dy = 0; dy < b.h; dy++) {
      for (let dx = 0; dx < b.w; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
        const value = b.cells[dy * b.w + dx];
        if (currentLayer().cells[ty * cols + tx] !== value) setCell(tx, ty, value);
      }
    }
  }

  function eraseAt(x, y) {
    if (currentLayer().cells[y * cols + x] !== 0) setCell(x, y, 0);
  }

  function currentLayer() {
    return village.layers[layerIdx];
  }

  function copySelection() {
    if (!selection) return;
    const items = [];
    const { x: sx, y: sy, w, h } = selection;
    village.layers.forEach((layer, li) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = layer.cells[(sy + y) * cols + (sx + x)];
          if (v !== 0) items.push([li, x, y, v]);
        }
      }
    });
    clipboard = { w, h, items };
    clipboardName = `Copied ${w}x${h}`;
    tool = 'stamp';
    syncUI();
  }

  function eraseArea() {
    if (!selection) return;
    const { x: sx, y: sy, w, h } = selection;
    snapshot();
    for (const layer of village.layers) {
      // ground stays put: erasing a cottage should leave grass, not a hole
      if (layer.name === 'land') continue;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const tx = sx + x;
          const ty = sy + y;
          if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
          layer.cells[ty * cols + tx] = 0;
          redrawCell(tx, ty);
        }
      }
    }
  }

  function stampAt(x, y) {
    if (!clipboard) return;
    snapshot();
    for (const [li, dx, dy, v] of clipboard.items) {
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
      village.layers[li].cells[ty * cols + tx] = v;
      redrawCell(tx, ty);
    }
  }

  // ------------------------------------------------------------ walkability
  function recomputeBlocked() {
    const index = {};
    village.layers.forEach((l) => { index[l.name] = l; });
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        let solid = 0;
        for (const name of SOLID_LAYERS) {
          const layer = index[name];
          if (!layer) continue;
          const v = layer.cells[i];
          const ix = v & 0x0fffffff;
          if (ix && solidTable[ix]) { solid = 1; break; }
        }
        const forced = village.manual[i];
        village.blocked[i] = forced === 2 ? 0
          : forced === 1 ? 1
            : forced === 3 ? 2
              : forced === 4 ? 3
                : solid;
      }
    }
    // keep walking in step with the mask that was just rebuilt
    if (village.rebuildSolid) village.rebuildSolid();
    syncRoomBoxes();
  }

  // Collision is a debug brush: marks override the automatic solid-tile pass, so a
  // borderline wall can be made passable (or a plain field cell made solid) by hand.
  // The mark is manual's own scale: 1 full box, 2 force open, 3 left half, 4 right half.
  function setCollision(x, y, value) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    const i = y * cols + x;
    village.manual[i] = value;
    village.blocked[i] = value === 2 ? 0 : value === 1 ? 1 : value === 3 ? 2 : 3;
    if (village.rebuildSolid) village.rebuildSolid();
    syncRoomBoxes();
  }

  // The box size picked in the toolbar, as a manual mark.
  function boxMark() {
    return collideBox === 0 ? 1 : collideBox === 1 ? 3 : 4;
  }

  // Indoors the box size is the stored value itself.
  function roomBoxMark() {
    return collideBox === 0 ? 1 : collideBox === 1 ? 2 : 3;
  }

  function clearCollisions() {
    village.manual.fill(2);
    recomputeBlocked();
  }

  function exportCode() {
    recomputeBlocked();
    const layers = {};
    for (const layer of village.layers) layers[layer.name] = rle(layer.cells);

    const rooms = village.rooms
      .filter((r) => r.w > 0 && r.h > 0)
      .map((r) => {
        const out = { door: [r.door.x, r.door.y], x: r.x, y: r.y, w: r.w, h: r.h };
        for (const name of ROOM_LAYERS) out[name] = rle(r[name]);
        out.blocked = rle(r.blocked || new Int32Array(r.w * r.h));
        return out;
      });

    return JSON.stringify({
      v: 1,
      tileSize: T,
      cols,
      rows,
      atlasCols,
      layers,
      blocked: rle(village.blocked),
      manual: rle(village.manual),
      rooms,
    });
  }

  // ------------------------------------------------------------------- DOM
  const toggle = document.createElement('button');
  toggle.id = 'edit-toggle';
  toggle.type = 'button';
  toggle.textContent = 'Edit tiles';
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.id = 'editor';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ed-head" id="ed-head">
      <span class="ed-title">Tile editor</span>
      <span class="ed-drag-hint">drag to move</span>
    </div>
    <div class="ed-row ed-tools">
      <button type="button" class="ed-btn is-on" data-mode="map">Map</button>
      <button type="button" class="ed-btn" data-mode="rooms">Doors</button>
      <button type="button" class="ed-btn" data-mode="collide">Collide</button>
      <span class="ed-gap"></span>
      <button type="button" class="ed-btn is-on" data-tool="paint">Paint</button>
      <button type="button" class="ed-btn" data-tool="erase">Erase</button>
      <button type="button" class="ed-btn" data-tool="pick">Pick</button>
      <button type="button" class="ed-btn" data-tool="select" data-map-only>Select</button>
      <button type="button" class="ed-btn" data-tool="door" data-rooms-only hidden>Place door</button>
      <button type="button" class="ed-btn" data-tool="area" data-rooms-only hidden>Room area</button>
      <button type="button" class="ed-btn" data-tool="room-collide" data-rooms-only hidden>Block</button>
      <button type="button" class="ed-btn" id="ed-clear-blocked">Clear collisions</button>
      <button type="button" class="ed-btn is-on" data-box="0" hidden>Full box</button>
      <button type="button" class="ed-btn" data-box="1" hidden>Half L</button>
      <button type="button" class="ed-btn" data-box="2" hidden>Half R</button>
      <span class="ed-gap"></span>
      <button type="button" class="ed-btn" id="ed-undo">Undo</button>
      <button type="button" class="ed-btn" id="ed-reset">Revert</button>
      <button type="button" class="ed-btn ed-primary" id="ed-export">Export code</button>
      <button type="button" class="ed-btn" id="ed-close">Done</button>
    </div>
    <div class="ed-row ed-layers-row">
      <span class="ed-label">Layer</span>
      <div class="ed-layers" id="ed-layers"></div>
    </div>
    <div class="ed-row"><span class="ed-hint" id="ed-hint"></span></div>
    <div class="ed-row ed-atlas-tools">
      <span class="ed-label">Tileset</span>
      <button type="button" class="ed-btn" id="ed-zoom-out">-</button>
      <span class="ed-zoom" id="ed-zoom">2x</span>
      <button type="button" class="ed-btn" id="ed-zoom-in">+</button>
    </div>
    <div class="ed-row ed-main">
      <div class="ed-atlas-box"><canvas id="ed-atlas" width="1024" height="1024"></canvas></div>
      <div class="ed-side">
        <canvas id="ed-swatch" width="64" height="64"></canvas>
        <div class="ed-index" id="ed-index">#0</div>
        <button type="button" class="ed-btn" id="ed-copy" disabled>Copy area</button>
        <button type="button" class="ed-btn" id="ed-erase-area" disabled>Erase area</button>
        <div class="ed-note" id="ed-note"></div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const layerBar = panel.querySelector('#ed-layers');
  const head = panel.querySelector('#ed-head');
  const atlasCanvas = panel.querySelector('#ed-atlas');
  const swatch = panel.querySelector('#ed-swatch');
  const indexLabel = panel.querySelector('#ed-index');
  const hint = panel.querySelector('#ed-hint');
  const note = panel.querySelector('#ed-note');
  const copyBtn = panel.querySelector('#ed-copy');
  const eraseAreaBtn = panel.querySelector('#ed-erase-area');

  function rebuildLayerButtons() {
    layerBar.innerHTML = '';
    if (mode === 'rooms') {
      for (const name of [...ROOM_LAYERS].reverse()) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ed-btn ed-layer-btn';
        btn.dataset.rlayer = name;
        btn.textContent = layerLabel(name);
        btn.addEventListener('click', () => { roomLayer = name; syncUI(); });
        layerBar.appendChild(btn);
      }
      return;
    }
    village.layers
      .map((layer, i) => ({ layer, i }))
      .reverse()
      .forEach(({ layer, i }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ed-btn ed-layer-btn';
        btn.dataset.layer = String(i);
        btn.textContent = layerLabel(layer.name);
        btn.addEventListener('click', () => { layerIdx = i; syncUI(); });
        layerBar.appendChild(btn);
      });
  }
  rebuildLayerButtons();

  const actx = atlasCanvas.getContext('2d');
  actx.imageSmoothingEnabled = false;
  actx.drawImage(atlas, 0, 0);

  const ZOOMS = [1, 2, 3, 4];
  let zoomStep = 1;
  const zoomLabel = panel.querySelector('#ed-zoom');

  function applyZoom() {
    const z = ZOOMS[zoomStep];
    atlasCanvas.style.width = `${atlasCanvas.width * z}px`;
    atlasCanvas.style.height = `${atlasCanvas.height * z}px`;
    zoomLabel.textContent = `${z}x`;
  }

  panel.querySelector('#ed-zoom-in').addEventListener('click', () => {
    zoomStep = Math.min(ZOOMS.length - 1, zoomStep + 1);
    applyZoom();
  });
  panel.querySelector('#ed-zoom-out').addEventListener('click', () => {
    zoomStep = Math.max(0, zoomStep - 1);
    applyZoom();
  });
  applyZoom();

  function syncUI() {
    const roomMode = mode === 'rooms';
    panel.querySelectorAll('[data-tool]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.tool === tool);
      b.hidden = b.hasAttribute('data-rooms-only')
        ? !roomMode
        : roomMode && b.hasAttribute('data-map-only');
    });
    layerBar.querySelectorAll('[data-layer]').forEach((b) => {
      b.classList.toggle('is-on', Number(b.dataset.layer) === layerIdx);
    });
    layerBar.querySelectorAll('[data-rlayer]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.rlayer === roomLayer);
    });
    panel.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.mode === mode);
    });
    // The box-size choice only means anything while collision is being painted.
    const boxActive = mode === 'collide' || (mode === 'rooms' && tool === 'room-collide');
    panel.querySelectorAll('[data-box]').forEach((b) => {
      b.hidden = !boxActive;
      b.classList.toggle('is-on', Number(b.dataset.box) === collideBox);
    });
    copyBtn.disabled = !selection;
    eraseAreaBtn.disabled = !selection;
    note.textContent = clipboard
      ? `${clipboardName || `Copied ${clipboard.w}x${clipboard.h}`} - click to place.`
      : selection
        ? 'Now press Copy area.'
        : '';
    hint.textContent = mode === 'collide'
      ? 'Click tiles to toggle collision - pick Full box, Half L or Half R for the size.'
      : mode === 'rooms'
      ? !activeRoom
        ? 'Click Place door, then click a tile to put a doorway on the map.'
        : tool === 'door'
          ? `Door at ${activeRoom.door.x},${activeRoom.door.y} - click another tile for a second door.`
          : tool === 'area'
            ? 'Drag on the map to set where this door opens into.'
            : tool === 'room-collide'
              ? 'Click furniture to block it - Full box, Half L or Half R; villagers walk around red.'
              : activeRoom.w > 0
              ? `Drawing ${roomLayer}s in the room at ${activeRoom.x},${activeRoom.y}.`
              : 'Press Room area and drag to place this interior.'
      : tool === 'paint'
      ? 'Pick a tile (drag in the tileset for a block), then drag on the map.'
      : tool === 'erase'
        ? 'Drag to clear tiles on this layer.'
        : tool === 'pick'
          ? 'Click the map to load that tile into the brush.'
          : tool === 'select'
            ? 'Drag a box, then Copy area.'
            : 'Click to place the copied piece.';
  }

  function syncBrush() {
    const b = brushBlock;
    const sctx = swatch.getContext('2d');
    sctx.clearRect(0, 0, 64, 64);
    sctx.imageSmoothingEnabled = false;
    const size = Math.max(1, Math.floor(64 / Math.max(b.w, b.h)));
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const ix = b.cells[y * b.w + x] & 0x0fffffff;
        if (!ix) continue;
        const sx = (ix % atlasCols) * T;
        const sy = Math.floor(ix / atlasCols) * T;
        sctx.drawImage(atlas, sx, sy, T, T, x * size, y * size, size, size);
      }
    }
    indexLabel.textContent = b.w === 1 && b.h === 1 ? `#${b.cells[0] & 0x0fffffff}` : `${b.w}x${b.h}`;
  }

  // -------------------------------------------------------------- pointers
  function tileAt(ev) {
    const r = canvas.getBoundingClientRect();
    const wx = (ev.clientX - r.left - state.offset.x) / state.scale;
    const wy = (ev.clientY - r.top - state.offset.y) / state.scale;
    const x = Math.floor(wx / T);
    const y = Math.floor(wy / T);
    if (x < 0 || y < 0 || x >= cols || y >= rows) return null;
    return { x, y };
  }

  function onDown(ev) {
    if (!open) return;
    const t = tileAt(ev);
    if (!t) return;
    ev.preventDefault();

    if (mode === 'collide') {
      painting = true;
      lastPaint = t;
      const mark = boxMark();
      collideValue = village.manual[t.y * cols + t.x] === mark ? 2 : mark;
      setCollision(t.x, t.y, collideValue);
      return;
    }

    if (mode === 'rooms') {
      const hit = roomByDoor(t.x, t.y);
      if (hit) activeRoom = hit;

      if (tool === 'door') {
        if (hit) { syncUI(); return; }
        snapshot();
        activeRoom = newRoom(t.x, t.y);
        syncUI();
        return;
      }

      if (!activeRoom) {
        note.textContent = 'Click Place door and put a doorway down first.';
        return;
      }

      if (tool === 'area') {
        snapshot();
        roomDrag = { ax: t.x, ay: t.y, x: t.x, y: t.y, w: 1, h: 1 };
        return;
      }

      if (!insideRoom(activeRoom, t.x, t.y)) {
        note.textContent = 'Draw inside the room area - use Room area to place it.';
        return;
      }

      if (tool === 'room-collide') {
        painting = true;
        lastPaint = t;
        const mark = roomBoxMark();
        roomCollideValue = roomBlockedValue(activeRoom, t.x, t.y) === mark ? 0 : mark;
        setRoomCollision(t.x, t.y, roomCollideValue);
        return;
      }

      if (tool === 'pick') {
        setSingleBrush(activeRoom[roomLayer][(t.y - activeRoom.y) * activeRoom.w + (t.x - activeRoom.x)]);
        syncBrush();
        return;
      }

      snapshot();
      painting = true;
      lastPaint = t;
      brushAnchor = { x: t.x, y: t.y };
      stampRoom(t.x, t.y, tool === 'erase');
      return;
    }

    if (tool === 'paint') {
      snapshot();
      painting = true;
      lastPaint = t;
      brushAnchor = { x: t.x, y: t.y };
      paintAt(t.x, t.y);
    } else if (tool === 'erase') {
      snapshot();
      painting = true;
      lastPaint = t;
      brushAnchor = { x: t.x, y: t.y };
      eraseAt(t.x, t.y);
    } else if (tool === 'pick') {
      setSingleBrush(currentLayer().cells[t.y * cols + t.x]);
      syncBrush();
    } else if (tool === 'select') {
      dragging = { x: t.x, y: t.y, w: 1, h: 1 };
      selection = null;
      syncUI();
    } else if (tool === 'stamp') {
      stampAt(t.x, t.y);
    }
  }

  function line(a, b) {
    // Bresenham so fast drags leave no gaps.
    let x0 = a.x, y0 = a.y;
    const x1 = b.x, y1 = b.y;
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      paintAt(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function onMove(ev) {
    if (!open) return;
    const t = tileAt(ev);
    hover = t;
    if (painting && t && lastPaint) {
      if (mode === 'collide') {
        const from = lastPaint;
        const steps = Math.max(1, Math.max(Math.abs(t.x - from.x), Math.abs(t.y - from.y)));
        for (let i = 1; i <= steps; i++) {
          setCollision(
            Math.round(from.x + ((t.x - from.x) * i) / steps),
            Math.round(from.y + ((t.y - from.y) * i) / steps),
            collideValue,
          );
        }
      } else if (mode === 'rooms') {
        const from = lastPaint;
        const steps = Math.max(1, Math.max(Math.abs(t.x - from.x), Math.abs(t.y - from.y)));
        for (let i = 1; i <= steps; i++) {
          const sx = Math.round(from.x + ((t.x - from.x) * i) / steps);
          const sy = Math.round(from.y + ((t.y - from.y) * i) / steps);
          if (tool === 'room-collide') setRoomCollision(sx, sy, roomCollideValue);
          else stampRoom(sx, sy, tool === 'erase');
        }
      } else if (tool === 'erase') {
        eraseAt(t.x, t.y);
      } else {
        line(lastPaint, t);
      }
      lastPaint = t;
    } else if (dragging && t) {
      dragging = {
        x: Math.min(dragging.x, t.x),
        y: Math.min(dragging.y, t.y),
        w: Math.abs(t.x - dragging.x) + 1,
        h: Math.abs(t.y - dragging.y) + 1,
      };
    } else if (roomDrag && t) {
      const { ax, ay } = roomDrag;
      roomDrag = {
        ax, ay,
        x: Math.min(ax, t.x),
        y: Math.min(ay, t.y),
        w: Math.abs(t.x - ax) + 1,
        h: Math.abs(t.y - ay) + 1,
      };
    }
  }

  function onUp() {
    if (!open) return;
    if (painting) {
      painting = false;
      lastPaint = null;
      brushAnchor = null;
      return;
    }
    if (dragging) {
      selection = dragging.w > 0 && dragging.h > 0 ? dragging : null;
      dragging = null;
      syncUI();
      return;
    }
    if (roomDrag) {
      const r = roomDrag;
      roomDrag = null;
      if (activeRoom) setRoomArea(activeRoom, r.x, r.y, r.w, r.h);
      syncUI();
    }
  }

  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', () => { hover = null; });

  // ------------------------------------------------------ draggable panel
  // Grab the title bar to slide the panel anywhere; it stays where you leave it.
  let panelDrag = null;

  head.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.bottom = 'auto';
    panelDrag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    head.setPointerCapture(ev.pointerId);
    head.classList.add('is-dragging');
    ev.preventDefault();
  });

  head.addEventListener('pointermove', (ev) => {
    if (!panelDrag) return;
    const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
    const x = Math.min(Math.max(0, ev.clientX - panelDrag.dx), maxX);
    const y = Math.min(Math.max(0, ev.clientY - panelDrag.dy), maxY);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });

  function endPanelDrag(ev) {
    if (!panelDrag) return;
    panelDrag = null;
    head.classList.remove('is-dragging');
    if (head.hasPointerCapture(ev.pointerId)) head.releasePointerCapture(ev.pointerId);
  }

  head.addEventListener('pointerup', endPanelDrag);
  head.addEventListener('pointercancel', endPanelDrag);

  // ------------------------------------------------------------------ UI
  panel.querySelectorAll('[data-tool]').forEach((b) => {
    b.addEventListener('click', () => { tool = b.dataset.tool; syncUI(); });
  });

  panel.querySelectorAll('[data-box]').forEach((b) => {
    b.addEventListener('click', () => { collideBox = Number(b.dataset.box); syncUI(); });
  });

  function setMode(next) {
    mode = next;
    if (mode === 'rooms') {
      state.showRooms = true;
      tool = 'door';
      if (!activeRoom && village.rooms.length) activeRoom = village.rooms[0];
    } else {
      state.showRooms = false;
      activeRoom = null;
      roomDrag = null;
      if (tool === 'door' || tool === 'area' || tool === 'room-collide') tool = 'paint';
    }
    rebuildLayerButtons();
    syncUI();
  }

  panel.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });

  panel.querySelector('#ed-undo').addEventListener('click', undo);
  panel.querySelector('#ed-clear-blocked').addEventListener('click', clearCollisions);
  panel.querySelector('#ed-copy').addEventListener('click', copySelection);
  eraseAreaBtn.addEventListener('click', eraseArea);
  copyBtn.textContent = 'Copy area';

  panel.querySelector('#ed-reset').addEventListener('click', async () => {
    if (!window.confirm('Reload the layout from data/village.json and drop your edits?')) return;
    const res = await fetch('data/village.json', { cache: 'no-cache' });
    const raw = await res.json();
    raw.layers.forEach((layer) => {
      const target = village.layers.find((l) => l.name === layer.name);
      if (!target) return;
      let i = 0;
      for (const [value, count] of layer.runs) {
        for (let k = 0; k < count && i < target.cells.length; k++) target.cells[i++] = value;
      }
    });
    recomputeBlocked();
    redrawAll();
    undoStack.length = 0;
  });

  let atlasDrag = null;

  function atlasTile(ev) {
    const r = atlasCanvas.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * atlasCanvas.width;
    const sy = ((ev.clientY - r.top) / r.height) * atlasCanvas.height;
    const col = Math.floor(sx / T);
    const row = Math.floor(sy / T);
    if (col < 0 || row < 0 || col >= atlasCols) return null;
    if (row >= Math.floor(atlasCanvas.height / T)) return null;
    return { col, row };
  }

  function setBlock(c0, r0, c1, r1) {
    const x0 = Math.min(c0, c1);
    const x1 = Math.max(c0, c1);
    const y0 = Math.min(r0, r1);
    const y1 = Math.max(r0, r1);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const cells = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) cells[y * w + x] = (y0 + y) * atlasCols + (x0 + x);
    }
    brushBlock = { w, h, cells };
    brush = cells[0];
    tool = 'paint';
    syncBrush();
    syncUI();
  }

  atlasCanvas.addEventListener('pointerdown', (ev) => {
    const t = atlasTile(ev);
    if (!t) return;
    ev.preventDefault();
    atlasDrag = { c0: t.col, r0: t.row };
    setBlock(t.col, t.row, t.col, t.row);
    atlasCanvas.setPointerCapture(ev.pointerId);
  });

  atlasCanvas.addEventListener('pointermove', (ev) => {
    if (!atlasDrag) return;
    const t = atlasTile(ev);
    if (!t) return;
    setBlock(atlasDrag.c0, atlasDrag.r0, t.col, t.row);
  });

  function endAtlasDrag(ev) {
    if (!atlasDrag) return;
    atlasDrag = null;
    if (atlasCanvas.hasPointerCapture(ev.pointerId)) atlasCanvas.releasePointerCapture(ev.pointerId);
  }
  atlasCanvas.addEventListener('pointerup', endAtlasDrag);
  atlasCanvas.addEventListener('pointercancel', endAtlasDrag);

  // export modal
  const modal = document.createElement('div');
  modal.id = 'ed-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="ed-modal-box">
      <h2>Layout code</h2>
      <p>Copy this and paste it back in chat — it gets baked into the village.</p>
      <textarea readonly spellcheck="false"></textarea>
      <div class="ed-modal-actions">
        <button type="button" class="ed-btn ed-primary" id="ed-copy-code">Copy</button>
        <button type="button" class="ed-btn" id="ed-modal-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const codeArea = modal.querySelector('textarea');
  const copyCodeBtn = modal.querySelector('#ed-copy-code');

  function showExport() {
    codeArea.value = exportCode();
    modal.hidden = false;
    codeArea.focus();
    codeArea.select();
    return codeArea.value;
  }

  panel.querySelector('#ed-export').addEventListener('click', showExport);

  copyCodeBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeArea.value);
      copyCodeBtn.textContent = 'Copied';
      setTimeout(() => { copyCodeBtn.textContent = 'Copy'; }, 1200);
    } catch {
      codeArea.select();
    }
  });

  modal.querySelector('#ed-modal-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.hidden = true; });

  // ---------------------------------------------------------------- export
  function overlay(ctx) {
    if (!open) return;
    const lw = 1 / Math.max(1, state.scale);
    ctx.save();

    // In collision mode the blocked cells are painted red so the mask is visible.
    if (mode === 'collide') {
      ctx.fillStyle = 'rgba(216, 32, 32, 0.72)';
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const box = village.blocked[y * cols + x];
          if (!box) continue;
          if (box === 2) ctx.fillRect(x * T, y * T, T / 2, T);
          else if (box === 3) ctx.fillRect(x * T + T / 2, y * T, T / 2, T);
          else ctx.fillRect(x * T, y * T, T, T);
        }
      }
    }

    // In the door view every doorway is marked and every room outlined, so you can
    // see where each interior lives before painting it. Solid furniture inside a
    // room is tinted red, the same as the outdoor collision mask.
    if (mode === 'rooms') {
      ctx.fillStyle = 'rgba(216, 32, 32, 0.72)';
      for (const room of village.rooms) {
        if (!room.blocked || room.w <= 0 || room.h <= 0) continue;
        for (let ty = 0; ty < room.h; ty++) {
          for (let tx = 0; tx < room.w; tx++) {
            const box = room.blocked[ty * room.w + tx];
            if (!box) continue;
            const bx = (room.x + tx) * T;
            const by = (room.y + ty) * T;
            if (box === 2) ctx.fillRect(bx, by, T / 2, T);
            else if (box === 3) ctx.fillRect(bx + T / 2, by, T / 2, T);
            else ctx.fillRect(bx, by, T, T);
          }
        }
      }
      for (const room of village.rooms) {
        if (room.w > 0 && room.h > 0) {
          ctx.strokeStyle = room === activeRoom
            ? 'rgba(120, 220, 255, 0.95)'
            : 'rgba(120, 220, 255, 0.4)';
          ctx.lineWidth = lw;
          ctx.strokeRect(room.x * T + lw / 2, room.y * T + lw / 2, room.w * T - lw, room.h * T - lw);
        }
        ctx.fillStyle = room === activeRoom
          ? 'rgba(255, 120, 255, 0.95)'
          : 'rgba(255, 120, 255, 0.55)';
        ctx.fillRect(room.door.x * T + T * 0.25, room.door.y * T + T * 0.25, T * 0.5, T * 0.5);
      }
      if (roomDrag) {
        ctx.strokeStyle = 'rgba(255, 214, 102, 0.95)';
        ctx.lineWidth = lw;
        ctx.setLineDash([lw * 4, lw * 3]);
        ctx.strokeRect(roomDrag.x * T, roomDrag.y * T, roomDrag.w * T, roomDrag.h * T);
        ctx.setLineDash([]);
      }
    }

    const rect = dragging || selection;
    if (rect) {
      ctx.strokeStyle = 'rgba(255, 214, 102, 0.95)';
      ctx.lineWidth = lw;
      ctx.setLineDash([lw * 4, lw * 3]);
      ctx.strokeRect(rect.x * T + lw / 2, rect.y * T + lw / 2, rect.w * T - lw, rect.h * T - lw);
      ctx.setLineDash([]);
    }

    if (hover) {
      if (tool === 'stamp' && clipboard) {
        ctx.strokeStyle = 'rgba(120, 220, 255, 0.95)';
        ctx.lineWidth = lw;
        ctx.strokeRect(hover.x * T, hover.y * T, clipboard.w * T, clipboard.h * T);
      } else if (tool !== 'select') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = lw;
        const bw = Math.max(T, brushBlock.w * T);
        const bh = Math.max(T, brushBlock.h * T);
        ctx.strokeRect(hover.x * T + lw / 2, hover.y * T + lw / 2, bw - lw, bh - lw);
      }
    }

    ctx.restore();
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !next;
    toggle.textContent = next ? 'Close editor' : 'Edit tiles';
    state.overlay = next ? overlay : null;
    if (next) {
      state.showRooms = mode === 'rooms';
      syncUI();
      syncBrush();
    } else {
      hover = null;
      state.showRooms = false;
      roomDrag = null;
      recomputeBlocked();
      if (onLayoutChanged) onLayoutChanged();
    }
    if (onEditingChanged) onEditingChanged(next);
  }

  toggle.addEventListener('click', () => setOpen(!open));

  window.addEventListener('keydown', (ev) => {
    if (!open) return;
    if (ev.key === 'Escape') {
      if (!modal.hidden) { modal.hidden = true; return; }
      if (tool === 'stamp') { tool = selection ? 'select' : 'paint'; syncUI(); return; }
      setOpen(false);
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      undo();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c' && selection) {
      ev.preventDefault();
      copySelection();
    }
  });

  syncUI();
  syncBrush();

  return {
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    exportCode,
    showExport,
    undo,
    select: (x, y, w, h) => { selection = { x, y, w, h }; syncUI(); },
    copySelection,
    eraseArea,
    stampAt,
    setTool: (name) => { tool = name; syncUI(); },
    setBrush: (value) => { setSingleBrush(value); syncBrush(); },
    setBrushBlock: (w, h, cells) => { brushBlock = { w, h, cells: Int32Array.from(cells) }; brush = brushBlock.cells[0]; syncBrush(); },
    setLayer: (name) => {
      const i = village.layers.findIndex((l) => l.name === name);
      if (i >= 0) { layerIdx = i; syncUI(); }
    },
    recomputeBlocked,
    redrawAll,
    setCollision: (x, y, value) => setCollision(x, y, value),
    clearCollisions,
    isBlocked: (x, y) => village.blocked[y * cols + x] === 1,
    setMode,
    showRooms: (on) => { state.showRooms = !!on; },
    rooms: () => village.rooms.map((r) => ({
      door: [r.door.x, r.door.y],
      x: r.x, y: r.y, w: r.w, h: r.h,
      drawn: ROOM_LAYERS.reduce(
        (n, name) => n + r[name].reduce((m, v) => m + (v ? 1 : 0), 0), 0),
    })),
    setRoomLayer: (name) => {
      if (!ROOM_LAYERS.includes(name)) return;
      roomLayer = name;
      syncUI();
    },
    addDoor: (x, y) => {
      snapshot();
      activeRoom = roomByDoor(x, y) || newRoom(x, y);
      syncUI();
      return [activeRoom.door.x, activeRoom.door.y];
    },
    setRoomArea: (x, y, w, h) => {
      if (!activeRoom) return false;
      snapshot();
      setRoomArea(activeRoom, x, y, w, h);
      syncUI();
      return true;
    },
    activeRoom: () => activeRoom,
    setRoomCollision: (x, y, value) => setRoomCollision(x, y, value),
    roomBlockedAt: (x, y) => roomBlockedAt(activeRoom, x, y),
    roomBlockedValue: (x, y) => roomBlockedValue(activeRoom, x, y),
    setCollideBox: (value) => { collideBox = value; syncUI(); },
    collideBox: () => collideBox,
  };
}
