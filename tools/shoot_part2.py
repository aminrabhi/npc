"""Screenshot the Conversation Logs panel with a finished conversation open.

This container has no system monospace font, so DOM text outside the HUD (which uses
the bundled Pixelify Sans) renders blank in screenshots. For the shot only, the pixel
font is forced onto the panel so the real labels are visible.
"""
import json
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3001/index.html'


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1600, 'height': 1000}, device_scale_factor=1)
        page.goto(URL, wait_until='networkidle')
        page.wait_for_timeout(1500)

        page.evaluate('window.__clock.setOverride(12, 0)')
        page.evaluate('window.__lifestyle.replanAll()')
        page.evaluate("""async () => {
            for (let i = 0; i < 12000; i++) {
                window.__lifestyle.update(1 / 60);
                if (i % 12 === 0) await new Promise((r) => setTimeout(r, 0));
            }
        }""")
        page.wait_for_timeout(800)

        page.click('#edit-toggle')
        page.wait_for_timeout(400)
        page.click('#ed-logs')
        page.wait_for_timeout(600)
        page.click('#cl-recent .cl-row.complete')
        page.wait_for_timeout(600)

        info = page.evaluate("""() => ({
            box: document.getElementById('editor').getBoundingClientRect().toJSON(),
            logs: !document.getElementById('conv-logs').hidden,
            rows: document.querySelectorAll('#cl-recent .cl-row').length,
            messages: document.querySelectorAll('#cl-detail .cl-msg').length,
        })""")
        print('panel:', json.dumps(info))

        page.add_style_tag(content="""
            #editor, #editor *, .cl-note, .cl-sub { font-family: 'Pixelify Sans', monospace !important; }
            #editor .cl-row-meta, #editor .cl-sub { font-size: 10px !important; }
            #conv-logs .cl-row, #conv-logs .cl-text { font-size: 12px !important; }
        """)
        page.wait_for_timeout(400)
        page.screenshot(path='artifacts/part2_logs_panel.png')
        print('wrote artifacts/part2_logs_panel.png')
        browser.close()


if __name__ == '__main__':
    main()
