"""Select a block of tiles in the tileset and paint with it."""
import atexit
import json
import shutil
import subprocess
import sys

from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/index.html'
T = 16
COLS = 47
SRC = 'data/village.json'
BACKUP = '/tmp/village_before_multibrush.json'


def expand(runs):
    out = []
    for value, count in runs:
        out.extend([value] * count)
    return out


def main():
    # This test paints on a blank canvas, so it has to put the real layout back
    # afterwards - including when an assertion fails part way through.
    shutil.copy(SRC, BACKUP)
    atexit.register(shutil.copy, BACKUP, SRC)
    subprocess.run([sys.executable, 'tools/build_village.py', '--blank'], check=True, capture_output=True)
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1440, 'height': 860}, device_scale_factor=1)
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))

        page.goto(URL, wait_until='networkidle')
        page.wait_for_function('window.__editor && window.__view')
        page.click('#edit-toggle')
        page.wait_for_selector('#editor:not([hidden])')
        page.evaluate("window.__editor.setLayer('decoration_02')")

        # drag a 2x2 block in the tileset, starting at tile column 2, row 4
        rect = page.evaluate("() => { const r = document.getElementById('ed-atlas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }")
        unit = rect['w'] / 1024.0 * T
        def tile_pt(col, row):
            return rect['x'] + (col + 0.5) * unit, rect['y'] + (row + 0.5) * unit

        a = tile_pt(2, 4)
        b = tile_pt(3, 5)
        page.mouse.move(*a)
        page.mouse.down()
        page.mouse.move(b[0], b[1], steps=6)
        page.mouse.up()

        label = page.evaluate("document.getElementById('ed-index').textContent")
        print('swatch label:', label)
        assert label == '2x2', f'block selection did not register: {label}'

        # paint two neighbouring cells with the block
        view = page.evaluate('window.__view()')
        scale, ox, oy = view['scale'], view['offset']['x'], view['offset']['y']
        def scr(tx, ty):
            return ox + (tx + 0.5) * T * scale, oy + (ty + 0.5) * T * scale

        page.mouse.move(*scr(30, 9))
        page.mouse.down()
        page.mouse.move(*scr(33, 9), steps=6)
        page.mouse.up()

        page.wait_for_timeout(300)
        page.screenshot(path='artifacts/multibrush.png')
        code = page.evaluate('window.__editor.exportCode()')
        browser.close()

    layout = json.loads(code)
    cells = expand(layout['layers']['decoration_02'])
    row9 = [cells[9 * COLS + x] for x in range(30, 34)]
    row10 = [cells[10 * COLS + x] for x in range(30, 34)]
    print('row 9:', row9, 'row 10:', row10)
    top = {v & 0x0fffffff for v in row9}
    bottom = {v & 0x0fffffff for v in row10}
    assert all(v != 0 for v in row9 + row10), 'not every cell was painted'
    assert top == {4 * 64 + 2, 4 * 64 + 3}, f'top row wrong: {top}'
    assert bottom == {5 * 64 + 2, 5 * 64 + 3}, f'bottom row wrong: {bottom}'

    shutil.copy(BACKUP, SRC)
    print('layout restored from', BACKUP)
    print('console errors:', errors or 'none')
    assert not errors, errors
    print('MULTI-BRUSH TEST PASSED')


if __name__ == '__main__':
    main()
