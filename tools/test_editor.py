"""Drive the in-page tile editor and check that its exported layout code is valid.

Paints a tile, copies and pastes a cottage, exports the code, and confirms the
export round-trips through tools/apply_layout.py.
"""
import json
import os
import shutil
import subprocess
import sys

from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/'
T = 16


def expand(runs):
    out = []
    for value, count in runs:
        out.extend([value] * count)
    return out


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1400, 'height': 900}, device_scale_factor=1)
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))

        page.goto(URL)
        page.wait_for_function('window.__editor && window.__view')

        base = json.load(open('data/village.json'))
        before = {layer['name']: expand(layer['runs']) for layer in base['layers']}

        # --- open the editor
        page.click('#edit-toggle')
        page.wait_for_selector('#editor:not([hidden])')
        assert page.is_visible('#editor'), 'editor panel did not open'

        # --- clean screenshot of the editor before any edits
        os.makedirs('artifacts', exist_ok=True)
        page.wait_for_timeout(300)
        page.screenshot(path='artifacts/editor_ui.png')

        # --- the export button opens a modal with the layout code in it
        page.click('#ed-export')
        page.wait_for_selector('#ed-modal:not([hidden])')
        modal_code = page.evaluate("document.querySelector('#ed-modal textarea').value")
        assert len(modal_code) > 80 and json.loads(modal_code)['cols'] == 47, 'export modal came up empty'
        assert json.loads(modal_code)['cols'] == 47, 'modal code is not the layout'
        page.click('#ed-modal-close')
        print('export modal: ok,', len(modal_code), 'bytes')

        view = page.evaluate('window.__view()')
        scale, ox, oy = view['scale'], view['offset']['x'], view['offset']['y']

        def screen(tx, ty):
            return ox + (tx + 0.5) * T * scale, oy + (ty + 0.5) * T * scale

        # --- paint: brush a known atlas tile onto a grass cell
        page.evaluate("window.__editor.setLayer('decoration_02')")
        page.evaluate("window.__editor.setBrush(300)")
        sx, sy = screen(30, 9)
        page.mouse.move(sx, sy)
        page.mouse.down()
        page.mouse.up()
        painted = page.evaluate('window.__editor.exportCode()')
        diag = page.evaluate("() => ({swatch: !!document.getElementById('ed-swatch'), atlas: !!document.getElementById('ed-atlas'), panelHtml: document.getElementById('editor') ? document.getElementById('editor').innerHTML.length : -1})")
        print('diag:', diag, 'errors:', errors[:3])
        assert diag['swatch'], 'swatch missing'

        # --- drag paints a run of cells
        page.evaluate("window.__editor.setBrush(301)")
        a = screen(28, 11)
        b = screen(32, 11)
        page.mouse.move(*a)
        page.mouse.down()
        page.mouse.move(b[0], b[1], steps=6)
        page.mouse.up()

        # --- copy the painted patch (every layer) and stamp it elsewhere
        page.evaluate('window.__editor.select(28, 9, 6, 3)')
        page.evaluate('window.__editor.copySelection()')
        page.evaluate('window.__editor.stampAt(30, 20)')

        # --- wipe an area on every layer except the ground
        page.evaluate('window.__editor.select(1, 1, 2, 4)')
        page.evaluate('window.__editor.eraseArea()')

        code = page.evaluate('window.__editor.exportCode()')
        layout = json.loads(code)

        # --- the title bar drags the panel around
        box_before = page.evaluate("() => { const r = document.getElementById('editor').getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        grip = page.evaluate("() => { const r = document.getElementById('ed-head').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }")
        page.mouse.move(grip['x'], grip['y'])
        page.mouse.down()
        page.mouse.move(grip['x'] + 220, grip['y'] - 140, steps=8)
        page.mouse.up()
        box_after = page.evaluate("() => { const r = document.getElementById('editor').getBoundingClientRect(); return { x: r.x, y: r.y }; }")
        print('panel moved:', box_before, '->', box_after)
        assert abs(box_after['x'] - box_before['x']) > 100, 'panel did not move horizontally'
        assert box_before['y'] - box_after['y'] > 60, 'panel did not move vertically'
        page.wait_for_timeout(200)
        page.screenshot(path='artifacts/editor_dragged.png')

        page.evaluate('window.__editor.close()')
        browser.close()

    # ---------------------------------------------------------------- checks
    print('code length:', len(code), 'bytes')
    assert layout['cols'] == 47 and layout['rows'] == 28, 'layout size changed'
    size = layout['cols'] * layout['rows']

    after = {name: expand(runs) for name, runs in layout['layers'].items()}
    for name, cells in after.items():
        assert len(cells) == size, f'{name}: {len(cells)} cells, expected {size}'

    diffs = {name: [i for i, (a, b) in enumerate(zip(cells, before[name])) if a != b]
             for name, cells in after.items()}
    changed = {name: len(idx) for name, idx in diffs.items()}
    print('edited cells per layer:', changed)
    assert changed['decoration_02'] > 0, 'painting did not change decoration_02'

    # Every difference has to fall inside one of the areas this test edits: the two
    # brush strokes, the copied-and-stamped patch (a copy carries whole layers, houses
    # included) and the erased rectangle. Anything else means an accidental edit.
    allowed = ({(30, 9)} | {(x, 11) for x in range(28, 33)}
               | {(x, y) for y in range(20, 23) for x in range(30, 36)}
               | {(x, y) for y in range(1, 5) for x in range(1, 3)})
    for name, idx in diffs.items():
        stray = [(i % 47, i // 47) for i in idx if (i % 47, i // 47) not in allowed]
        assert not stray, f'{name} changed outside the edited areas: {stray[:5]}'

    blocked = expand(layout['blocked'])
    print('blocked cells:', sum(1 for b in blocked if b))

    # ------------------------------------------------- round trip through build
    with open('/tmp/layout_export.json', 'w') as f:
        f.write(code)
    shutil.copy('data/village.json', '/tmp/village_backup.json')

    result = subprocess.run([sys.executable, 'tools/apply_layout.py', '/tmp/layout_export.json'],
                            capture_output=True, text=True)
    print(result.stdout.strip())
    if result.returncode != 0:
        print(result.stderr.strip())
        raise SystemExit('apply_layout.py failed')

    baked = json.load(open('data/village.json'))
    assert baked['cols'] == 47 and baked['rows'] == 28
    assert len(baked['layers']) == 8, 'baked file lost layers'
    baked_cells = {l['name']: expand(l['runs']) for l in baked['layers']}
    print('baked decoration_02 matches export:',
          baked_cells['decoration_02'] == after['decoration_02'])
    assert baked_cells['decoration_02'] == after['decoration_02'], 'baking lost the edits'

    shutil.copy('/tmp/village_backup.json', 'data/village.json')
    print('restored data/village.json to its committed layout')

    print('console errors:', errors or 'none')
    assert not errors, f'console errors: {errors}'
    print('EDITOR TEST PASSED')


if __name__ == '__main__':
    main()
