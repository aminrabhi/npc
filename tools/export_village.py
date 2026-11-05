"""Export the decoded GameMaker example room to data/village.json + a walkability debug image.

Tile values keep their GameMaker encoding: the low 28 bits are the atlas index and bits
28-30 are flip/mirror/diagonal flags. 0x80000000 (index 0) is the empty cell.
"""
import json, re, os
from PIL import Image

T = 16
COLS = 64
ROOM = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy'
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'

# layers whose dense tiles are solid objects (buildings, fences, trees, props)
OBJECT_LAYERS = ['building', 'walls', 'decoration_01', 'decoration_02', 'decoration_03']
# a tile counts as an object when this much of the cell is opaque
SOLID_COVERAGE = 0.5


def load_yy(path):
    raw = open(path, encoding='utf-8').read()
    raw = re.sub(r',(\s*[}\]])', r'\1', raw)
    return json.loads(raw)


def decode(data):
    out, i, n = [], 0, len(data)
    while i < n:
        v = data[i]
        i += 1
        if v >= 0:
            out.extend(data[i:i + v])
            i += v
        else:
            out.extend([data[i]] * (-v))
            i += 1
    return out


def rle(cells):
    out = []
    for c in cells:
        if out and out[-1][0] == c:
            out[-1][1] += 1
        else:
            out.append([c, 1])
    return out


def main():
    room = load_yy(ROOM)
    atlas = Image.open(ATLAS).convert('RGBA')

    layers = [l for l in room['layers']
              if l['resourceType'] == 'GMRTileLayer' and l.get('tiles', {}).get('TileCompressedData')]
    W = max(l['tiles']['SerialiseWidth'] for l in layers)
    H = max(l['tiles']['SerialiseHeight'] for l in layers)

    grids = {}
    for l in layers:
        td = l['tiles']
        w, h = td['SerialiseWidth'], td['SerialiseHeight']
        grids[l['name']] = (w, h, decode(td['TileCompressedData']))

    # GameMaker lists layers top -> bottom; draw bottom -> top.
    ordered = layers[::-1]
    exported = [{'name': l['name'], 'w': grids[l['name']][0], 'h': grids[l['name']][1],
                 'runs': rle(grids[l['name']][2])} for l in ordered]

    # ---------- per-tile classification ----------
    stat = {}

    def tile_stat(val):
        idx = val & 0x0FFFFFFF
        if idx in stat:
            return stat[idx]
        col, row = idx % COLS, idx // COLS
        t = atlas.crop((col * T, row * T, col * T + T, row * T + T))
        px = [p for p in t.get_flattened_data() if p[3] > 200]
        if not px:
            res = (0.0, None)
        else:
            n = len(px)
            res = (n / (T * T),
                   (sum(p[0] for p in px) // n, sum(p[1] for p in px) // n, sum(p[2] for p in px) // n))
        stat[idx] = res
        return res

    def is_water(rgb):
        r, g, b = rgb
        if b > r + 25 and b > 120:
            return True
        return b > 150 and b > g - 20

    land_w, land_h, land = grids['land']
    objs = {name: grids[name] for name in OBJECT_LAYERS if name in grids}

    def cell(grids_entry, x, y):
        w, h, cells = grids_entry
        if x >= w or y >= h:
            return None
        return cells[y * w + x]

    blocked = []
    counts = {'void': 0, 'water': 0, 'object': 0, 'walkable': 0}
    for y in range(H):
        for x in range(W):
            ground = cell(grids['land'], x, y)
            cov, rgb = (0.0, None) if ground is None else tile_stat(ground)
            if ground is None or (ground & 0x0FFFFFFF) == 0 or cov < 0.2:
                blocked.append(1); counts['void'] += 1; continue
            if rgb and is_water(rgb):
                blocked.append(1); counts['water'] += 1; continue
            solid = False
            for entry in objs.values():
                v = cell(entry, x, y)
                if v is None or (v & 0x0FFFFFFF) == 0:
                    continue
                if tile_stat(v)[0] >= SOLID_COVERAGE:
                    solid = True
                    break
            if solid:
                blocked.append(1); counts['object'] += 1; continue
            blocked.append(0); counts['walkable'] += 1

    print('grid', W, 'x', H, counts)

    os.makedirs('data', exist_ok=True)
    out = {
        'tileSize': T,
        'cols': W,
        'rows': H,
        'atlasCols': COLS,
        'layers': exported,
        'blocked': rle(blocked),
    }
    with open('data/village.json', 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print('wrote data/village.json', os.path.getsize('data/village.json') // 1024, 'KiB')

    # ---------- debug overlay ----------
    base = Image.open('artifacts/room_reverse.png').convert('RGBA')
    dbg = Image.new('RGBA', (W * T, H * T), (0, 0, 0, 0))
    px = dbg.load()
    for y in range(H):
        for x in range(W):
            colour = (255, 40, 40, 100) if blocked[y * W + x] else (40, 255, 90, 100)
            for yy in range(y * T, y * T + T):
                for xx in range(x * T, x * T + T):
                    px[xx, yy] = colour
    Image.alpha_composite(base, dbg).convert('RGB').resize(
        (W * T // 2, H * T // 2), Image.NEAREST).save('artifacts/walk_mask.png')
    print('wrote artifacts/walk_mask.png')


if __name__ == '__main__':
    main()
