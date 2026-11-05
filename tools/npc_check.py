"""Checks the npc studio, the villagers' idle-first behaviour and the roster export."""

import json

from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/index.html'

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function('!!(window.__studio && window.__npcs && window.__debug)', timeout=30000)
    page.wait_for_timeout(1500)

    roster = page.evaluate('window.__npcs()')
    print('roster:', len(roster), [r['name'] for r in roster][:3], '...')
    print('first entry:', json.dumps(roster[0])[:200])

    # behaviour: how much of the time are they actually walking?
    samples = []
    for _ in range(70):
        samples.append(page.evaluate('window.__debug()'))
        page.wait_for_timeout(160)
    moving = sum(1 for s in samples for n in s if n['moving'])
    total = sum(len(s) for s in samples)
    far = max(
        abs(n['home'][0] - round(n['x'] / 16)) + abs(n['home'][1] - round(n['y'] / 16))
        for s in samples for n in s
    )
    print('walking %d/%d samples (%.0f%%), furthest from home: %d tiles'
          % (moving, total, 100 * moving / total, far))
    print('blocked samples:', sum(1 for s in samples for n in s if n['blocked']))
    print('names on every villager:', all(n['name'] for n in samples[-1]))

    page.click('#npc-toggle')
    page.wait_for_timeout(600)
    info = page.evaluate('''() => ({
      visible: !document.querySelector('#npc-studio').hidden,
      roster: document.querySelectorAll('.np-roster-btn').length,
      bodies: document.querySelectorAll('#np-body .np-opt').length,
      hairs: document.querySelectorAll('#np-hair .np-opt').length,
      hands: document.querySelectorAll('#np-hand .np-opt').length,
      previewPixels: (() => {
        const c = document.querySelector('#np-preview');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
        return n;
      })(),
      fontLoaded: document.fonts.check('8px "Pixelify Sans"'),
    })''')
    print('studio:', info)
    page.screenshot(path='artifacts/npc_studio.png')

    page.evaluate('''() => {
      const el = document.querySelector('#np-name');
      el.value = 'Marla Q.';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }''')
    page.wait_for_timeout(250)
    page.click('#np-hair .np-opt:nth-child(4)')
    page.wait_for_timeout(350)
    print('edited:', page.evaluate('''() => {
      const cfg = window.__npcs()[0];
      return { cfgName: cfg.name, cfgHair: cfg.hair, npcName: window.__npc(0).name,
               label: document.querySelector('#np-roster .np-roster-btn').textContent };
    }'''))

    code = page.evaluate('window.__studio.rosterJson()')
    parsed = json.loads(code)
    print('export: v=%s npcs=%d keys=%s'
          % (parsed['v'], len(parsed['npcs']), sorted(parsed['npcs'][0].keys())))

    page.click('#npc-toggle')
    page.wait_for_timeout(500)
    page.screenshot(path='artifacts/npc_names.png')
    browser.close()

errs = [e for e in errors if 'favicon' not in e.lower()]
print('console errors:', errs if errs else 'none')
