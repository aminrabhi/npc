"""Find isolated tree-shaped decoration clusters in the example room."""
import json, re
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
layers = [l for l in room['layers'] if l['resourceType'] == 'GMRTileLayer' and l.get('tiles', {}).get('TileCompressedData')]
grids = {l['name']: (l['tiles']['SerialiseWidth'], l['tiles']['SerialiseHeight'], decode(l['tiles']['TileCompressedData'])) for l in layers}

_stat = {}
def cov(val):
    ix = val & 0x0fffffff
    if ix == 0: return 0.0
    if ix in _stat: return _stat[ix]
    col, row = ix % COLS, ix // COLS
    t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
    px = [p for p in t.get_flattened_data() if p[3] > 200]
    _stat[ix] = len(px) / (T*T)
    return _stat[ix]


def get(name, x, y):
    w, h, cells = grids[name]
    if x < 0 or y < 0 or x >= w or y >= h: return 0
    return cells[y*w + x]


DENSE = ['decoration_01', 'decoration_02', 'decoration_03']
def dense(x, y):
    for name in DENSE:
        if cov(get(name, x, y)) >= 0.45:
            return True
    return False


w0, h0, _ = grids['land']
seen = set()
comps = []
for y in range(h0):
    for x in range(w0):
        if not dense(x, y) or (x, y) in seen:
            continue
        stack = [(x, y)]; seen.add((x, y)); cells = []
        while stack:
            cx, cy = stack.pop(); cells.append((cx, cy))
            for dx, dy in ((1,0), (-1,0), (0,1), (0,-1)):
                nx, ny = cx+dx, cy+dy
                if 0 <= nx < w0 and 0 <= ny < h0 and (nx, ny) not in seen and dense(nx, ny):
                    seen.add((nx, ny)); stack.append((nx, ny))
        xs = [c[0] for c in cells]; ys = [c[1] for c in cells]
        comps.append((len(cells), min(xs), min(ys), max(xs), max(ys)))

# trees are roughly 2-4 tiles across and taller than wide, or square
cands = [c for c in comps if 2 <= c[3]-c[1]+1 <= 4 and 2 <= c[4]-c[2]+1 <= 5 and c[0] >= 4]
cands.sort(key=lambda c: -c[0])
print(f'{len(comps)} dense clusters, {len(cands)} tree-sized')
for n, x0, y0, x1, y1 in cands[:12]:
    print(f'  tiles={n} ({x0},{y0})-({x1},{y1}) {x1-x0+1}x{y1-y0+1}')

def render_rect(x0, y0, w, h):
    img = Image.new('RGBA', (w*T, h*T), (96, 195, 76, 255))
    for name in DENSE + ['building', 'walls', 'paths', 'land']:
        for y in range(y0, y0+h):
            for x in range(x0, x0+w):
                v = get(name, x, y)
                ix = v & 0x0fffffff
                if ix == 0: continue
                col, row = ix % COLS, ix // COLS
                t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
                if v & 0x40000000: t = t.transpose(Image.TRANSPOSE)
                if v & 0x10000000: t = t.transpose(Image.FLIP_LEFT_RIGHT)
                if v & 0x20000000: t = t.transpose(Image.FLIP_TOP_BOTTOM)
                img.alpha_composite(t, ((x-x0)*T, (y-y0)*T))
    return img

# montage of the top candidates
S = 4
cell_w = 5 * T * S
cell_h = 6 * T * S
cols_n = 4
rows_n = 3
mont = Image.new('RGBA', (cols_n*cell_w, rows_n*(cell_h+16)), (20, 20, 28, 255))
d = ImageDraw.Draw(mont)
for i, (n, x0, y0, x1, y1) in enumerate(cands[:12]):
    w, h = x1-x0+1, y1-y0+1
    img = render_rect(x0, y0, w, h).resize((w*T*S, h*T*S), Image.NEAREST)
    cx = (i % cols_n) * cell_w
    cy = (i // cols_n) * (cell_h + 16)
    mont.alpha_composite(img, (cx, cy))
    d.text((cx+4, cy+cell_h+2), f'{i}: ({x0},{y0}) {w}x{h}', fill=(255,255,255,255))
mont.convert('RGB').save('artifacts/cat/tree_candidates.png')
print('wrote artifacts/cat/tree_candidates.png')
