"""Capture screenshots of the running village for visual verification."""
import sys, time, json
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/index.html'
OUT = 'artifacts'

shots = [
    # (name, wait_ms, zoom, drag)
    ('village_overview', 2500, 1.0, None),
    ('village_zoom', 2500, 2.4, None),
    ('village_closeup', 2500, 5.0, None),
]


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1440, 'height': 860}, device_scale_factor=1)
        page.on('console', lambda m: errors.append(f'console:{m.type}:{m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror:{e}'))
        page.goto(URL, wait_until='networkidle')
        page.wait_for_timeout(1200)

        status = page.evaluate("""() => {
          const e = document.getElementById('error');
          return {
            error: e && !e.hidden ? e.textContent : null,
            npcCount: window.__debug().length,
            canvasW: document.getElementById('view').width,
            canvasH: document.getElementById('view').height,
          };
        }""")
        print('status:', json.dumps(status))

        for name, wait, zoom, _drag in shots:
            page.evaluate("""(z) => { window.__setZoom && window.__setZoom(z); }""", zoom)
            page.wait_for_timeout(wait)
            page.screenshot(path=f'{OUT}/{name}.png')
            print('wrote', f'{OUT}/{name}.png')

        # movement check: grab villager positions twice
        positions = page.evaluate("() => window.__debug ? window.__debug() : null")
        page.wait_for_timeout(2500)
        positions2 = page.evaluate("() => window.__debug ? window.__debug() : null")
        if positions and positions2:
            moved = sum(1 for a, b in zip(positions, positions2) if abs(a['x'] - b['x']) + abs(a['y'] - b['y']) > 0.5)
            print(f'villagers moved: {moved}/{len(positions)}')
            blocked_hits = [b for b in positions2 if b.get('blocked')]
            print('villagers on blocked tiles:', len(blocked_hits))
            print('sample:', positions2[:3])
        else:
            print('no __debug hook')

        browser.close()

    if errors:
        print('ERRORS:')
        for e in errors[:20]:
            print(' ', e)
    else:
        print('no console/page errors')


if __name__ == '__main__':
    main()
