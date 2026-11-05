"""Doors and hand-drawn rooms.

Places a door, defines the room area, paints the interior, checks the art is hidden
until the door view is on (or a villager steps in), then bakes the layout and
reloads to check the baked room still works. Restores data/village.json afterwards.
"""
import json
import shutil
import subprocess
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

SRC = 'data/village.json'
BACKUP = '/tmp/village_before_rooms.json'
URL = 'http://127.0.0.1:3000/index.html'

DOOR = (34, 6)
ROOM = (30, 14, 6, 4)  # x, y, w, h


def tile_point(page, tx, ty):
    v = page.evaluate('window.__view()')
    return (
        v['offset']['x'] + (tx + 0.5) * 16 * v['scale'],
        v['offset']['y'] + (ty + 0.5) * 16 * v['scale'],
    )


def sample(page, tx, ty, path):
    page.screenshot(path=path)
    x, y = tile_point(page, tx, ty)
    return Image.open(path).convert('RGB').getpixel((int(x), int(y)))


def near(a, b, tol=12):
    """Room art changes a tile by tens of levels; a faint editor overlay does not."""
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def quiet_tile(page):
    """A room tile nobody is standing on, so a sprite cannot spoil the pixel check."""
    npcs = page.evaluate('window.__debug()')
    x0, y0, w, h = ROOM
    best = None
    for ty in range(y0, y0 + h):
        for tx in range(x0, x0 + w):
            cx = tx * 16 + 8
            cy = ty * 16 + 8
            gap = min((abs(n['x'] - cx) ** 2 + abs(n['y'] - cy) ** 2) ** 0.5 for n in npcs)
            if best is None or gap > best[0]:
                best = (gap, tx, ty)
            return best[1], best[2]



def main():
    shutil.copy(SRC, BACKUP)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
            page = browser.new_page(viewport={'width': 1000, 'height': 800}, device_scale_factor=1)
            errors = []
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(URL, wait_until='load')
            page.wait_for_function('window.__editor && window.__debug().length > 0', timeout=15000)
            page.evaluate('window.__editor.open()')
            page.wait_for_timeout(150)

            # what the map itself looks like where the room will go, so the hidden
            # check compares against the real background instead of a fixed colour
            # One tile, used for every check below: grass shade changes from tile to
            # tile, so the reference has to come from the same spot each time.
            base_x, base_y = quiet_tile(page)
            baseline = sample(page, base_x, base_y, 'artifacts/room_baseline.png')
            print('map pixel where the room goes:', baseline, 'at tile', (base_x, base_y))

            # --- place a door, then tell it where its room lives
            page.click('[data-mode="rooms"]')
            page.click('[data-tool="door"]')
            page.mouse.click(*tile_point(page, *DOOR))
            rooms = page.evaluate('window.__editor.rooms()')
            idx = next((i for i, r in enumerate(rooms) if r['door'] == list(DOOR)), None)
            assert idx is not None, rooms
            print('door placed at', rooms[idx]['door'], '- room', idx)

            page.click('[data-tool="area"]')
            page.mouse.move(*tile_point(page, ROOM[0], ROOM[1]))
            page.mouse.down()
            page.mouse.move(*tile_point(page, ROOM[0] + ROOM[2] - 1, ROOM[1] + ROOM[3] - 1), steps=8)
            page.mouse.up()
            page.wait_for_timeout(100)
            room = page.evaluate('window.__editor.rooms()')[idx]
            assert (room['x'], room['y'], room['w'], room['h']) == ROOM, room
            print('room area:', room['x'], room['y'], room['w'], room['h'])

            # --- draw a floor over every room tile, one row at a time
            page.click('[data-tool="paint"]')
            page.evaluate("window.__editor.setRoomLayer('floor')")
            page.evaluate('window.__editor.setBrush(460)')
            for ty in range(ROOM[1], ROOM[1] + ROOM[3]):
                page.mouse.move(*tile_point(page, ROOM[0], ty))
                page.mouse.down()
                page.mouse.move(*tile_point(page, ROOM[0] + ROOM[2] - 1, ty), steps=8)
                page.mouse.up()
            page.wait_for_timeout(100)
            room = page.evaluate('window.__editor.rooms()')[idx]
            assert room['drawn'] == ROOM[2] * ROOM[3], room
            print('interior tiles drawn:', room['drawn'])
            page.screenshot(path='artifacts/room_debug.png')

            # --- door view on: art visible; door view off: art hidden
            lit = sample(page, base_x, base_y, 'artifacts/room_debug.png')
            page.click('[data-mode="map"]')
            dark = sample(page, base_x, base_y, 'artifacts/room_hidden.png')
            print('room tile pixel, door view on:', lit, 'off:', dark)
            assert not near(lit, baseline, 30), 'room art was not drawn in the door view'
            assert near(dark, baseline), f'room art leaked onto the map: {dark}'

            # --- export + bake
            code = page.evaluate('window.__editor.exportCode()')
            layout = json.loads(code)
            assert 'interiors' not in layout, 'house-based interiors are still exported'
            assert layout['rooms'][idx]['door'] == list(DOOR), layout['rooms']
            assert sum(c for v, c in layout['rooms'][idx]['floor'] if v) == ROOM[2] * ROOM[3]
            open('/tmp/rooms_layout.json', 'w').write(code)

            baked = subprocess.run([sys.executable, 'tools/apply_layout.py', '/tmp/rooms_layout.json'],
                                   capture_output=True, text=True)
            assert baked.returncode == 0, baked.stderr
            print(baked.stdout.strip())
            data = json.load(open(SRC))
            baked_room = next((r for r in data['rooms'] if r['door'] == list(DOOR)), None)
            assert baked_room is not None, data.get('rooms')

            # --- reload: room is hidden on the map until someone walks in
            page.goto(URL, wait_until='load')
            page.wait_for_function('window.__rooms && window.__debug().length > 0', timeout=15000)
            rooms = page.evaluate('window.__rooms()')
            idx = next((i for i, r in enumerate(rooms) if r['door'] == list(DOOR)), None)
            assert idx is not None, rooms
            print('rooms on the map:', len(rooms), '- this test owns room', idx)
            assert page.evaluate('window.__roomsShown()') is False
            assert near(sample(page, base_x, base_y, 'artifacts/room_hidden.png'), baseline), 'baked room is visible'
            print('baked room hidden until used')

            # --- walk a villager through the door
            assert page.evaluate(f'window.__visitRoom({idx})') is True, 'no path to the door'
            page.wait_for_function(f'window.__debug()[0].inside === {idx}', timeout=60000)
            print('villager 0 inside room', idx)
            page.wait_for_timeout(400)
            seen = sample(page, base_x, base_y, 'artifacts/room_enter.png')
            print('room tile pixel while inside:', seen)
            assert not near(seen, baseline, 30), 'the room did not open for the villager'
            page.screenshot(path='artifacts/room_enter.png')

            page.wait_for_function('window.__debug()[0].inside === null', timeout=60000)
            page.wait_for_function('window.__npc(0).path.length === 0', timeout=25000)
            npc = page.evaluate('window.__debug()')[0]
            tile = (int(npc['x'] // 16), int(npc['y'] // 16))
            print('villager walked out to', tile)
            assert tile != DOOR, 'villager is still standing in the doorway'
            assert abs(tile[0] - DOOR[0]) <= 4 and abs(tile[1] - DOOR[1]) <= 4, tile

            assert not errors, errors
            print('console errors: none')
            browser.close()
    finally:
        shutil.copy(BACKUP, SRC)

    print('ROOMS TEST PASSED')


if __name__ == '__main__':
    main()
