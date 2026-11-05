// Simulation controls, added to the existing editor panel as ONE extra button.
//
// The editor panel is the project's existing debug surface, so this adds a single
// "Sim" button to its toolbar and a section behind it. The section holds the clock
// override and the weather override, which are deliberately independent: switching
// one off leaves the other alone.

import { CONDITIONS } from './weather.js';

const PRESETS = [
  { label: 'Morning', hours: 8, minutes: 0 },
  { label: 'Noon', hours: 12, minutes: 0 },
  { label: 'Evening', hours: 18, minutes: 0 },
  { label: 'Night', hours: 22, minutes: 0 },
  { label: 'Midnight', hours: 0, minutes: 0 },
];

const pad = (n) => String(n).padStart(2, '0');

export function createSimPanel({ clock, weather, lifestyle, getNpcs }) {
  const editor = document.getElementById('editor');
  if (!editor) return null;

  const tools = editor.querySelector('.ed-tools');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ed-btn';
  button.id = 'ed-sim';
  button.textContent = 'Sim';
  button.title = 'Time, weather and villager states';
  if (tools) tools.appendChild(button);

  const section = document.createElement('div');
  section.id = 'sim-controls';
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
  `;
  editor.appendChild(section);

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
      : 'Following the device clock.';
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
      syncTime();
      syncWeather();
      renderVillagers();
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

  const timer = setInterval(() => {
    if (section.hidden) return;
    syncTime();
    syncWeather();
    renderVillagers();
  }, 800);

  return {
    section,
    button,
    refresh: () => {
      syncTime();
      syncWeather();
      renderVillagers();
    },
    stop: () => clearInterval(timer),
  };
}
