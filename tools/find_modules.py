"""Locate reusable tile modules (complete houses, road bands, farm plots) inside the
author's room so the new village can be composed from correctly assembled pieces."""
import json, re, os
from PIL import Image

T = 16
COLS = 64
EMPTY = 0x80000000
ROOM = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy'
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'


def load_yy(path):
    raw = open(path, encoding='utf-8').read()
    raw = re.sub(r',(\s*[}\]])', r'\1', raw)
    return json.loads(raw)


def decode(data):
    out, i, n = [], 0, len(data)
    while i < n:
        v = data[i]; i += 1
        if v >= 0:
            out.extend(data[i:i + v]); i += v
        else:
            out.extend([data[i]] * (-v)); i += 1
    return out


room = load_yy(ROOM)
atlas = Image.open(ATLAS).convert('RGBA')
layers = [l for l in room['layers']
          if l['resourceType'] == 'GMRTileLayer' and l.get('tiles', {}).get('TileCompressedData')]
W = max(l['tiles']['SerialiseWidth'] for l in layers)
H = max(l['tiles']['SerialiseHeight'] for l in layers)
grids = {}
for l in layers:
    td = l['tiles']
    grids[l['name']] = (td['SerialiseWidth'], td['SerialiseHeight'], decode(td['TileCompressedData']))

order = [l['name'] for l in layers][::-1]


def idx_of(name, x, y):
    w, h, cells = grids[name]
    if x < 0 or y < 0 or x >= w or y >= h:
        return 0
    return cells[y * w + x] & 0x0fffffff


def occupied(name, x, y):
    return idx_of(name, x, y) != 0


def render(x0, y0, x1, y1, bg=(96, 195, 76, 255), frames=('x', 'y')):
    img = Image.new('RGBA', ((x1 - x0) * T, (y1 - y0) * T), bg)
    for name in order:
        w, h, cells = grids[name]
        for y in range(y0, y1):
            if y < 0 or y >= h:
                continue
            for x in range(x0, x1):
                if x < 0 or x >= w:
                    continue
                v = cells[y * w + x]
                ix = v & 0x0fffffff
                if ix == 0:
                    continue
                fx = v & 0x10000000; fy = v & 0x20000000; dg = v & 0x40000000
                col, row = ix % COLS, ix // COLS
                t = atlas.crop((col * T, row * T, col * T + T, row * T + T))
                if dg: t = t.transpose(Image.TRANSPOSE)
                if fx: t = t.transpose(Image.FLIP_LEFT_RIGHT)
                if fy: t = t.transpose(Image.FLIP_TOP_BOTTOM)
                img.alpha_composite(t, ((x - x0) * T, (y - y0) * T))
    return img


# ---------- buildings ----------
seen = set()
comps = []
for y in range(H):
    for x in range(W):
        if not occupied('building', x, y) or (x, y) in seen:
            continue
        stack = [(x, y)]
        seen.add((x, y))
        cells = []
        while stack:
            cx, cy = stack.pop()
            cells.append((cx, cy))
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in seen and occupied('building', nx, ny):
                    seen.add((nx, ny))
                    stack.append((nx, ny))
        xs = [c[0] for c in cells]; ys = [c[1] for c in cells]
        comps.append((len(cells), min(xs), min(ys), max(xs), max(ys)))

comps.sort(reverse=True)
print('=== building components (tiles, x0, y0, x1, y1, w, h) ===')
for n, x0, y0, x1, y1 in comps[:14]:
    print(f'  tiles={n:4d}  ({x0:2d},{y0:2d})-({x1:2d},{y1:2d})  {x1-x0+1}x{y1-y0+1}')

os.makedirs('artifacts/modules', exist_ok=True)
for i, (n, x0, y0, x1, y1) in enumerate(comps[:6]):
    img = render(x0 - 1, y0 - 1, x1 + 2, y1 + 2)
    img = img.resize((img.width * 3, img.height * 3), Image.NEAREST)
    img.convert('RGB').save(f'artifacts/modules/house_{i}.png')
    print(f'wrote artifacts/modules/house_{i}.png  bbox=({x0-1},{y0-1})..({x1+1},{y1+1})')

# ---------- road bands ----------
print()
print('=== paths: longest horizontal runs per row ===')
for y in range(H):
    best = 0; best_x = 0; cur = 0; cur_x = 0
    for x in range(W):
        if occupied('paths', x, y):
            if cur == 0: cur_x = x
            cur += 1
            if cur > best: best, best_x = cur, cur_x
        else:
            cur = 0
    if best >= 12:
        print(f'  row {y:2d}: len={best:3d} from x={best_x:2d} to x={best_x+best-1:2d}')

print()
print('=== paths: longest vertical runs per column ===')
for x in range(W):
    best = 0; best_y = 0; cur = 0; cur_y = 0
    for y in range(H):
        if occupied('paths', x, y):
            if cur == 0: cur_y = y
            cur += 1
            if cur > best: best, best_y = cur, cur_y
        else:
            cur = 0
    if best >= 10:
        print(f'  col {x:2d}: len={best:3d} from y={best_y:2d} to y={best_y+best-1:2d}')

# ---------- farm / garden window ----------
Image.open('artifacts/room_reverse.png').crop((60, 100, 320, 240)).resize((780, 420), Image.NEAREST).convert('RGB').save('artifacts/modules/farm_area.png')
print('wrote artifacts/modules/farm_area.png')
