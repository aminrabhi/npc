"""Find an authored all-grass region and render it, plus properly scaled tile fill tests."""
import json, re, os
from PIL import Image

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


def tile_img(ix):
    col, row = ix % COLS, ix // COLS
    return atlas.crop((col*T, row*T, col*T+T, row*T+T))


_color = {}
def colour(ix):
    if ix in _color: return _color[ix]
    px = [p for p in tile_img(ix).get_flattened_data() if p[3] > 200]
    if not px:
        _color[ix] = None
    else:
        n = len(px)
        _color[ix] = (sum(p[0] for p in px)//n, sum(p[1] for p in px)//n, sum(p[2] for p in px)//n)
    return _color[ix]


def get(name, x, y):
    w, h, cells = grids[name]
    if x < 0 or y < 0 or x >= w or y >= h: return 0
    return cells[y*w + x]


def is_green(ix):
    c = colour(ix)
    return c is not None and c[1] > c[0] + 30 and c[1] > 120


def render_region(x0, y0, w, h, names, scale=4):
    out = Image.new('RGBA', (w*T, h*T), (0, 0, 0, 255))
    for name in names:
        for y in range(y0, y0+h):
            for x in range(x0, x0+w):
                v = get(name, x, y)
                ix = v & 0x0fffffff
                if ix == 0: continue
                t = tile_img(ix)
                if v & 0x10000000: t = t.transpose(Image.FLIP_LEFT_RIGHT)
                if v & 0x20000000: t = t.transpose(Image.FLIP_TOP_BOTTOM)
                out.alpha_composite(t, ((x-x0)*T, (y-y0)*T))
    return out.resize((out.width*scale, out.height*scale), Image.NEAREST)


w0, h0, _ = grids['land']
best = None
for hh in (12, 10, 8):
    for ww in (20, 16, 12):
        found = None
        for y0 in range(0, h0-hh):
            for x0 in range(0, w0-ww):
                ok = True
                for y in range(y0, y0+hh):
                    for x in range(x0, x0+ww):
                        v = get('land', x, y) & 0x0fffffff
                        if v == 0 or not is_green(v):
                            ok = False; break
                        for name in ('building', 'walls', 'paths', 'decoration_02', 'decoration_03'):
                            if (get(name, x, y) & 0x0fffffff) != 0:
                                ok = False; break
                        if not ok: break
                    if not ok: break
                if ok:
                    found = (x0, y0, ww, hh); break
            if found: break
        if found:
            print(f'pure grass region: x={found[0]} y={found[1]} size {found[2]}x{found[3]}')
            if best is None or found[2]*found[3] > best[2]*best[3]:
                best = found
            break

if best:
    x0, y0, ww, hh = best
    img = render_region(x0, y0, ww, hh, ['land', 'decoration_01'], 5)
    img.convert('RGB').save('artifacts/cat/grass_authored.png')
    print('wrote artifacts/cat/grass_authored.png')

# a 4x4 tile fill, correctly scaled
S = 12
cands = [193, 129, 66, 261]
out = Image.new('RGBA', (4*4*T*S, 4*T*S), (0, 0, 0, 255))
for i, ix in enumerate(cands):
    t = tile_img(ix).resize((T*S, T*S), Image.NEAREST)
    for gy in range(4):
        for gx in range(4):
            out.alpha_composite(t, (i*4*T*S + gx*T*S, gy*T*S))
out.convert('RGB').save('artifacts/cat/grass_candidates.png')
print('candidates left to right:', cands)
