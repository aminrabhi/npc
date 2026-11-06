// Scripted conversations, fights and hand items, all from the debug dock.
//
// This panel exists so a conversation can be written by hand and watched: choose
// two villagers, type one line per row, and the same bubble that normally carries
// generated dialogue plays the script back. "Force argument" runs a short row that
// rolls straight into a fight, and "Force fight" skips the warm-up, which is the
// quickest way to see both villagers holding swords.

import { ensureDock, focusPanel } from './dock.js';

export function createScriptPanel({ roster = [], social, getNpcs }) {
  if (!social) return null;
  const dock = ensureDock();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ed-btn';
  button.id = 'ed-script';
  button.dataset.panel = 'script-panel';
  button.textContent = 'Script';
  button.title = 'Script a conversation, force an argument or a fight';
  dock.buttons.appendChild(button);

  const section = document.createElement('div');
  section.id = 'script-panel';
  section.className = 'dock-panel';
  section.hidden = true;
  section.innerHTML = `
    <div class="sim-group">
      <div class="sim-head">
        <span class="sim-title">Scripted conversation</span>
        <span class="sim-note" id="script-status"></span>
      </div>
      <div class="sim-row">
        <select class="sim-select" id="script-a" aria-label="First villager"></select>
        <select class="sim-select" id="script-b" aria-label="Second villager"></select>
      </div>
      <textarea class="script-area" id="script-lines" rows="7" spellcheck="false" aria-label="Script lines"></textarea>
      <div class="sim-note">One row per line, written as Name: words. A row without a name simply alternates speakers.</div>
      <div class="sim-row">
        <button type="button" class="ed-btn" id="script-play">Play</button>
        <button type="button" class="ed-btn" id="script-stop">Stop</button>
      </div>
      <div class="sim-row">
        <button type="button" class="ed-btn" id="script-argue">Force argument</button>
        <button type="button" class="ed-btn" id="script-fight">Force fight</button>
      </div>
      <div class="sim-row">
        <button type="button" class="ed-btn" id="script-sword">Sword on A</button>
        <button type="button" class="ed-btn" id="script-empty">Empty hands</button>
      </div>
      <div class="sim-note">Force fight ignores relationships. A real conversation only turns into a fight between villagers who already dislike each other.</div>
      <div class="sim-note">Left click a villager to punish them, right click to pet them.</div>
    </div>
  `;
  dock.panels.appendChild(section);

  const selectA = section.querySelector('#script-a');
  const selectB = section.querySelector('#script-b');
  const area = section.querySelector('#script-lines');
  const status = section.querySelector('#script-status');
  const playBtn = section.querySelector('#script-play');
  const stopBtn = section.querySelector('#script-stop');
  const argueBtn = section.querySelector('#script-argue');
  const fightBtn = section.querySelector('#script-fight');
  const swordBtn = section.querySelector('#script-sword');
  const emptyBtn = section.querySelector('#script-empty');

  let filled = false;

  function fillSelect(select, previous) {
    const options = [{ id: '', label: 'Pick a villager' }]
      .concat(roster.map((entry) => ({ id: entry.id, label: entry.name })));
    select.innerHTML = '';
    for (const entry of options) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      select.appendChild(option);
    }
    if (previous && options.some((entry) => entry.id === previous)) select.value = previous;
    else if (options.length > 1) select.value = options[1].id;
    else select.value = '';
  }

  function refreshOptions() {
    const wasA = selectA.value;
    const wasB = selectB.value;
    fillSelect(selectA, wasA);
    fillSelect(selectB, wasB || (roster[1] ? roster[1].id : ''));
    if (roster[1] && selectB.value === selectA.value && roster.length > 2) {
      selectB.value = roster[2].id;
    }
    const a = npcById(selectA.value);
    const b = npcById(selectB.value);
    // Only seed the box once: reopening the panel must not overwrite a script that
    // was already typed into it.
    if (a && b && !filled) {
      area.value = defaultScript(a, b);
      filled = true;
    }
  }

  function npcById(id) {
    return getNpcs().find((npc) => npc.config && npc.config.id === id) || null;
  }

  function pair() {
    const a = npcById(selectA.value);
    const b = npcById(selectB.value);
    if (!a || !b || a === b) {
      note('Pick two different villagers.');
      return null;
    }
    return { a, b };
  }

  function note(text) {
    status.textContent = text;
  }

  function defaultScript(a, b) {
    const aName = a.name || 'A';
    const bName = b.name || 'B';
    return `${aName}: You moved my watering can.\n${bName}: It was in the way.\n${aName}: It is never in the way.`;
  }

  function syncStatus() {
    if (section.hidden) return;
    const state = social.status();
    if (state.fighting) {
      note(`fighting: ${state.fighters.join(' vs ')}`);
    } else if (state.stunned) {
      note(`${state.stunnedName} is dazed for a moment.`);
    } else if (state.scripting) {
      note(`playing ${state.scriptIndex}/${state.scriptLines}`);
    } else {
      note('idle');
    }
  }

  playBtn.addEventListener('click', () => {
    const chosen = pair();
    if (!chosen) return;
    const result = social.playScript(chosen.a, chosen.b, area.value);
    note(result.ok ? `playing ${result.lines} lines` : result.reason);
  });

  stopBtn.addEventListener('click', () => {
    social.stopAll();
    note('stopped');
  });

  argueBtn.addEventListener('click', () => {
    const chosen = pair();
    if (!chosen) return;
    const result = social.argue(chosen.a, chosen.b);
    note(result.ok ? 'argument started' : result.reason);
  });

  fightBtn.addEventListener('click', () => {
    const chosen = pair();
    if (!chosen) return;
    const result = social.startFight(chosen.a, chosen.b, { forced: true });
    note(result.ok ? 'fight started' : result.reason);
  });

  swordBtn.addEventListener('click', () => {
    const a = npcById(selectA.value);
    if (!a) return;
    a.heldItem = a.heldItem === 'sword' ? null : 'sword';
    note(a.heldItem ? `${a.name} is holding a sword.` : `${a.name} has empty hands.`);
  });

  emptyBtn.addEventListener('click', () => {
    for (const npc of getNpcs()) npc.heldItem = null;
    note('everyone has empty hands.');
  });

  button.addEventListener('click', () => {
    section.hidden = !section.hidden;
    button.classList.toggle('is-on', !section.hidden);
    if (!section.hidden) {
      focusPanel(section);
      refreshOptions();
      syncStatus();
    }
  });

  const statusTimer = setInterval(syncStatus, 600);
  if (statusTimer && typeof statusTimer.unref === 'function') statusTimer.unref();

  return {
    button,
    section,
    open() {
      section.hidden = false;
      button.classList.add('is-on');
      refreshOptions();
    },
  };
}
