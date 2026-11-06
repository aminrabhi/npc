// Simulation console.
//
// This used to be an extra button inside the tile editor's panel, which made it
// unreachable with the editor closed. It now lives in the debug dock (js/dock.js),
// beside the conversation logs and independent of both editors. The section holds the
// clock override and the weather override, which are deliberately independent:
// switching one off leaves the other alone.

import { CONDITIONS } from './weather.js';
import { ensureDock, focusPanel } from './dock.js';

const PRESETS = [
  { label: 'Morning', hours: 8, minutes: 0 },
  { label: 'Noon', hours: 12, minutes: 0 },
  { label: 'Evening', hours: 18, minutes: 0 },
  { label: 'Night', hours: 22, minutes: 0 },
  { label: 'Midnight', hours: 0, minutes: 0 },
];

const pad = (n) => String(n).padStart(2, '0');

export function createSimPanel({ clock, weather, lifestyle, getNpcs, ai = null, conversations = null }) {
  const dock = ensureDock();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ed-btn';
  button.id = 'ed-sim';
  button.dataset.panel = 'sim-controls';
  button.textContent = 'Console';
  button.title = 'Simulation console: time, weather and villager states';
  dock.buttons.appendChild(button);

  const section = document.createElement('div');
  section.id = 'sim-controls';
  section.className = 'dock-panel';
  section.hidden = true;
  section.innerHTML = `
    <div class="sim-group">
      <div class="sim-head">
        <span class="sim-title">Time</span>
        <label class="sim-check"><input type="checkbox" id="sim-time-on"> debug time</label>
      </div>
      <div class="sim-row">
        <input class="sim-num" id="sim-hour" type="number" min="0" max="23" step="1" value="8" aria-label="Hour">
        <span class="sim-colon">:</span>
        <input class="sim-num" id="sim-minute" type="number" min="0" max="59" step="1" value="0" aria-label="Minute">
        <button type="button" class="ed-btn" id="sim-time-apply">Set</button>
        <button type="button" class="ed-btn" id="sim-time-real">Real time</button>
      </div>
      <div class="sim-row" id="sim-presets"></div>
      <div class="sim-note" id="sim-time-note"></div>
    </div>

    <div class="sim-group">
      <div class="sim-head">
        <span class="sim-title">Weather</span>
        <label class="sim-check"><input type="checkbox" id="sim-weather-on"> debug weather</label>
      </div>
      <div class="sim-row">
        <select class="sim-select" id="sim-weather-code" aria-label="Weather"></select>
        <input class="sim-num" id="sim-temp" type="number" min="-40" max="60" step="1" placeholder="°C" aria-label="Temperature">
        <button type="button" class="ed-btn" id="sim-weather-live">Live</button>
      </div>
      <div class="sim-note" id="sim-weather-note"></div>
    </div>

    <div class="sim-group">
      <div class="sim-head"><span class="sim-title">Villagers</span><span class="sim-note" id="sim-states-note"></span></div>
      <div class="sim-villagers" id="sim-villagers"></div>
    </div>

    <div class="sim-group">
      <div class="sim-head">
        <span class="sim-title">Dialogue</span>
        <span class="sim-mode" id="sim-dialogue-mode">--</span>
      </div>
      <div class="sim-note" id="sim-dialogue-note"></div>
      <div class="sim-row">
        <button type="button" class="ed-btn" id="sim-dialogue-retry">Try Groq now</button>
      </div>
    </div>
  `;
  dock.panels.appendChild(section);

  const timeOn = section.querySelector('#sim-time-on');
  const hourInput = section.querySelector('#sim-hour');
  const minuteInput = section.querySelector('#sim-minute');
  const timeApply = section.querySelector('#sim-time-apply');
  const timeReal = section.querySelector('#sim-time-real');
  const timeNote = section.querySelector('#sim-time-note');
  const presetsRow = section.querySelector('#sim-presets');

  const weatherOn = section.querySelector('#sim-weather-on');
  const weatherCode = section.querySelector('#sim-weather-code');
  const tempInput = section.querySelector('#sim-temp');
  const weatherLive = section.querySelector('#sim-weather-live');
  const weatherNote = section.querySelector('#sim-weather-note');

  const statesNote = section.querySelector('#sim-states-note');
  const villagerList = section.querySelector('#sim-villagers');
  const dialogueModeEl = section.querySelector('#sim-dialogue-mode');
  const dialogueNote = section.querySelector('#sim-dialogue-note');
  const dialogueRetry = section.querySelector('#sim-dialogue-retry');

  for (const entry of CONDITIONS) {
    const option = document.createElement('option');
    option.value = String(entry.code);
    option.textContent = entry.label;
    weatherCode.appendChild(option);
  }

  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ed-btn';
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      hourInput.value = String(preset.hours);
      minuteInput.value = String(preset.minutes);
      timeOn.checked = true;
      clock.setOverride(preset.hours, preset.minutes);
      syncTime();
    });
    presetsRow.appendChild(btn);
  }

  function syncTime() {
    const now = clock.totalMinutes();
    hourInput.value = String(Math.floor(now / 60) % 24);
    minuteInput.value = String(Math.floor(now % 60));
    timeOn.checked = clock.isOverridden();
    timeNote.textContent = clock.isOverridden()
      ? 'Simulation pinned to the debug clock.'
      : `Following the device clock (${clock.label()} ${clock.zoneLabel()}).`;
  }

  function syncWeather() {
    const state = weather.state();
    weatherOn.checked = state.overridden;
    weatherCode.value = String(state.code);
    if (state.temperature !== null) tempInput.value = String(state.temperature);
    const bits = [weather.location.name];
    if (state.live) bits.push(`live ${state.label.toLowerCase()}`);
    if (state.error) bits.push(`last request failed: ${state.error}`);
    if (state.overridden) bits.push('override on');
    weatherNote.textContent = bits.join(' · ');
  }

  function applyTime() {
    const hours = Math.max(0, Math.min(23, Number(hourInput.value) || 0));
    const minutes = Math.max(0, Math.min(59, Number(minuteInput.value) || 0));
    clock.setOverride(hours, minutes);
    syncTime();
  }

  timeApply.addEventListener('click', applyTime);
  hourInput.addEventListener('change', () => { if (timeOn.checked) applyTime(); });
  minuteInput.addEventListener('change', () => { if (timeOn.checked) applyTime(); });
  timeOn.addEventListener('change', () => {
    if (timeOn.checked) applyTime();
    else {
      clock.clearOverride();
      syncTime();
    }
  });
  timeReal.addEventListener('click', () => {
    clock.clearOverride();
    syncTime();
  });

  // Start out reading the device clock, so the fields never show the markup's
  // placeholder hour on the way in.
  syncTime();
  syncWeather();

  function applyWeather() {
    const code = Number(weatherCode.value) || 0;
    const temp = tempInput.value === '' ? null : Number(tempInput.value);
    weather.setOverride(code, temp);
    syncWeather();
  }

  weatherCode.addEventListener('change', () => { if (weatherOn.checked) applyWeather(); });
  tempInput.addEventListener('change', () => { if (weatherOn.checked) applyWeather(); });
  weatherOn.addEventListener('change', () => {
    if (weatherOn.checked) applyWeather();
    else {
      weather.clearOverride();
      syncWeather();
    }
  });
  weatherLive.addEventListener('click', () => {
    weather.clearOverride();
    weather.refresh();
    weatherOn.checked = false;
    syncTime();
    syncWeather();
  });

  button.addEventListener('click', () => {
    section.hidden = !section.hidden;
    button.classList.toggle('is-on', !section.hidden);
    if (!section.hidden) {
      focusPanel(section);
      syncTime();
      syncWeather();
      renderVillagers();
      syncDialogue();
    }
  });

  function renderVillagers() {
    const rows = lifestyle ? lifestyle.snapshot() : [];
    villagerList.innerHTML = '';
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'sim-villager';
      el.innerHTML = `<span>${row.name || row.id}</span><span class="sim-state sim-${row.state}">${row.state}</span><span class="sim-where">${row.inside ? `room ${row.roomIndex}` : 'outside'}</span>`;
      villagerList.appendChild(el);
    }
    const states = lifestyle ? lifestyle.states() : null;
    statesNote.textContent = states
      ? `walk ${states.walking} · idle ${states.watching + states.chilling} · talk ${states.talking} · sleep ${states.sleeping}`
      : '';
  }

  // The dialogue mode is shown, never inferred: the reader can always tell whether a
  // line came from Groq, from the cache of earlier model lines, or from the procedural
  // engine, and whether the village is currently in fallback.
  const MODE_LABEL = {
    groq: 'GROQ AI',
    cached: 'CACHED AI',
    offline: 'OFFLINE PROCEDURAL',
  };

  function syncDialogue() {
    if (!conversations || !conversations.dialogueStatus) {
      dialogueModeEl.textContent = 'n/a';
      dialogueNote.textContent = 'No conversation manager.';
      return;
    }
    const status = conversations.dialogueStatus();
    const mode = status.mode || 'offline';
    dialogueModeEl.textContent = MODE_LABEL[mode] || mode.toUpperCase();
    dialogueModeEl.className = `sim-mode dlg-${mode}`;

    const groq = status.groq || {};
    const bits = [];
    if (groq.available) bits.push('Groq available');
    else if (groq.coolingDown) bits.push(`Groq cooling down ${groq.cooldownSeconds}s`);
    else if (groq.configured) bits.push('Groq unavailable');
    else bits.push('Groq not configured');
    if (status.fallback) bits.push('fallback on');
    const counts = status.counts || {};
    bits.push(`${counts.groq || 0} model · ${counts.cached || 0} cached · ${counts.offline || 0} offline`);
    bits.push(`cache ${status.cache ? status.cache.size : 0}`);
    if (groq.lastFailureCode) bits.push(`last error ${groq.lastFailureCode}`);
    dialogueNote.textContent = bits.join(' · ');

    dialogueRetry.disabled = !ai || !ai.recover;
    dialogueRetry.title = ai && ai.recover
      ? 'Clear the cooldown and ask the server whether Groq is back'
      : 'No model client';
  }

  dialogueRetry.addEventListener('click', () => {
    if (!ai || !ai.recover) return;
    dialogueRetry.disabled = true;
    dialogueRetry.textContent = 'Checking…';
    ai.recover().catch(() => null).then(() => {
      dialogueRetry.disabled = false;
      dialogueRetry.textContent = 'Try Groq now';
      syncDialogue();
    });
  });

  const timer = setInterval(() => {
    if (section.hidden) return;
    syncTime();
    syncWeather();
    renderVillagers();
    syncDialogue();
  }, 800);

  return {
    section,
    button,
    refresh: () => {
      syncTime();
      syncWeather();
      renderVillagers();
      syncDialogue();
    },
    stop: () => clearInterval(timer),
  };
}
