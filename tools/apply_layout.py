"""Bake a layout exported from the in-page editor into data/village.json.

Usage:
    python3 tools/apply_layout.py layout.json      # file holding the exported code
    python3 tools/apply_layout.py                  # same code on stdin

The editor exports JSON shaped like:
    {"v":1,"cols":47,"rows":28,"layers":{"land":[[66,1316]],...},"blocked":[...]}

Walkability is recomputed here from the atlas rather than trusted from the export,
so the baked file always agrees with how the builder defines solid ground.
"""
import json
import sys
from PIL import Image

T = 16
COLS = 64
GRASS = 66

# Canonical bottom-to-top order; the editor may omit layers that were never touched.
LAYERS = ['land', 'paths', 'shadows', 'decoration_01', 'building', 'walls',
          'decoration_02', 'decoration_03']
SOLID_LAYERS = ['building', 'walls', 'decoration_01', 'decoration_02', 'decoration_03']
# Room interiors, bottom to top: two floor detail layers between the floor and the
# wall, then props, then the three furniture layers from the editor's door view.
ROOM_LAYERS = ['floor', 'floor_02', 'floor_03', 'wall', 'props',
               'furniture_01', 'furniture_02', 'furniture_03']
SOLID_COVERAGE = 0.5

ATLAS = 'assets/tileset/sunnyside_16px.png'
OUT = 'data/village.json'


def expand(runs, size):
    out = []
    for pair in runs:
        value, count = pair[0], pair[1]
        out.extend([value] * count)
        if len(out) > size:
            break
    out = out[:size]
    if len(out) < size:
        out.extend([0] * (size - len(out)))
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
    if len(sys.argv) > 1:
        raw = open(sys.argv[1], encoding='utf-8').read()
    else:
        raw = sys.stdin.read()

    data = json.loads(raw)
    if not isinstance(data, dict) or 'layers' not in data:
        raise SystemExit('that does not look like a layout code (no "layers" key)')

    cols = int(data['cols'])
    rows = int(data['rows'])
    size = cols * rows

    supplied = data['layers']
    unknown = [name for name in supplied if name not in LAYERS]
    if unknown:
        raise SystemExit(f'unknown layer(s) in the code: {unknown}')

    grid = {name: expand(supplied.get(name, []), size) for name in LAYERS}

    atlas = Image.open(ATLAS).convert('RGBA')
    stat_cache = {}

    def coverage(value):
        ix = value & 0x0fffffff
        if ix == 0:
            return 0.0
        if ix in stat_cache:
            return stat_cache[ix]
        col, row = ix % COLS, ix // COLS
        tile = atlas.crop((col * T, row * T, col * T + T, row * T + T))
        px = [p for p in tile.get_flattened_data() if p[3] > 200]
        stat_cache[ix] = len(px) / (T * T)
        return stat_cache[ix]

    blocked = []
    for i in range(size):
        solid = 0
        for name in SOLID_LAYERS:
            value = grid[name][i]
            if (value & 0x0fffffff) and coverage(value) >= SOLID_COVERAGE:
                solid = 1
                break
        blocked.append(solid)

    # Manual marks from the editor's collide brush win over the atlas pass:
    # 1 forces the tile solid, 2 forces it walkable.
    # 1 is a whole-tile box, 3 and 4 are the left and right half of a tile, 2 forces
    # the cell open. Halves are baked as 2 and 3 so the game can test pixel positions.
    manual = expand(data.get('manual') or [], size)
    for i, mark in enumerate(manual):
        if mark == 2:
            blocked[i] = 0
        elif mark == 1:
            blocked[i] = 1
        elif mark == 3:
            blocked[i] = 2
        elif mark == 4:
            blocked[i] = 3

    counts = {'walkable': blocked.count(0), 'object': blocked.count(1),
              'half': blocked.count(2) + blocked.count(3)}

    grass_tile = atlas.crop((GRASS % COLS * T, GRASS // COLS * T,
                             GRASS % COLS * T + T, GRASS // COLS * T + T))
    px = [p for p in grass_tile.get_flattened_data() if p[3] > 200]
    gcol = (sum(p[0] for p in px) // len(px),
            sum(p[1] for p in px) // len(px),
            sum(p[2] for p in px) // len(px))
    background = '#%02x%02x%02x' % gcol

    out = {
        'tileSize': T,
        'cols': cols,
        'rows': rows,
        'atlasCols': COLS,
        'background': background,
        'layers': [{'name': n, 'w': cols, 'h': rows, 'runs': rle(grid[n])} for n in LAYERS],
        'blocked': rle(blocked),
        'manual': rle(manual),
    }
    # Doorways and the hand-drawn room behind each one. A room is a rectangle of
    # map tiles; its art is only drawn in the editor's door view or while a
    # villager is inside, so it never shows up on the map on its own.
    rooms = []
    for entry in data.get('rooms') or []:
        door = entry.get('door') or []
        w = int(entry.get('w') or 0)
        h = int(entry.get('h') or 0)
        if len(door) != 2 or w <= 0 or h <= 0:
            continue
        x = max(0, min(int(entry.get('x') or 0), cols - 1))
        y = max(0, min(int(entry.get('y') or 0), rows - 1))
        w = max(1, min(w, cols - x))
        h = max(1, min(h, rows - y))
        room = {
            'door': [max(0, min(int(door[0]), cols - 1)),
                     max(0, min(int(door[1]), rows - 1))],
            'x': x, 'y': y, 'w': w, 'h': h,
        }
        for name in ROOM_LAYERS:
            room[name] = rle(expand(entry.get(name) or [], w * h))
        # Solid furniture indoors: 1 blocks, 0 is open floor.
        room['blocked'] = rle(expand(entry.get('blocked') or [], w * h))
        rooms.append(room)
    if rooms:
        out['rooms'] = rooms
        print(f'carried over {len(rooms)} door/room(s)')
    if data.get('interiors'):
        print(f"dropped {len(data['interiors'])} house-based interior(s)")

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))

    print(f'wrote {OUT} from a {cols}x{rows} layout')
    print('walkability:', counts)

    if 'blocked' in supplied:
        theirs = expand(supplied['blocked'], size)
        diff = sum(1 for a, b in zip(theirs, blocked) if (1 if a else 0) != b)
        print(f'blocked cells differing from the browser: {diff}')


if __name__ == '__main__':
    main()
