"""Soak test: watch villagers over time for blocked tiles, stalls and teleports."""
from playwright.sync_api import sync_playwright
import json, math

URL = 'http://127.0.0.1:3000/index.html'


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1440, 'height': 860}, device_scale_factor=1)
        page.on('pageerror', lambda e: errors.append(f'pageerror:{e}'))
        page.on('console', lambda m: errors.append(f'console:{m.text}') if m.type == 'error' else None)
        page.goto(URL, wait_until='networkidle')
        page.wait_for_timeout(1500)

        samples = []
        for _ in range(60):  # 30 seconds
            page.wait_for_timeout(500)
            samples.append(page.evaluate("() => window.__debug()"))

        browser.close()

    n = len(samples[0])
    blocked_hits = 0
    teleports = 0
    stalled = []
    max_step = 0.0

    for i in range(n):
        traveled = 0.0
        for a, b in zip(samples, samples[1:]):
            pa, pb = a[i], b[i]
            d = math.hypot(pb['x'] - pa['x'], pb['y'] - pa['y'])
            traveled += d
            max_step = max(max_step, d)
            if d > 40:  # 0.5s at max speed 32px/s => 16px; 40 is a clear teleport
                teleports += 1
            if pb['blocked']:
                blocked_hits += 1
        if traveled < 8:
            stalled.append((i, round(traveled, 1)))

    print(f'villagers: {n}')
    print(f'samples: {len(samples)} over 30s')
    print(f'blocked-tile samples: {blocked_hits}')
    print(f'teleports (step > 40px): {teleports}')
    print(f'largest single step: {max_step:.1f}px')
    print(f'near-stationary villagers (<8px total): {stalled if stalled else "none"}')
    print(f'errors: {errors[:5] if errors else "none"}')


if __name__ == '__main__':
    main()
