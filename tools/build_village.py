"""Build the neighbourhood: a single street with six cottages facing it and a ring
of whole trees around the perimeter. Everything is authored art from the pack.

Writes data/village.json plus preview images.
"""
import json, re, os, sys
from PIL import Image

T = 16
COLS = 64
GRASS = 66
WORLD_W, WORLD_H = 47, 28
STREET_Y = 14

# --blank leaves an empty grass field to draw on in the in-page editor.
BLANK = '--blank' in sys.argv

ROOM = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy'
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'

LAYERS = ['land', 'paths', 'shadows', 'decoration_01', 'building', 'walls',
          'decoration_02', 'decoration_03']
SOLID_LAYERS = ['building', 'walls', 'decoration_01', 'decoration_02', 'decoration_03']
SOLID_COVERAGE = 0.5

# ---- the street: straight brown stretch of the author's road, mirrored ----
ROAD_RUN = (23, 31, 14, 3)

# ---- cottages ----
# These two designs were checked visually as complete stamps (roof, walls, door,
# windows, foundations). One design is used three times on each side of the street.
DESIGN_BLUE = (38, 22, 12, 9)
DESIGN_PURPLE = (12, 25, 7, 8)
# structure only: no shadow blobs, no flower boxes or props dragged in
HOUSE_LAYERS = ['building', 'walls', 'decoration_03']

HOUSES = [
    (DESIGN_BLUE, 4, 4), (DESIGN_PURPLE, 20, 4), (DESIGN_BLUE, 33, 4),
    (DESIGN_PURPLE, 8, 17), (DESIGN_BLUE, 18, 17), (DESIGN_PURPLE, 35, 17),
]

# ---- ring of trees around the perimeter ----
TREE_RING = [
    (1, 1), (8, 1), (15, 1), (22, 1), (29, 1), (36, 1), (43, 1),
    (0, 9), (45, 8), (0, 19), (45, 20),
    (2, 25), (9, 25), (16, 25), (23, 25), (30, 25), (37, 25), (44, 25),
]


def load_yy(p):
    raw = open(p, encoding='utf-8').read()
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', raw))


def decode(d):
    out, i, n = [], 0, len(d)
    while i < n:
        v = d[i]; i += 1
        if v >= 0: out.extend(d[i:i + v]); i += v
        else: out.extend([d[i]] * (-v)); i += 1
    return out


def rle(cells):
    out = []
    for c in cells:
        if out and out[-1][0] == c:
            out[-1][1] += 1
        else:
            out.append([c, 1])
    return out


atlas = Image.open(ATLAS).convert('RGBA')
room = load_yy(ROOM)
src = {}
for l in room['layers']:
    if l['resourceType'] == 'GMRTileLayer' and l.get('tiles', {}).get('TileCompressedData'):
        td = l['tiles']
        src[l['name']] = (td['SerialiseWidth'], td['SerialiseHeight'],
                          decode(td['TileCompressedData']))

grid = {name: [0] * (WORLD_W * WORLD_H) for name in LAYERS}
grid['land'] = [GRASS] * (WORLD_W * WORLD_H)


def stamp(rect, dx, dy, layers, flip=False):
    rx, ry, rw, rh = rect
    for name in layers:
        if name not in src:
            continue
        sw, sh, cells = src[name]
        for y in range(rh):
            sy = ry + y
            if sy < 0 or sy >= sh:
                continue
            for x in range(rw):
                sx = rx + (rw - 1 - x if flip else x)
                if sx < 0 or sx >= sw:
                    continue
                tx, ty = dx + x, dy + y
                if not (0 <= tx < WORLD_W and 0 <= ty < WORLD_H):
                    continue
                v = cells[sy * sw + sx]
                if flip and (v & 0x0fffffff) != 0:
                    v ^= 0x10000000
                grid[name][ty * WORLD_W + tx] = v


# Everything except the grass field is skipped in blank mode.
if not BLANK:
    # street
    rx, ry, rw, rh = ROAD_RUN
    dx = 0
    while dx < WORLD_W:
        stamp(ROAD_RUN, dx, STREET_Y, ['paths'], flip=(dx // rw) % 2 == 1)
        dx += rw

    # cottages
    for rect, hx, hy in HOUSES:
        stamp(rect, hx, hy, HOUSE_LAYERS)


# ---- whole trees from the example room ----
def detect_trees():
    cov_cache, rgb_cache = {}, {}

    def coverage(v):
        ix = v & 0x0fffffff
        if ix == 0:
            return 0.0
        if ix in cov_cache:
            return cov_cache[ix]
        col, row = ix % COLS, ix // COLS
        t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
        px = [p for p in t.get_flattened_data() if p[3] > 200]
        cov_cache[ix] = len(px) / (T*T)
        return cov_cache[ix]

    def mean_rgb(v):
        ix = v & 0x0fffffff
        if ix in rgb_cache:
            return rgb_cache[ix]
        col, row = ix % COLS, ix // COLS
        t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
        px = [p for p in t.get_flattened_data() if p[3] > 200]
        rgb_cache[ix] = None if not px else (
            sum(p[0] for p in px)//len(px), sum(p[1] for p in px)//len(px), sum(p[2] for p in px)//len(px))
        return rgb_cache[ix]

    names = ['decoration_01', 'decoration_02', 'decoration_03']

    def dense(x, y):
        for name in names:
            sw, sh, cells = src[name]
            if x < sw and y < sh and coverage(cells[y*sw + x]) >= 0.35:
                return True
        return False

    def strongly_red(x, y):
        tot = [0, 0, 0]; n = 0
        for name in names:
            sw, sh, cells = src[name]
            if x >= sw or y >= sh:
                continue
            v = cells[y*sw + x]
            if (v & 0x0fffffff) == 0 or coverage(v) < 0.35:
                continue
            c = mean_rgb(v)
            if c:
                tot[0] += c[0]; tot[1] += c[1]; tot[2] += c[2]; n += 1
        if not n:
            return False
        return (tot[0]/n) > (tot[1]/n) + 45

    def greenish(x, y):
        tot = [0, 0, 0]; n = 0
        for name in names:
            sw, sh, cells = src[name]
            if x >= sw or y >= sh:
                continue
            v = cells[y*sw + x]
            if (v & 0x0fffffff) == 0 or coverage(v) < 0.35:
                continue
            c = mean_rgb(v)
            if c:
                tot[0] += c[0]; tot[1] += c[1]; tot[2] += c[2]; n += 1
        if not n:
            return False
        return (tot[1]/n) > (tot[0]/n) + 20 and (tot[1]/n) > 80

    sw, sh, _ = src['land']
    seen = set()
    out = []
    for y in range(sh):
        for x in range(sw):
            if (x, y) in seen or not dense(x, y):
                continue
            stack = [(x, y)]; seen.add((x, y)); cells = []
            while stack:
                cx, cy = stack.pop(); cells.append((cx, cy))
                for dxx, dyy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dxx, cy + dyy
                    if 0 <= nx < sw and 0 <= ny < sh and (nx, ny) not in seen and dense(nx, ny):
                        seen.add((nx, ny)); stack.append((nx, ny))
            xs = [c[0] for c in cells]; ys = [c[1] for c in cells]
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            w, h = x1 - x0 + 1, y1 - y0 + 1
            if not (2 <= w <= 4 and 2 <= h <= 5 and len(cells) >= 4):
                continue
            green_cells = {c for c in cells if greenish(*c)}
            if len(green_cells) < len(cells) * 0.55:
                continue
            # Keep the canopy plus the trunk beneath it, and drop brightly red cells
            # (the cart and mushrooms that touch the tree). Trunk brown is only
            # mildly red, so it survives the redness test.
            keep = set(green_cells)
            for (cx, cy) in green_cells:
                if (cx, cy + 1) in cells:
                    keep.add((cx, cy + 1))
            keep = {c for c in keep if not strongly_red(*c)}
            if len(keep) < 4:
                continue
            out.append((x0, y0, w, h, frozenset(keep)))
    out.sort(key=lambda r: -r[2] * r[3])
    return out


def stamp_cells(rect, cellset, dx, dy, layers):
    """Copy only the given cells of a rectangle, so a stamp carries the object alone."""
    rx, ry, _, _ = rect
    for name in layers:
        sw, sh, cells = src[name]
        for (cx, cy) in cellset:
            if cx >= sw or cy >= sh:
                continue
            tx, ty = dx + (cx - rx), dy + (cy - ry)
            if 0 <= tx < WORLD_W and 0 <= ty < WORLD_H:
                grid[name][ty * WORLD_W + tx] = cells[cy * sw + cx]


# The detected 3x3 clusters read as [bush][conifer][cart] across with a mushroom
# underneath. Taking the middle column isolates the conifer on its own.
if BLANK:
    print('blank canvas: grass only')
else:
    trees = detect_trees()
    DECO = ['decoration_01', 'decoration_02', 'decoration_03']
    print('tree rects:', [t[:4] for t in trees])
    for i, (px, py) in enumerate(TREE_RING):
        t = trees[i % len(trees)]
        stamp_cells(t[:4], t[4], px, py, DECO)

# ---- walkability ----
stat_cache = {}
def tile_stat(val):
    ix = val & 0x0fffffff
    if ix in stat_cache:
        return stat_cache[ix]
    col, row = ix % COLS, ix // COLS
    t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
    px = [p for p in t.get_flattened_data() if p[3] > 200]
    res = (0.0, None) if not px else (
        len(px) / (T*T),
        (sum(p[0] for p in px)//len(px), sum(p[1] for p in px)//len(px), sum(p[2] for p in px)//len(px)))
    stat_cache[ix] = res
    return res


blocked = []
counts = {'walkable': 0, 'object': 0}
for y in range(WORLD_H):
    for x in range(WORLD_W):
        i = y * WORLD_W + x
        solid = False
        for name in SOLID_LAYERS:
            v = grid[name][i]
            if (v & 0x0fffffff) and tile_stat(v)[0] >= SOLID_COVERAGE:
                solid = True
                break
        if solid:
            blocked.append(1); counts['object'] += 1
        else:
            blocked.append(0); counts['walkable'] += 1
print('walkability:', counts)

# colour of the ground tile, used as the page background so the field reads as full-bleed
gcol = tile_stat(GRASS)[1]
background = '#%02x%02x%02x' % gcol
print('grass colour:', background)


def render(scale=3):
    img = Image.new('RGBA', (WORLD_W*T, WORLD_H*T), gcol + (255,))
    for name in LAYERS:
        for y in range(WORLD_H):
            for x in range(WORLD_W):
                v = grid[name][y*WORLD_W + x]
                ix = v & 0x0fffffff
                if ix == 0:
                    continue
                col, row = ix % COLS, ix // COLS
                t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
                if v & 0x40000000: t = t.transpose(Image.TRANSPOSE)
                if v & 0x10000000: t = t.transpose(Image.FLIP_LEFT_RIGHT)
                if v & 0x20000000: t = t.transpose(Image.FLIP_TOP_BOTTOM)
                img.alpha_composite(t, (x*T, y*T))
    return img.resize((img.width*scale, img.height*scale), Image.NEAREST)


prev = render(3)
prev.convert('RGB').save('artifacts/village_new.png')
print('wrote artifacts/village_new.png', prev.size)

ov = Image.new('RGBA', prev.size, (0, 0, 0, 0))
px = ov.load()
for y in range(WORLD_H):
    for x in range(WORLD_W):
        c = (255, 40, 40, 80) if blocked[y*WORLD_W + x] else (40, 255, 90, 80)
        for yy in range(y*T*3, y*T*3 + T*3):
            for xx in range(x*T*3, x*T*3 + T*3):
                px[xx, yy] = c
Image.alpha_composite(prev, ov).convert('RGB').save('artifacts/village_new_mask.png')

out = {
    'tileSize': T,
    'cols': WORLD_W,
    'rows': WORLD_H,
    'atlasCols': COLS,
    'background': background,
    'layers': [{'name': n, 'w': WORLD_W, 'h': WORLD_H, 'runs': rle(grid[n])} for n in LAYERS],
    'blocked': rle(blocked),
}
with open('data/village.json', 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print('wrote data/village.json', os.path.getsize('data/village.json') // 1024, 'KiB')
