"""Decode the GameMaker example room tile layers and render them to PNG."""
import json, re
from PIL import Image

EMPTY = 0x80000000
FLAG_MASK = 0x70000000
T = 16
COLS = 64

ROOM = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy'
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'


def load_yy(path):
    raw = open(path, encoding='utf-8').read()
    raw = re.sub(r',(\s*[}\]])', r'\1', raw)
    return json.loads(raw)


def decode(data):
    """positive N => N literal tiles follow; negative N => repeat next tile |N| times."""
    out = []
    i, n = 0, len(data)
    while i < n:
        v = data[i]
        i += 1
        if v >= 0:
            out.extend(data[i:i + v])
            i += v
        else:
            run = -v
            val = data[i] if i < n else EMPTY
            i += 1
            out.extend([val] * run)
    return out


def tile_image(atlas, val, cache):
    if val == EMPTY:
        return None
    idx = val & 0x0FFFFFFF
    fx = 1 if val & 0x10000000 else 0
    fy = 1 if val & 0x20000000 else 0
    diag = 1 if val & 0x40000000 else 0
    key = (idx, fx, fy, diag)
    if key in cache:
        return cache[key]
    col, row = idx % COLS, idx // COLS
    if row * T >= atlas.height or col * T >= atlas.width:
        return None
    img = atlas.crop((col * T, row * T, col * T + T, row * T + T))
    if diag:
        img = img.transpose(Image.TRANSPOSE)
    if fx:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    if fy:
        img = img.transpose(Image.FLIP_TOP_BOTTOM)
    cache[key] = img
    return img


def main():
    room = load_yy(ROOM)
    atlas = Image.open(ATLAS).convert('RGBA')
    layers = [l for l in room['layers']
              if l['resourceType'] == 'GMRTileLayer' and l.get('tiles', {}).get('TileCompressedData')]
    print('room:', room['roomSettings']['Width'], 'x', room['roomSettings']['Height'])
    print('layers:', [(l['name'], l['tiles']['SerialiseWidth'], l['tiles']['SerialiseHeight']) for l in layers])

    W = max(l['tiles']['SerialiseWidth'] for l in layers)
    H = max(l['tiles']['SerialiseHeight'] for l in layers)
    print('grid', W, 'x', H, '=', W * H)

    cache = {}
    grids = {}
    for l in layers:
        td = l['tiles']
        w, h = td['SerialiseWidth'], td['SerialiseHeight']
        cells = decode(td['TileCompressedData'])
        status = 'OK' if len(cells) == w * h else f'MISMATCH {len(cells)} vs {w*h}'
        occupied = sum(1 for c in cells if c != EMPTY)
        print(f"  {l['name']:14s} {status:22s} occupied={occupied}")
        grids[l['name']] = (w, h, cells)

    def render(order, path):
        canvas = Image.new('RGBA', (W * T, H * T), (0, 0, 0, 0))
        for name in order:
            if name not in grids:
                continue
            w, h, cells = grids[name]
            for y in range(h):
                for x in range(w):
                    img = tile_image(atlas, cells[y * w + x], cache)
                    if img:
                        canvas.alpha_composite(img, (x * T, y * T))
        bg = Image.new('RGBA', canvas.size, (60, 40, 80, 255))
        bg.alpha_composite(canvas)
        bg.convert('RGB').save(path)
        print('wrote', path, bg.size)

    names = [l['name'] for l in layers]
    render(names[::-1], 'artifacts/room_reverse.png')
    render(names, 'artifacts/room_normal.png')


if __name__ == '__main__':
    main()
