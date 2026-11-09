// The relationship debug panel.
//
// Every villager keeps a private opinion of every other villager, and those numbers are
// what decide who walks over to whom and how a chat lands. The conversation logs show
// what one talk changed; this panel shows the whole social graph as it stands: warmth,
// trust, familiarity, dislike, how many talks and when the last one was, plus whether
// Supabase has accepted the row yet.
//
// Read-only on purpose. Editing a relationship from a menu would make the village
// theatre instead of a simulation.

import { ensureDock, focusPanel } from './dock.js';

const REFRESH_MS = 1200;

function nameMap(roster) {
  const map = new Map();
  for (const entry of roster || []) map.set(entry.id, entry.name || entry.id);
  return map;
}

function warmthClass(score, category) {
  if (category === 'enemy' || category === 'disliked' || score <= -12) return 'cat-cold';
  if (score >= 28) return 'cat-warm';
  return 'cat-cool';
}

function when(iso) {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

const num = (value) => Number(Number(value) || 0).toFixed(2);

export function createRelPanel({ relationships, roster = [], conversations = null }) {
  if (!relationships) return null;

  const dock = ensureDock();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ed-btn';
  button.id = 'ed-rel';
  button.dataset.panel = 'rel-panel';
  button.textContent = 'Relations';
  button.title = 'Every villager\'s opinion of every other villager';
  dock.buttons.appendChild(button);

  const section = document.createElement('div');
  section.id = 'rel-panel';
  section.className = 'dock-panel';
  section.hidden = true;
  section.innerHTML = `
    <div class="cl-head">
      <span class="cl-title">Relationships</span>
      <span class="cl-live" id="rel-count"></span>
    </div>
    <div class="cl-filters">
      <select class="cl-select" id="rel-npc" aria-label="Filter by villager"></select>
      <select class="cl-select" id="rel-sort" aria-label="Sort relationships">
        <option value="warm">warmest first</option>
        <option value="cold">coldest first</option>
        <option value="recent">most recent</option>
        <option value="pair">by name</option>
      </select>
    </div>
    <div class="rel-legend">A → B is how A sees B. Warmth 0 is neutral; below −12 is disliked.</div>
    <div class="rel-list" id="rel-list"></div>
    <div class="cl-note" id="rel-note"></div>
  `;
  dock.panels.appendChild(section);

  const list = section.querySelector('#rel-list');
  const countEl = section.querySelector('#rel-count');
  const noteEl = section.querySelector('#rel-note');
  const npcFilter = section.querySelector('#rel-npc');
  const sortSelect = section.querySelector('#rel-sort');

  const names = nameMap(roster);
  const label = (id) => names.get(id) || id;

  npcFilter.innerHTML = '<option value="all">All villagers</option>';
  for (const entry of roster) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    npcFilter.appendChild(option);
  }

  function liveLine() {
    if (!conversations) return '';
    const active = conversations.active();
    if (!active.length) return '';
    const pairs = active.map((session) => {
      const pair = session.participants.map((participant) => participant.name).join(' & ');
      return session.mood === 'tense' ? `${pair} (tense)` : pair;
    });
    return `talking now: ${pairs.join(', ')}`;
  }

  function rows() {
    const filter = npcFilter.value;
    let items = relationships.snapshot();
    if (filter !== 'all') items = items.filter((record) => record.npcId === filter || record.otherId === filter);
    // A stable secondary sort stops rows from jumping about while the village talks.
    const byPair = (a, b) => label(a.npcId).localeCompare(label(b.npcId))
      || label(a.otherId).localeCompare(label(b.otherId));
    const sort = sortSelect.value;
    if (sort === 'cold') items.sort((a, b) => a.score - b.score || byPair(a, b));
    else if (sort === 'recent') {
      items.sort((a, b) => String(b.lastInteraction || '').localeCompare(String(a.lastInteraction || '')) || byPair(a, b));
    } else if (sort === 'pair') items.sort(byPair);
    else items.sort((a, b) => b.score - a.score || byPair(a, b));
    return items;
  }

  function rowFor(record) {
    const row = document.createElement('div');
    row.className = 'rel-row';

    const score = Math.round(record.score);
    const head = document.createElement('div');
    head.className = 'rel-head';
    const namesEl = document.createElement('span');
    namesEl.textContent = `${label(record.npcId)} → ${label(record.otherId)}`;
    const category = document.createElement('span');
    category.className = `rel-cat ${warmthClass(score, record.category)}`;
    category.textContent = record.category;
    head.append(namesEl, category);

    const meta = document.createElement('div');
    meta.className = 'rel-meta';
    meta.textContent = [
      `warmth ${score}`,
      `trust ${num(record.trust)}`,
      `know ${num(record.familiarity)}`,
      `dislike ${num(record.dislike)}`,
      `${record.interactions} talk${record.interactions === 1 ? '' : 's'}`,
      when(record.lastInteraction),
      record.synced ? 'saved' : 'pending',
    ].join(' · ');

    const bar = document.createElement('div');
    bar.className = 'rel-bar';
    const fill = document.createElement('i');
    fill.className = `rel-fill ${score < 0 ? 'neg' : 'pos'}`;
    fill.style.width = `${Math.min(50, Math.abs(score) / 2)}%`;
    if (score < 0) fill.style.right = '50%';
    else fill.style.left = '50%';
    bar.appendChild(fill);

    row.append(head, meta, bar);
    if (record.notes) {
      const note = document.createElement('div');
      note.className = 'cl-sub';
      note.textContent = record.notes;
      row.append(note);
    }
    return row;
  }

  function render() {
    const items = rows();
    const all = relationships.snapshot();
    const sour = all.filter((record) => record.category === 'disliked' || record.category === 'enemy').length;
    const pending = all.filter((record) => !record.synced).length;
    countEl.textContent = [
      `${all.length} pairs`,
      sour ? `${sour} sour` : '',
      pending ? `${pending} unsaved` : '',
    ].filter(Boolean).join(' · ');

    list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'rel-empty';
      empty.textContent = 'No relationships recorded yet.';
      list.appendChild(empty);
    }
    for (const record of items) list.appendChild(rowFor(record));

    const status = relationships.status();
    noteEl.textContent = [
      status.loadedFromServer ? 'loaded from Supabase' : 'local only',
      `${status.saves || 0} saved`,
      status.pending ? `${status.pending} pending` : '',
      status.persistBlocked ? 'persistence off' : '',
      status.loadError ? `load: ${status.loadError}` : '',
      status.saveError ? `save: ${status.saveError}` : '',
      liveLine(),
    ].filter(Boolean).join(' · ');
  }

  button.addEventListener('click', () => {
    section.hidden = !section.hidden;
    button.classList.toggle('is-on', !section.hidden);
    if (!section.hidden) {
      focusPanel(section);
      render();
    }
  });

  const timer = setInterval(() => {
    if (!section.hidden) render();
  }, REFRESH_MS);

  return {
    button,
    section,
    open() {
      section.hidden = false;
      button.classList.add('is-on');
      render();
    },
    close() {
      section.hidden = true;
      button.classList.remove('is-on');
    },
    refresh: render,
    stop: () => clearInterval(timer),
  };
}
