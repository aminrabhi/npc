"""Render candidate tile modules exactly as they will be stamped into the new village:
houses on grass, a repeating road band, a grass fill test and a farm patch."""
import json, re, os
from PIL import Image

T = 16
COLS = 64
ROOM = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy'
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'
GRASS = 193

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

room = load_yy(ROOM)
atlas = Image.open(ATLAS).convert('RGBA')
layers = [l for l in room['layers'] if l['resourceType'] == 'GMRTileLayer' and l.get('tiles', {}).get('TileCompressedData')]
W = max(l['tiles']['SerialiseWidth'] for l in layers)
H = max(l['tiles']['SerialiseHeight'] for l in layers)
grids = {l['name']: (l['tiles']['SerialiseWidth'], l['tiles']['SerialiseHeight'], decode(l['tiles']['TileCompressedData'])) for l in layers}
order = [l['name'] for l in layers][::-1]

def tile_img(v):
    ix = v & 0x0fffffff
    if ix == 0: return None
    fx = v & 0x10000000; fy = v & 0x20000000; dg = v & 0x40000000
    col, row = ix % COLS, ix // COLS
    t = atlas.crop((col*T, row*T, col*T+T, row*T+T))
    if dg: t = t.transpose(Image.TRANSPOSE)
    if fx: t = t.transpose(Image.FLIP_LEFT_RIGHT)
    if fy: t = t.transpose(Image.FLIP_TOP_BOTTOM)
    return t

def get(name, x, y):
    w, h, cells = grids[name]
    if x < 0 or y < 0 or x >= w or y >= h: return 0
    return cells[y*w + x]

def occ(name, x, y):
    return (get(name, x, y) & 0x0fffffff) != 0

def render(x0, y0, x1, y1, names, scale=4, grass=True, label=''):
    img = Image.new('RGBA', ((x1-x0)*T, (y1-y0)*T), (96,195,76,255) if grass else (0,0,0,0))
    if grass:
        g = tile_img(GRASS)
        for yy in range(y1-y0):
            for xx in range(x1-x0):
                img.alpha_composite(g, (xx*T, yy*T))
    for name in names:
        w, h, cells = grids[name]
        for y in range(max(0,y0), min(h,y1)):
            for x in range(max(0,x0), min(w,x1)):
                t = tile_img(cells[y*w+x])
                if t: img.alpha_composite(t, ((x-x0)*T, (y-y0)*T))
    img = img.resize((img.width*scale, img.height*scale), Image.NEAREST)
    return img

os.makedirs('artifacts/cat', exist_ok=True)

# grass fill
render(0, 0, 8, 5, [], 5).convert('RGB').save('artifacts/cat/grass.png')

# houses: building + walls + props only, no trees/water/ground
HOUSE_LAYERS = ['building', 'walls', 'decoration_03']
comps = [
    (38, 23, 47, 29), (16, 32, 28, 39), (50, 11, 56, 15), (38, 14, 42, 19),
    (32, 19, 36, 23), (13, 26, 18, 31), (40, 33, 44, 37), (50, 20, 56, 26),
    (28, 6, 34, 12), (60, 33, 66, 38), (20, 20, 26, 25), (44, 24, 48, 28),
]
for i, (x0, y0, x1, y1) in enumerate(comps):
    img = render(x0-1, y0-1, x1+2, y1+2, HOUSE_LAYERS, 4)
    img.convert('RGB').save(f'artifacts/cat/house_{i}.png')
    print(f'house_{i}: ({x0},{y0})-({x1},{y1}) {x1-x0+1}x{y1-y0+1}')

# road band candidates (paths + land), a wide stretch
render(18, 28, 44, 36, ['land', 'paths'], 3).convert('RGB').save('artifacts/cat/road_band.png')
print('road_band: x18-43, y28-35')

# farm candidates
render(4, 7, 20, 16, ['land', 'paths', 'decoration_01', 'decoration_02', 'decoration_03', 'building', 'walls'], 4).convert('RGB').save('artifacts/cat/farm.png')
print('farm: x4-19, y7-15')

# single tree stamps
render(52, 1, 64, 7, ['land', 'decoration_01', 'decoration_02', 'decoration_03'], 4).convert('RGB').save('artifacts/cat/trees.png')
print('trees: x52-63, y1-6')
