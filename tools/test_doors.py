"""End-to-end check of doorway trips.

A villager heading for a door must arrive at the middle of the door tile, must only
step inside from the doorway itself (never warping in from elsewhere), must stay
inside the room while it is there, and must walk back out through the same door.
"""
import sys

from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/index.html'
T = 16
SPRITE_TOP = 18  # tallest hair row, measured in px above the sprite's feet


def main():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1280, 'height': 800}, device_scale_factor=1)
        page.set_default_timeout(60000)
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        # note the !!(...): wait_for_function calls the expression when it evaluates
        # to a function, so a bare `&&` chain ending in a hook would never pass
        page.wait_for_function('!!(window.__visitRoom && window.__npc && window.__room)')

        rooms = page.evaluate('window.__rooms()')
        print('rooms:', [(r['door'], r['w'], r['h']) for r in rooms])
        assert rooms, 'map has no rooms'

        chosen = None
        for i in range(len(rooms)):
            if page.evaluate(f'window.__visitRoom({i})'):
                chosen = i
                break
        assert chosen is not None, 'no room is reachable from the villager spawn'

        room = rooms[chosen]
        door_x, door_y = room['door']
        print('visiting room', chosen, 'through door', (door_x, door_y))

        # ---------------------------------------------------------- walking in
        page.wait_for_function('window.__npc(0).room !== null', timeout=40000)
        pos = page.evaluate('() => ({ x: window.__npc(0).x, y: window.__npc(0).y })')
        tile = (int(pos['x'] // T), int(pos['y'] // T))
        print('stepped in at', (round(pos['x'], 1), round(pos['y'], 1)), 'tile', tile)
        assert tile == (door_x, door_y), f'wrong entry spot {tile}, door is {(door_x, door_y)}'
        dx = pos['x'] - (door_x * T + T / 2)
        dy = pos['y'] - (door_y * T + T / 2)
        assert abs(dx) <= 1 and abs(dy) <= 1, f'not centred on the door tile: ({dx}, {dy})'
        page.screenshot(path='artifacts/door_inside.png')

        # ------------------------------------------------ behaviour while inside
        samples = page.evaluate("""async () => {
          const out = [];
          for (let i = 0; i < 250; i++) {
            const n = window.__npc(0);
            out.push({ inside: n.room !== null, x: n.x, y: n.y });
            if (!n.room && i > 8) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          return out;
        }""")
        inside = [s for s in samples if s['inside']]
        left = [s for s in samples if not s['inside']]
        print('samples inside:', len(inside), '| after leaving:', len(left))
        assert inside, 'never got inside'

        rx, ry, rw, rh = room['x'], room['y'], room['w'], room['h']
        stray = [s for s in inside
                 if not (rx * T - 1 <= s['x'] <= (rx + rw) * T + 1
                         and ry * T - 1 <= s['y'] <= (ry + rh) * T + 1)]
        assert not stray, f'villager left the room while inside: {stray[:3]}'

        big = [(a, b) for a, b in zip(inside, inside[1:])
               if abs(b['x'] - a['x']) > 12 or abs(b['y'] - a['y']) > 12]
        print('teleports while inside:', len(big))
        assert not big, f'villager jumped while inside: {big[:2]}'

        # --------------------------------------------------------- walking out
        assert left, 'villager never came back out'
        exit_tile = (int(left[0]['x'] // T), int(left[0]['y'] // T))
        print('left through', exit_tile)
        assert (abs(exit_tile[0] - door_x) <= 1 and abs(exit_tile[1] - door_y) <= 1), \
            f'left from {exit_tile}, away from door {(door_x, door_y)}'

        # ... then walks clear of the doorway, so the sprite stops overlapping the house
        page.wait_for_function(
            'window.__npc(0).room === null && window.__npc(0).path.length === 0', timeout=25000)
        rest = page.evaluate('() => ({ x: window.__npc(0).x, y: window.__npc(0).y })')
        rest_tile = (int(rest['x'] // T), int(rest['y'] // T))
        body_top = rest['y'] - SPRITE_TOP
        print('walked out to', rest_tile, '- body top', round(body_top, 1))
        assert rest_tile != (door_x, door_y), 'still standing in the doorway after leaving'
        assert body_top >= (door_y + 1) * T, f'body still overlaps the door row: top {body_top}'

        # --------------------------------- a cancelled errand must not warp anyone
        page.evaluate("""() => {
          const n = window.__npc(0);
          n.room = null;
          n.insideTarget = null;
          n.pendingRoom = window.__room(0);
          n.approach = { x: 10, y: 26 };
          n.path = [];
          n.waitTime = 0;
          n.x = 2 * 16 + 8;
          n.y = 26 * 16 + 8;
        }""")
        page.wait_for_timeout(700)
        state = page.evaluate("""() => ({
          room: window.__npc(0).room !== null,
          pending: window.__npc(0).pendingRoom !== null,
          approach: window.__npc(0).approach,
          x: window.__npc(0).x,
          y: window.__npc(0).y,
        })""")
        print('after a cancelled door errand:', {k: state[k] for k in ('room', 'pending', 'approach')})
        assert not state['room'], 'villager warped inside without reaching the doorway'
        # The lifestyle machine plans its own errands, so pendingRoom may be set again;
        # the stale approach from the cancelled errand must be gone either way.
        stale = state['approach'] == {'x': 10, 'y': 26}
        assert not stale, 'cancelled door errand was kept'

        browser.close()

    print('console errors:', errors[:3])
    assert not errors, errors[:3]
    print('DOOR TEST PASSED')


if __name__ == '__main__':
    try:
        main()
    except AssertionError as exc:
        print('DOOR TEST FAILED:', exc)
        sys.exit(1)
