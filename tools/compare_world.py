"""Diff the browser's tile canvas against the verified Python decode.

The Python render (artifacts/room_reverse.png) is the ground truth for how the
author's room tiles assemble, so this catches any flip/diagonal mistakes in the
JavaScript tile renderer.
"""
import base64, io
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops

URL = 'http://127.0.0.1:3000/index.html'
BG = (60, 40, 80)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        page.goto(URL, wait_until='networkidle')
        page.wait_for_timeout(1500)
        data_url = page.evaluate("() => window.__worldImage()")
        browser.close()

    raw = base64.b64decode(data_url.split(',', 1)[1])
    web = Image.open(io.BytesIO(raw)).convert('RGBA')
    print('browser canvas:', web.size)

    flat = Image.new('RGBA', web.size, BG + (255,))
    flat.alpha_composite(web)
    flat = flat.convert('RGB')
    flat.save('artifacts/web_world.png')

    ref = Image.open('artifacts/room_reverse.png').convert('RGB')
    print('reference:', ref.size)
    if ref.size != flat.size:
        print('SIZE MISMATCH', ref.size, flat.size)
        return

    diff = ImageChops.difference(ref, flat)
    bbox = diff.getbbox()
    pixels = list(diff.get_flattened_data())
    differing = sum(1 for px in pixels if max(px) > 8)
    total = len(pixels)
    print(f'differing pixels: {differing}/{total} = {100 * differing / total:.3f}%')
    print('difference bbox:', bbox)

    if differing:
        diff.save('artifacts/world_diff.png')
        print('wrote artifacts/world_diff.png')


if __name__ == '__main__':
    main()
