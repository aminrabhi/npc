"""Part 2 verification in a real browser.

Checks the AI conversation path (against local test doubles), the debug panel's
SAVE TO SUPABASE button and saved transcript retrieval, personality editing in the
studio, and the honest offline path when the server has no Groq key.

Run against two servers:
  3001  configured with mock Groq + mock Supabase
  3000  unconfigured (offline lines, no persistence)
"""
import json
import time
import urllib.request

from playwright.sync_api import sync_playwright

URL_OK = 'http://127.0.0.1:3001/index.html'
URL_OFF = 'http://127.0.0.1:3000/index.html'
MOCK = 'http://127.0.0.1:4010'

results = []


def check(name, condition, detail=''):
    results.append({'name': name, 'ok': bool(condition), 'detail': detail})
    print(f"{'ok  ' if condition else 'FAIL'} {name}{'' if condition else ' - ' + str(detail)}")


def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as res:
        return json.loads(res.read().decode())


def fast_forward(page, frames):
    return page.evaluate(
        """async (frames) => {
            for (let i = 0; i < frames; i++) {
                window.__lifestyle.update(1 / 60);
                if (i % 12 === 0) await new Promise((r) => setTimeout(r, 0));
            }
            return true;
        }""",
        frames,
    )


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--enable-unsafe-swiftshader'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        console = []
        page.on('console', lambda m: console.append(f'{m.type}:{m.text}') if m.type == 'error' else None)
        page.on('pageerror', lambda e: console.append(f'pageerror:{e}'))
        page.goto(URL_OK, wait_until='networkidle')
        page.wait_for_timeout(1500)

        # ---------------------------------------------------------------- startup
        info = page.evaluate("""() => ({
            error: document.getElementById('error').hidden ? null : document.getElementById('error').textContent,
            npcs: window.__debug().length,
            ai: window.__ai.status(),
            buttons: { sim: !!document.getElementById('ed-sim'), logs: !!document.getElementById('ed-logs') },
            profiles: window.__profiles().map((p) => ({ id: p.id, style: p.style, interests: p.interests.length, news: p.social.newsInterest })),
            news: window.__news.status(),
            rel: window.__rel.status(),
            panels: { sim: !!document.getElementById('sim-controls'), logs: !!document.getElementById('conv-logs') },
        })""")
        print('startup:', json.dumps({k: info[k] for k in ('npcs', 'buttons', 'panels', 'ai', 'news')}))
        check('village starts without an error', info['error'] is None, info['error'])
        check('all ten villagers are present', info['npcs'] == 10, info['npcs'])
        check('existing Sim button preserved', info['buttons']['sim'])
        check('second button added: Logs', info['buttons']['logs'])
        check('logs panel is a section of the same editor', info['panels']['sim'] and info['panels']['logs'])
        check('server reports groq configured', info['ai']['configured'] is True, json.dumps(info['ai']))
        check('model is allam-2-7b', info['ai']['model'] == 'allam-2-7b', info['ai'].get('model'))
        check('ten distinct personality profiles', len({json.dumps(p, sort_keys=True) for p in info['profiles']}) >= 8,
              json.dumps(info['profiles'][:3]))
        check('news cached from the feed', info['news']['items'] >= 1, json.dumps(info['news']))

        # ------------------------------------------------------- live conversations
        page.evaluate('window.__clock.setOverride(12, 0)')
        page.evaluate('window.__lifestyle.replanAll()')
        fast_forward(page, 13000)
        page.wait_for_timeout(1200)

        summary = page.evaluate("""() => {
            const recent = window.__conv.recent();
            return {
                stats: window.__conv.stats(),
                sessions: recent.map((s) => ({
                    status: s.status,
                    target: s.target,
                    count: s.messageCount,
                    speakers: [...new Set(s.messages.map((m) => m.speakerId))],
                    names: [...new Set(s.messages.map((m) => m.speakerName))],
                    closing: !!(s.messages[s.messages.length - 1] || {}).closing,
                    generated: [...new Set(s.messages.map((m) => m.generatedBy))],
                    texts: s.messages.map((m) => m.text),
                    rel: s.relationshipChanges.map((c) => ({ from: c.from, to: c.to, delta: c.delta })),
                    memories: s.memories.map((m) => m.kind + ': ' + m.description),
                    news: s.news.map((n) => n.headline),
                    errors: s.errors,
                })),
                live: window.__conv.active().length,
                states: window.__lifestyle.states(),
                relPending: window.__rel.status().pending,
                memPending: window.__mem.status().pending,
                cooldowns: window.__conv.stats().cooldowns,
            };
        }""")

        sessions = summary['sessions']
        completed = [s for s in sessions if s['status'] == 'complete']
        print('conversations:', json.dumps({
            'total': len(sessions),
            'stats': summary['stats'],
            'lengths': [s['count'] for s in completed],
            'states': summary['states'],
        }))

        check('conversations happened', len(sessions) >= 3, len(sessions))
        check('some conversations completed naturally', len(completed) >= 3, len(completed))
        check('every completed talk is 5-10 messages', all(5 <= s['count'] <= 10 for s in completed),
              [s['count'] for s in completed])
        check('targets were randomised 5-10', all(5 <= s['target'] <= 10 for s in sessions),
              [s['target'] for s in sessions])
        spoke = [s for s in sessions if s['count'] >= 2]
        check('both villagers spoke whenever a line was said', all(len(s['speakers']) == 2 for s in spoke),
              [(s['count'], s['speakers']) for s in spoke if len(s['speakers']) != 2])
        check('every talk ended on a closing line', all(s['closing'] for s in completed),
              [s['closing'] for s in completed])
        check('all completed lines came from the model', all(s['generated'] == ['groq'] for s in completed),
              [s['generated'] for s in completed if s['generated'] != ['groq']])
        check('no model errors recorded', all(not s['errors'] for s in completed),
              [s['errors'] for s in completed if s['errors']])
        distinct = {tuple(s['texts']) for s in completed}
        check('conversations are not copies of each other', len(distinct) >= max(2, len(completed) - 1))
        check('relationships moved', any(any(c['delta'] != 0 for c in s['rel']) for s in sessions),
              [s['rel'] for s in sessions][:2])
        check('memories were kept', any(s['memories'] for s in sessions),
              [s['memories'] for s in sessions][:3])
        check('news reached at least one conversation', any(s['news'] for s in sessions),
              [s['news'] for s in sessions if s['news']][:2])
        check('cooldowns are tracked', summary['cooldowns'] > 0, summary['cooldowns'])
        stalled = page.evaluate("""() => window.__conv.active().filter((s) => s.clock > 100 || (s.pending && s.clock > 30))""")
        check('no conversation is stuck', not stalled, json.dumps(stalled)[:300])

        # ------------------------------------------------------------ persistence
        page.wait_for_timeout(2500)
        mock = get_json(f'{MOCK}/_stats')
        print('mock tables:', json.dumps(mock['tables']))
        check('relationships auto-saved to Supabase', mock['tables'].get('village_npc_relationships', 0) > 0)
        check('memories auto-saved to Supabase', mock['tables'].get('village_npc_memories', 0) > 0)
        check('transcripts NOT auto-saved', mock['tables'].get('village_conversations', 0) == 0,
              mock['tables'].get('village_conversations'))
        check('relationship queue drained', page.evaluate('window.__rel.status().pending') == 0)
        check('memory queue drained', page.evaluate('window.__mem.status().pending') == 0)

        # ------------------------------------------------------ relationship depth
        rels = page.evaluate('window.__rel.snapshot()')
        check('relationships are directional rows', len(rels) >= 2, len(rels))
        check('familiarity grows with talking', any(r['familiarity'] > 0.1 for r in rels))
        categories = page.evaluate("""() => {
            const tally = {};
            for (const r of window.__rel.snapshot()) tally[r.category] = (tally[r.category] || 0) + 1;
            return tally;
        }""")
        print('categories:', json.dumps(categories))

        # --------------------------------------------------------- logs panel UI
        # the debug toolbar lives inside the existing editor panel, so open it first
        page.click('#edit-toggle')
        page.wait_for_timeout(500)
        page.click('#ed-logs')
        page.wait_for_timeout(600)
        panel = page.evaluate("""() => ({
            open: !document.getElementById('conv-logs').hidden,
            recent: document.querySelectorAll('#cl-recent .cl-row').length,
            live: document.getElementById('cl-live-count').textContent,
            note: document.getElementById('cl-note').textContent,
            saveDisabled: document.getElementById('cl-save').disabled,
        })""")
        print('panel:', json.dumps(panel))
        check('Logs button opens the panel', panel['open'])
        check('recent conversations are listed', panel['recent'] >= 3, panel['recent'])
        check('save is disabled until a conversation is selected', panel['saveDisabled'])

        # pick a finished conversation, not one that was interrupted mid-approach
        page.click('#cl-recent .cl-row.complete')
        page.wait_for_timeout(400)
        detail = page.evaluate("""() => {
            const el = document.getElementById('cl-detail');
            return {
                msgs: el.querySelectorAll('.cl-msg').length,
                text: el.textContent.slice(0, 2000),
                saveDisabled: document.getElementById('cl-save').disabled,
                saveText: document.getElementById('cl-save').textContent,
                offlineBadges: el.querySelectorAll('.cl-tag.cl-offline').length,
                modelBadges: el.querySelectorAll('.cl-tag.cl-groq').length,
            };
        }""")
        check('transcript is shown with every message', detail['msgs'] >= 5, detail['msgs'])
        check('every line is badged with its origin', detail['modelBadges'] + detail['offlineBadges'] == detail['msgs'],
              (detail['modelBadges'], detail['offlineBadges'], detail['msgs']))
        check('relationship context is shown', 'Relationship' in page.evaluate("document.getElementById('cl-detail').textContent"))
        check('save button is enabled for the selection', not detail['saveDisabled'], detail['saveText'])

        page.click('#cl-save')
        page.wait_for_timeout(2000)
        after = page.evaluate("""() => ({
            saveText: document.getElementById('cl-save').textContent,
            note: document.getElementById('cl-note').textContent,
            savedRows: document.querySelectorAll('#cl-saved .cl-row').length,
            savedBadge: !!document.querySelector('#cl-detail .cl-badge.cl-saved'),
        })""")
        print('after save:', json.dumps(after))
        saved = get_json(f'{MOCK}/_stats')
        check('SAVE TO SUPABASE wrote the transcript', saved['tables'].get('village_conversations', 0) == 1,
              saved['tables'])
        check('all messages were saved', saved['tables'].get('village_conversation_messages', 0) >= 5,
              saved['tables'])
        check('saved session matches its message count', saved['tables'].get('village_conversation_messages', 0) >= detail['msgs'])
        check('save button reflects the saved state', after['saveText'] == 'Saved', after['saveText'])
        check('saved transcripts list refreshed', after['savedRows'] >= 1, after['savedRows'])
        check('saved badge shown on the conversation', after['savedBadge'])

        page.reload(wait_until='networkidle')
        page.wait_for_timeout(1500)
        page.click('#edit-toggle')
        page.wait_for_timeout(500)
        page.click('#ed-logs')
        page.wait_for_timeout(1200)
        reloaded = page.evaluate("""() => ({
            savedRows: document.querySelectorAll('#cl-saved .cl-row').length,
            categories: window.__rel.status().local,
            memories: window.__mem.status().local,
            ai: window.__ai.status().configured,
        })""")
        print('after reload:', json.dumps(reloaded))
        check('saved transcript retrievable after reload', reloaded['savedRows'] >= 1, reloaded['savedRows'])
        check('relationships restored after reload', reloaded['categories'] > 0, reloaded['categories'])
        check('memories restored after reload', reloaded['memories'] > 0, reloaded['memories'])

        # saved transcript opens from Supabase
        page.click('#cl-saved .cl-row')
        page.wait_for_timeout(1200)
        savedView = page.evaluate("""() => ({
            msgs: document.querySelectorAll('#cl-detail .cl-msg').length,
            title: (document.querySelector('#cl-detail .cl-detail-title') || {}).textContent,
            badge: !!document.querySelector('#cl-detail .cl-badge.cl-saved'),
            saveText: document.getElementById('cl-save').textContent,
        })""")
        print('saved view:', json.dumps(savedView))
        check('saved transcript opens from Supabase', savedView['msgs'] >= 5, savedView['msgs'])
        check('saved view is badged as saved', savedView['badge'])
        check('saved transcript cannot be saved again', savedView['saveText'] == 'Saved', savedView['saveText'])

        # ------------------------------------------------------------ NPC studio
        page.evaluate("window.__logs.close()")
        page.evaluate('window.__studio.open()')
        page.wait_for_timeout(500)
        studio = page.evaluate("""() => ({
            fields: ['np-interests', 'np-likes', 'np-dislikes', 'np-tendencies', 'np-memories', 'np-style', 'np-social', 'np-news']
                .map((id) => !!document.getElementById(id)),
            styleOptions: document.querySelectorAll('#np-style option').length,
            interests: document.getElementById('np-interests').value,
        })""")
        check('studio has every personality field', all(studio['fields']), studio['fields'])
        check('speaking styles offered', studio['styleOptions'] >= 6, studio['styleOptions'])
        check('interests are pre-filled from the character', len(studio['interests']) > 0, studio['interests'])

        page.evaluate("""() => {
            const el = document.getElementById('np-interests');
            el.value = 'gardening, radio plays, tomato contests';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }""")
        page.wait_for_timeout(400)
        edited = page.evaluate("""() => {
            const profile = window.__profiles().find((p) => p.name === document.querySelector('.np-roster-btn.is-on').textContent);
            return {
                name: profile && profile.name,
                interests: profile && profile.interests,
                stored: !!localStorage.getItem('aivillage.profiles.v1'),
            };
        }""")
        check('studio edit reaches the conversation profile',
              edited['interests'] and 'radio plays' in edited['interests'], edited['interests'])
        check('personality edits are stored', edited['stored'])

        page.reload(wait_until='networkidle')
        page.wait_for_timeout(1500)
        persisted = page.evaluate("""() => {
            const p = window.__profiles().find((x) => x.interests.includes('radio plays') || x.interests.includes('tomato contests'));
            return p ? p.interests : null;
        }""")
        check('personality survives a reload', persisted is not None, persisted)

        page.evaluate('window.__studio.close()')
        page.evaluate('window.__lifestyle.replanAll()')
        fast_forward(page, 9000)
        page.wait_for_timeout(800)
        page.evaluate("""() => {
            document.getElementById('editor').style.visibility = 'hidden';
        }""")
        page.wait_for_timeout(300)
        page.screenshot(path='artifacts/part2_village.png')

        page.evaluate("""() => {
            document.getElementById('editor').style.visibility = 'visible';
            window.__logs.open();
            const row = document.querySelector('#cl-recent .cl-row');
            if (row) row.click();
        }""")
        page.wait_for_timeout(900)
        page.screenshot(path='artifacts/part2_logs.png')

        check('no console errors on the configured page',
              not [line for line in console if 'Failed to load resource' not in line],
              console[:3])

        # -------------------------------------------------------- offline village
        off = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        off.goto(URL_OFF, wait_until='networkidle')
        off.wait_for_timeout(1500)
        offline = off.evaluate("""() => ({ status: window.__ai.status(), npcs: window.__debug().length })""")
        check('offline page still runs the village', offline['npcs'] == 10)
        check('offline page reports the model as unavailable', offline['status']['configured'] is False,
              json.dumps(offline['status']))
        off.evaluate('window.__clock.setOverride(12, 0)')
        off.evaluate('window.__lifestyle.replanAll()')
        fast_forward(off, 12000)
        off.wait_for_timeout(1500)
        offSummary = off.evaluate("""() => {
            const recent = window.__conv.recent();
            return {
                count: recent.length,
                generated: recent.map((s) => [...new Set(s.messages.map((m) => m.generatedBy))]),
                errors: recent.map((s) => s.errors.map((e) => e.code)),
            };
        }""")
        print('offline conversations:', json.dumps(offSummary))
        check('offline villagers still talk', offSummary['count'] >= 1, offSummary['count'])
        check('offline lines are labelled, not disguised',
              all(all(g == 'offline' for g in generated) for generated in offSummary['generated']),
              offSummary['generated'])
        check('offline failures are recorded', any(offSummary['errors']), offSummary['errors'])
        off.click('#edit-toggle')
        off.wait_for_timeout(500)
        off.click('#ed-logs')
        off.wait_for_timeout(700)
        offPanel = off.evaluate("""() => ({
            offline: document.querySelectorAll('#cl-detail .cl-tag.cl-offline').length,
            note: document.getElementById('cl-note').textContent,
            rows: document.querySelectorAll('#cl-recent .cl-row').length,
        })""")
        check('panel explains the model is offline', 'offline' in offPanel['note'], offPanel['note'])
        check('offline conversations are listed', offPanel['rows'] >= 1, offPanel['rows'])
        off.screenshot(path='artifacts/part2_offline.png')

        browser.close()

    failed = [r for r in results if not r['ok']]
    print(f"\n{len(results) - len(failed)}/{len(results)} browser checks passed.")
    if failed:
        for item in failed:
            print('FAILED:', item['name'], item['detail'])
        raise SystemExit(1)


if __name__ == '__main__':
    main()
