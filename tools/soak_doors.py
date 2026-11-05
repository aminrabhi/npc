"""Watch the village for a while and report doorway and collision faults.

Samples every villager inside the browser for a fixed time and reports:

  * door errands abandoned before the villager got inside
  * position jumps (teleports) that are not the door transition itself
  * samples where a villager stands on a blocked tile without being indoors
  * samples where a villager idles on a doorway tile (body over the house front)
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/index.html'
SECONDS = 75

START = """() => {
  const npcs = [];
  for (let i = 0; i < 20; i++) {
    const n = window.__npc(i);
    if (!n) break;
    npcs.push(n);
  }
  const doors = new Set(window.__rooms().map((r) => r.door.join(',')));
  const s = window.__soak = {
    failures: [], jumps: [], blocked: [], doors: [],
    enters: 0, exits: 0, samples: 0, maxDoorStreak: 0,
  };
  const prev = npcs.map((n) => ({ x: n.x, y: n.y, st: 'out' }));
  const streak = npcs.map(() => 0);
  s.timer = setInterval(() => {
    const dbg = window.__debug();
    s.samples++;
    npcs.forEach((n, i) => {
      const st = n.room ? 'inside' : (n.pendingRoom ? 'pending' : 'out');
      const p = prev[i];
      const tile = [Math.floor(n.x / 16), Math.floor(n.y / 16)];
      const jump = Math.hypot(n.x - p.x, n.y - p.y);
      if (jump > 14) {
        s.jumps.push({ i, dx: +(n.x - p.x).toFixed(1), dy: +(n.y - p.y).toFixed(1), from: p.st, to: st });
      }
      if (p.st === 'pending' && st === 'out') {
        s.failures.push({
          i,
          tile,
          door: n.approach ? [n.approach.x, n.approach.y] : null,
          path: n.path.length,
        });
      }
      if (p.st === 'out' && st === 'inside') s.enters++;
      if (p.st === 'inside' && st === 'out') s.exits++;
      if (st !== 'inside' && dbg[i] && dbg[i].blocked) s.blocked.push({ i, tile });
      if (st === 'out' && doors.has(tile.join(','))) {
        s.doors.push({ i, tile });
        streak[i]++;
        if (streak[i] > s.maxDoorStreak) s.maxDoorStreak = streak[i];
      } else {
        streak[i] = 0;
      }
      prev[i] = { x: n.x, y: n.y, st };
    });
  }, 60);
  return npcs.length;
}"""

END = """() => {
  clearInterval(window.__soak.timer);
  return window.__soak;
}"""


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1280, 'height': 800}, device_scale_factor=1)
        page.set_default_timeout(60000)
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function('!!(window.__npc && window.__room && window.__rooms)')
        count = page.evaluate(START)
        print(f'watched {count} villagers for {SECONDS}s')
        page.wait_for_timeout(SECONDS * 1000)
        s = page.evaluate(END)
        browser.close()

    print('samples:', s['samples'], '| enters:', s['enters'], '| exits:', s['exits'],
          '| longest doorway stay:', s['maxDoorStreak'], 'samples (~%.2fs)' % (s['maxDoorStreak'] * 0.06))
    for key in ('failures', 'jumps', 'blocked', 'doors'):
        items = s[key]
        print(f'{key}: {len(items)}')
        for item in items[:6]:
            print('   ', json.dumps(item))
    print('console errors:', errors[:3])
    if s['failures'] or s['blocked'] or s['jumps']:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
