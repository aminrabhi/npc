"""Pick complete pieces to build the neighbourhood.

Houses: connected components of the example room's building layer, rendered with
structure layers only (no flowers or props).

Trees: connected components of opaque tiles in the tileset atlas itself, which
guarantees each object is whole rather than clipped by a bounding box.
"""
import json, re, os
from PIL import Image, ImageDraw

T = 16
COLS = 64
ROOM = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy'
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'


def load_yy(p):
    raw = open(p, encoding='utf-8').read()
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', raw))


def decode(d):
    out, i, n = [], 0, len(d)
    while i < n:
        v = d[i]; i += 1
        if v >= 0: out.extend(d[i:i+v]); i += v
        else: out.extend([d[i]]*(-v)); i += 1
    return out


atlas = Image.open(ATLAS).convert('RGBA')
room = load_yy(ROOM)
src = {}
for l in room['layers']:
    if l['resourceType'] == 'GMRTileLayer' and l.get('tiles', {}).get('TileCompressedData'):
        td = l['tiles']
        src[l['name']] = (td['SerialiseWidth'], td['SerialiseHeight'], decode(td['TileCompressedData']))

# ---------------- houses ----------------
sw, sh, cells = src['building']
seen = set()
houses = []
for y in range(sh):
    for x in range(sw):
        if (x, y) in seen or (cells[y*sw + x] & 0x0fffffff) == 0:
            continue
        stack = [(x, y)]; seen.add((x, y)); n = 0
        xs, ys = [], []
        while stack:
            cx, cy = stack.pop(); n += 1; xs.append(cx); ys.append(cy)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx+dx, cy+dy
                if 0 <= nx < sw and 0 <= ny < sh and (nx, ny) not in seen and (cells[ny*sw + nx] & 0x0fffffff):
                    seen.add((nx, ny)); stack.append((nx, ny))
        houses.append((n, min(xs), min(ys), max(xs), max(ys)))
houses.sort(reverse=True)


def render_from(layers, x0, y0, w, h, bg=(99, 199, 77, 255)):
    img = Image.new('RGBA', (w*T, h*T), bg)
    for name in layers:
        lw, lh, lc = src[name]
        for y in range(y0, y0+h):
            for x in range(x0, x0+w):
                if x >= lw or y >= lh:
                    continue
                v = lc[y*lw + x]
                ix = v & 0x0fffffff
                if ix == 0:
                    continue
                col, row = ix % COLS, ix // COLS
                t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
                if v & 0x40000000: t = t.transpose(Image.TRANSPOSE)
                if v & 0x10000000: t = t.transpose(Image.FLIP_LEFT_RIGHT)
                if v & 0x20000000: t = t.transpose(Image.FLIP_TOP_BOTTOM)
                img.alpha_composite(t, ((x-x0)*T, (y-y0)*T))
    return img


S = 4
picked = [h for h in houses if 4 <= h[3]-h[1]+1 <= 11 and 4 <= h[4]-h[2]+1 <= 9][:12]
cellw = 12 * T * S
cellh = 10 * T * S + 18
cols_n = 3
rows_n = (len(picked) + cols_n - 1) // cols_n
mont = Image.new('RGBA', (cols_n*cellw, rows_n*cellh), (20, 20, 28, 255))
d = ImageDraw.Draw(mont)
for i, (n, x0, y0, x1, y1) in enumerate(picked):
    w, h = x1-x0+1, y1-y0+1
    img = render_from(['building', 'walls'], x0, y0, w, h).resize((w*T*S, h*T*S), Image.NEAREST)
    cx = (i % cols_n) * cellw
    cy = (i // cols_n) * cellh
    mont.alpha_composite(img, (cx, cy))
    d.text((cx+4, cy+cellh-14), f'{i}: ({x0},{y0}) {w}x{h}', fill=(255, 255, 255, 255))
mont.convert('RGB').save('artifacts/cat/house_picks.png')
print('house candidates:', [f'{i}:({x},{y},{x1-x+1}x{y1-y+1})' for i, (n, x, y, x1, y1) in enumerate(picked)])

# ---------------- trees from the atlas ----------------
AW, AH = atlas.width // T, atlas.height // T
opaque = [[False] * AW for _ in range(AH)]
for ay in range(AH):
    for ax in range(AW):
        t = atlas.crop((ax*T, ay*T, ax*T+T, ay*T+T))
        opaque[ay][ax] = any(p[3] > 40 for p in t.get_flattened_data())


def tile_rgb(ax, ay):
    t = atlas.crop((ax*T, ay*T, ax*T+T, ay*T+T))
    px = [p for p in t.get_flattened_data() if p[3] > 200]
    if not px:
        return None
    return (sum(p[0] for p in px)//len(px), sum(p[1] for p in px)//len(px), sum(p[2] for p in px)//len(px))


seen = set()
comps = []
for ay in range(AH):
    for ax in range(AW):
        if (ax, ay) in seen or not opaque[ay][ax]:
            continue
        stack = [(ax, ay)]; seen.add((ax, ay)); tiles = []
        while stack:
            cx, cy = stack.pop(); tiles.append((cx, cy))
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx+dx, cy+dy
                if 0 <= nx < AW and 0 <= ny < AH and (nx, ny) not in seen and opaque[ny][nx]:
                    seen.add((nx, ny)); stack.append((nx, ny))
        xs = [t[0] for t in tiles]; ys = [t[1] for t in tiles]
        comps.append((len(tiles), min(xs), min(ys), max(xs), max(ys), tiles))

tree_cands = []
for n, x0, y0, x1, y1, tiles in comps:
    w, h = x1-x0+1, y1-y0+1
    if not (2 <= w <= 5 and 3 <= h <= 7) or n < 4:
        continue
    rgbs = [tile_rgb(ax, ay) for ax, ay in tiles]
    rgbs = [c for c in rgbs if c]
    if not rgbs:
        continue
    r = sum(c[0] for c in rgbs)/len(rgbs)
    g = sum(c[1] for c in rgbs)/len(rgbs)
    b = sum(c[2] for c in rgbs)/len(rgbs)
    if g > r + 15 and g > 70:
        tree_cands.append((n, x0, y0, w, h))
tree_cands.sort(key=lambda c: -c[0])
tree_cands = tree_cands[:12]

cellw = 7 * T * S
cellh = 8 * T * S + 18
cols_n = 4
rows_n = (len(tree_cands) + cols_n - 1) // cols_n
mont = Image.new('RGBA', (cols_n*cellw, rows_n*cellh), (20, 20, 28, 255))
d = ImageDraw.Draw(mont)
for i, (n, x0, y0, w, h) in enumerate(tree_cands):
    crop = atlas.crop((x0*T, y0*T, (x0+w)*T, (y0+h)*T)).resize((w*T*S, h*T*S), Image.NEAREST)
    bg = Image.new('RGBA', crop.size, (99, 199, 77, 255))
    bg.alpha_composite(crop)
    cx = (i % cols_n) * cellw
    cy = (i // cols_n) * cellh
    mont.alpha_composite(bg, (cx, cy))
    d.text((cx+4, cy+cellh-14), f'{i}: ({x0},{y0}) {w}x{h}', fill=(255, 255, 255, 255))
mont.convert('RGB').save('artifacts/cat/tree_picks.png')
print('tree candidates:', [f'{i}:({c[1]},{c[2]},{c[3]}x{c[4]})' for i, c in enumerate(tree_cands)])
