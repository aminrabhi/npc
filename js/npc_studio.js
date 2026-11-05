// NPC studio: an editor for the villagers themselves, not the map.
//
// It is deliberately separate from the tile editor - it never touches the tileset,
// the layers or the collision mask. It only edits the roster in data/npcs.json:
// what a villager looks like (body, hair and the hand strip they carry), their name,
// where they idle, and the writing attached to them (backstory, personality
// adjectives and notes) which is stored but not yet used in the village.
//
// "Export NPC code" hands the whole roster back as JSON so it can be baked in.

import { BODIES, HAIRS, HANDS, SKIN_COLOURS, SHIRT_COLOURS, HAIR_COLOURS } from './npcs.js';
import { profileFor, STYLE_OPTIONS } from './personalities.js';

const CELL_W = 96;
const CELL_H = 64;
const THUMB = { x: 30, y: 12, w: 36, h: 32 };
const PREVIEW_W = 144;
const PREVIEW_H = 96;

function thumb(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (img) ctx.drawImage(img, THUMB.x, THUMB.y, THUMB.w, THUMB.h, 0, 0, 32, 32);
  return canvas;
}

function nextId(roster) {
  const taken = new Set(roster.map((entry) => entry.id));
  let n = 1;
  while (taken.has(`npc_${String(n).padStart(2, '0')}`)) n++;
  return `npc_${String(n).padStart(2, '0')}`;
}

function firstOpenCell(village, roster) {
  const used = new Set(roster.map((entry) => entry.home.join(',')));
  for (let y = 0; y < village.rows; y++) {
    for (let x = 0; x < village.cols; x++) {
      if (village.isSolid(x, y)) continue;
      if (village.isDoorway(x, y)) continue;
      if (used.has(`${x},${y}`)) continue;
      return [x, y];
    }
  }
  return [0, 0];
}

export function createNpcStudio({ canvas, state, village, assets, sheetsFor, onChange }) {
  let open = false;
  let selectedId = state.roster.length ? state.roster[0].id : null;
  let placing = false;
  let hoverTile = null;
  let dragNpc = null;

  const T = village.tileSize;

  // --------------------------------------------------------------------- DOM
  const toggle = document.createElement('button');
  toggle.id = 'npc-toggle';
  toggle.type = 'button';
  toggle.textContent = 'NPC studio';
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.id = 'npc-studio';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="np-head" id="np-head">
      <span class="np-title">NPC studio</span>
      <span class="np-drag-hint">drag to move</span>
    </div>
    <div class="np-body">
      <div class="np-left">
        <div class="np-section">Villagers</div>
        <div class="np-roster" id="np-roster"></div>
        <div class="np-row">
          <button type="button" class="ed-btn" id="np-new">+ New</button>
          <button type="button" class="ed-btn" id="np-dup">Copy</button>
          <button type="button" class="ed-btn" id="np-del">Delete</button>
        </div>
        <div class="np-section">Preview</div>
        <canvas id="np-preview" width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas>
        <div class="np-home">
          <span id="np-home">home -</span>
          <button type="button" class="ed-btn" id="np-place">Set on map</button>
        </div>
        <div class="np-section">Home &amp; bed</div>
        <label class="np-label" for="np-house">House</label>
        <select class="np-input np-select" id="np-house"></select>
        <label class="np-label" for="np-roomSel">Room</label>
        <select class="np-input np-select" id="np-roomSel"></select>
        <label class="np-label" for="np-bedSel">Bed</label>
        <select class="np-input np-select" id="np-bedSel"></select>
        <button type="button" class="ed-btn" id="np-export-homes">Export room &amp; bed code</button>
        <div class="np-note" id="np-assign"></div>
      </div>
      <div class="np-right">
        <label class="np-label" for="np-name">Name</label>
        <input class="np-input" id="np-name" type="text" maxlength="24" placeholder="Villager name" spellcheck="false">
        <div class="np-label">Body</div>
        <div class="np-opts" id="np-body"></div>
        <div class="np-label">Hair</div>
        <div class="np-opts" id="np-hair"></div>
        <div class="np-label">Hands <span class="np-hint">(what they carry)</span></div>
        <div class="np-opts" id="np-hand"></div>
        <div class="np-label">Skin colour <span class="np-hint">(body and hand)</span></div>
        <div class="np-colours" id="np-skin"></div>
        <div class="np-label">Shirt colour <span class="np-hint">(outline kept)</span></div>
        <div class="np-colours" id="np-shirt"></div>
        <div class="np-label">Hair colour <span class="np-hint">(outline kept)</span></div>
        <div class="np-colours" id="np-haircolor"></div>
        <label class="np-label" for="np-personality">Personality <span class="np-hint">(comma separated)</span></label>
        <input class="np-input" id="np-personality" type="text" placeholder="brave, curious, kind" spellcheck="false">
        <label class="np-label" for="np-backstory">Backstory</label>
        <textarea class="np-input np-area" id="np-backstory" rows="3" spellcheck="false"></textarea>
        <label class="np-label" for="np-notes">Notes</label>
        <textarea class="np-input np-area" id="np-notes" rows="2" spellcheck="false"></textarea>

        <div class="np-section np-section-ai">Talks &amp; remembers</div>
        <label class="np-label" for="np-interests">Interests <span class="np-hint">(comma separated)</span></label>
        <input class="np-input" id="np-interests" type="text" spellcheck="false" placeholder="gardening, the weather">
        <label class="np-label" for="np-likes">Likes</label>
        <input class="np-input" id="np-likes" type="text" spellcheck="false" placeholder="tea, visitors">
        <label class="np-label" for="np-dislikes">Dislikes</label>
        <input class="np-input" id="np-dislikes" type="text" spellcheck="false" placeholder="arguments, loud noises">
        <label class="np-label" for="np-tendencies">Habits</label>
        <input class="np-input" id="np-tendencies" type="text" spellcheck="false" placeholder="offers food, agrees too fast">
        <label class="np-label" for="np-memories">Important memories <span class="np-hint">(one per line)</span></label>
        <textarea class="np-input np-area" id="np-memories" rows="3" spellcheck="false"></textarea>
        <label class="np-label" for="np-style">Speaking style</label>
        <select class="np-input np-select" id="np-style"></select>
        <label class="np-label" for="np-social">Sociability <span class="np-hint" id="np-social-out">-</span></label>
        <input class="np-input" id="np-social" type="range" min="0" max="100" step="5" value="50">
        <label class="np-label" for="np-news">Cares about the news <span class="np-hint" id="np-news-out">-</span></label>
        <input class="np-input" id="np-news" type="range" min="0" max="100" step="5" value="25">
      </div>
    </div>
    <div class="np-foot">
      <span class="np-hint" id="np-status"></span>
      <button type="button" class="ed-btn ed-primary" id="np-export">Export NPC code</button>
    </div>
  `;
  document.body.appendChild(panel);

  const head = panel.querySelector('#np-head');
  const rosterBar = panel.querySelector('#np-roster');
  const preview = panel.querySelector('#np-preview');
  const previewCtx = preview.getContext('2d');
  const nameInput = panel.querySelector('#np-name');
  const personalityInput = panel.querySelector('#np-personality');
  const backstoryInput = panel.querySelector('#np-backstory');
  const notesInput = panel.querySelector('#np-notes');
  const interestsInput = panel.querySelector('#np-interests');
  const likesInput = panel.querySelector('#np-likes');
  const dislikesInput = panel.querySelector('#np-dislikes');
  const tendenciesInput = panel.querySelector('#np-tendencies');
  const memoriesInput = panel.querySelector('#np-memories');
  const styleSelect = panel.querySelector('#np-style');
  const socialInput = panel.querySelector('#np-social');
  const newsInput = panel.querySelector('#np-news');
  const socialOut = panel.querySelector('#np-social-out');
  const newsOut = panel.querySelector('#np-news-out');
  const homeLabel = panel.querySelector('#np-home');
  const status = panel.querySelector('#np-status');
  const placeBtn = panel.querySelector('#np-place');
  const houseSel = panel.querySelector('#np-house');
  const roomSel = panel.querySelector('#np-roomSel');
  const bedSel = panel.querySelector('#np-bedSel');
  const assignNote = panel.querySelector('#np-assign');

  // ------------------------------------------------------- room & bed slots
  function homesConfig() {
    return state.homes || null;
  }

  function assignmentFor(entry) {
    const homes = homesConfig();
    if (!homes) return { room: null, bed: null };
    return homes.assignment(entry.id, state.roster.indexOf(entry));
  }

  // House -> room -> bed, straight out of the exported config, with the physical
  // door and bed tiles shown so it is obvious which spot on the map it means.
  function renderAssign() {
    const homes = homesConfig();
    const entry = selected();
    const exportBtn = panel.querySelector('#np-export-homes');
    for (const el of [houseSel, roomSel, bedSel, exportBtn]) {
      if (el) el.disabled = !homes || !entry;
    }
    if (!homes || !entry) {
      assignNote.textContent = homes ? 'Select a villager.' : 'No room/bed config loaded.';
      return;
    }

    const assignment = assignmentFor(entry);
    const room = homes.room(assignment.room);
    const houseIds = [...new Set(homes.rooms.map((r) => r.house))];

    houseSel.innerHTML = '';
    for (const house of houseIds) {
      const option = document.createElement('option');
      option.value = house;
      option.textContent = house.replace('house_', 'House ');
      houseSel.appendChild(option);
    }
    houseSel.value = room ? room.house : (houseIds[0] || '');

    roomSel.innerHTML = '';
    const houseRooms = homes.rooms.filter((r) => r.house === houseSel.value);
    for (const candidate of houseRooms) {
      const option = document.createElement('option');
      option.value = String(candidate.index);
      option.textContent = `Room ${candidate.index} - ${candidate.w}x${candidate.h} at ${candidate.x},${candidate.y}`;
      roomSel.appendChild(option);
    }
    roomSel.value = room ? String(room.index) : (houseRooms[0] ? String(houseRooms[0].index) : '');

    bedSel.innerHTML = '';
    for (const bed of homes.bedsFor(Number(roomSel.value))) {
      const option = document.createElement('option');
      option.value = bed.id;
      option.textContent = `${bed.id} at ${bed.tile[0]},${bed.tile[1]}`;
      bedSel.appendChild(option);
    }
    bedSel.value = assignment.bed && homes.bed(assignment.bed)
      ? assignment.bed
      : (bedSel.options[0] ? bedSel.options[0].value : '');

    const bed = homes.bed(bedSel.value);
    const bits = [];
    if (room) bits.push(`door ${room.door.join(',')} - room at ${room.x},${room.y}`);
    if (bed) bits.push(`bed ${bed.tile[0]},${bed.tile[1]}`);
    const row = state.lifestyles
      ? state.lifestyles.snapshot().find((item) => item.id === entry.id)
      : null;
    if (row) bits.push(`now ${row.state}`);
    assignNote.textContent = bits.join('  ·  ');
  }

  function applyAssignment(roomIndex, bedId) {
    const homes = homesConfig();
    const entry = selected();
    if (!homes || !entry) return;
    const room = homes.room(roomIndex);
    const bed = bedId ? homes.bed(bedId) : null;
    const next = homes.assign(entry.id, {
      room: room ? room.index : null,
      bed: bed ? bed.id : null,
    });
    entry.homes = { room: next.room, bed: next.bed };
    if (state.lifestyles) state.lifestyles.replanAll();
    onChange();
    renderAssign();
  }

  houseSel.addEventListener('change', () => {
    const homes = homesConfig();
    if (!homes) return;
    const room = homes.rooms.find((r) => r.house === houseSel.value);
    if (room) {
      const beds = homes.bedsFor(room.index);
      applyAssignment(room.index, beds.length ? beds[0].id : null);
    }
  });

  roomSel.addEventListener('change', () => {
    const homes = homesConfig();
    if (!homes) return;
    const index = Number(roomSel.value);
    const beds = homes.bedsFor(index);
    applyAssignment(index, beds.length ? beds[0].id : null);
  });

  bedSel.addEventListener('change', () => {
    const homes = homesConfig();
    if (!homes) return;
    const bed = homes.bed(bedSel.value);
    applyAssignment(bed ? bed.room : Number(roomSel.value), bedSel.value);
  });

  function selected() {
    return state.roster.find((entry) => entry.id === selectedId) || null;
  }

  // ------------------------------------------------------------------ render
  function renderRoster() {
    rosterBar.innerHTML = '';
    for (const entry of state.roster) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed-btn np-roster-btn';
      btn.textContent = entry.name || '(no name)';
      btn.classList.toggle('is-on', entry.id === selectedId);
      btn.addEventListener('click', () => {
        selectedId = entry.id;
        syncFields();
        renderRoster();
      });
      rosterBar.appendChild(btn);
    }
  }

  function buildOptions(container, list, field, imageFor) {
    container.innerHTML = '';
    for (const option of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'np-opt';
      btn.dataset.id = option.id;
      btn.title = option.label;
      btn.appendChild(thumb(imageFor(option)));
      const caption = document.createElement('span');
      caption.textContent = option.label;
      btn.appendChild(caption);
      btn.addEventListener('click', () => {
        const entry = selected();
        if (!entry) return;
        entry[field] = option.id;
        markOptions();
        onChange();
        drawPreview(true);
      });
      container.appendChild(btn);
    }
  }

  function markOptions() {
    const entry = selected();
    for (const [container, field] of [
      [panel.querySelector('#np-body'), 'body'],
      [panel.querySelector('#np-hair'), 'hair'],
      [panel.querySelector('#np-hand'), 'hand'],
    ]) {
      container.querySelectorAll('.np-opt').forEach((btn) => {
        btn.classList.toggle('is-on', !!entry && btn.dataset.id === entry[field]);
      });
    }

    for (const [container, field] of [
      [panel.querySelector('#np-skin'), 'skin'],
      [panel.querySelector('#np-shirt'), 'shirt'],
      [panel.querySelector('#np-haircolor'), 'hairColor'],
    ]) {
      if (!container) continue;
      const current = (entry && entry[field]) || null;
      container.querySelectorAll('.np-swatch').forEach((btn) => {
        btn.classList.toggle('is-on', (btn.dataset.value || null) === current);
      });
      const picker = container.querySelector('.np-color-input');
      if (picker && current) picker.value = current;
    }
  }

  // A colour row: "Original" leaves the pack's palette alone, the swatches and the
  // picker recolour only that garment or the hair - the outline is never touched.
  function buildColours(container, field, presets) {
    container.innerHTML = '';

    const original = document.createElement('button');
    original.type = 'button';
    original.className = 'np-swatch np-swatch-orig';
    original.dataset.value = '';
    original.textContent = 'Original';
    original.title = "Keep the pack's own colours";
    original.addEventListener('click', () => setColour(field, null));
    container.appendChild(original);

    for (const hex of presets) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'np-swatch';
      swatch.dataset.value = hex;
      swatch.style.background = hex;
      swatch.title = hex;
      swatch.addEventListener('click', () => setColour(field, hex));
      container.appendChild(swatch);
    }

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'np-color-input';
    picker.dataset.field = field;
    picker.title = 'Custom colour';
    picker.addEventListener('input', () => setColour(field, picker.value, true));
    container.appendChild(picker);
  }

  function setColour(field, value, fromPicker) {
    const entry = selected();
    if (!entry) return;
    entry[field] = value;
    if (!fromPicker) {
      const picker = panel.querySelector(`.np-color-input[data-field="${field}"]`);
      if (picker) picker.value = value || '#7c62c9';
    }
    markOptions();
    onChange();
    drawPreview(true);
  }

  buildOptions(
    panel.querySelector('#np-body'),
    BODIES,
    'body',
    (option) => assets.bodies.get(option.id)?.idle,
  );
  buildOptions(
    panel.querySelector('#np-hair'),
    HAIRS,
    'hair',
    (option) => assets.hairs.get(option.id)?.idle,
  );
  buildOptions(
    panel.querySelector('#np-hand'),
    HANDS,
    'hand',
    (option) => assets.hands.get(option.id)?.idle,
  );

  buildColours(panel.querySelector('#np-skin'), 'skin', SKIN_COLOURS);
  buildColours(panel.querySelector('#np-shirt'), 'shirt', SHIRT_COLOURS);
  buildColours(panel.querySelector('#np-haircolor'), 'hairColor', HAIR_COLOURS);

  for (const option of STYLE_OPTIONS) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.text;
    styleSelect.appendChild(el);
  }

  // The editable personality object. It is seeded from the derived profile the first
  // time a villager is touched, so the studio never shows empty boxes for a villager
  // whose character comes from their backstory and adjectives.
  function editableProfile(entry) {
    if (!entry.profile) {
      const full = profileFor(entry);
      entry.profile = {
        interests: [...full.interests],
        likes: [...full.likes],
        dislikes: [...full.dislikes],
        tendencies: [...full.tendencies],
        memories: [...full.memories],
        style: full.style,
        social: { ...full.social },
      };
    }
    return entry.profile;
  }

  function syncProfileFields() {
    const entry = selected();
    for (const input of [interestsInput, likesInput, dislikesInput, tendenciesInput, memoriesInput, styleSelect, socialInput, newsInput]) {
      input.disabled = !entry;
    }
    const profile = entry ? profileFor(entry) : null;
    interestsInput.value = profile ? profile.interests.join(', ') : '';
    likesInput.value = profile ? profile.likes.join(', ') : '';
    dislikesInput.value = profile ? profile.dislikes.join(', ') : '';
    tendenciesInput.value = profile ? profile.tendencies.join(', ') : '';
    memoriesInput.value = profile ? profile.memories.join('\n') : '';
    styleSelect.value = profile ? profile.style : STYLE_OPTIONS[0].id;
    socialInput.value = String(Math.round((profile ? profile.social.sociability : 0.5) * 100));
    newsInput.value = String(Math.round((profile ? profile.social.newsInterest : 0.25) * 100));
    socialOut.textContent = profile ? `${Math.round(profile.social.sociability * 100)}%` : '-';
    newsOut.textContent = profile ? `${Math.round(profile.social.newsInterest * 100)}%` : '-';
  }

  function commitProfileField(field, value) {
    const entry = selected();
    if (!entry) return;
    const profile = editableProfile(entry);
    profile[field] = value;
    commit();
  }

  function commitSocial(field, value) {
    const entry = selected();
    if (!entry) return;
    const profile = editableProfile(entry);
    profile.social = { ...profile.social, [field]: value };
    commit();
  }

  function syncFields() {
    const entry = selected();
    const disabled = !entry;
    for (const input of [nameInput, personalityInput, backstoryInput, notesInput, placeBtn]) {
      input.disabled = disabled;
    }
    panel.querySelector('#np-del').disabled = disabled;
    panel.querySelector('#np-dup').disabled = disabled;

    nameInput.value = entry ? entry.name : '';
    personalityInput.value = entry ? entry.personality.join(', ') : '';
    backstoryInput.value = entry ? entry.backstory : '';
    notesInput.value = entry ? entry.notes : '';
    syncProfileFields();
    homeLabel.textContent = entry ? `home ${entry.home[0]}, ${entry.home[1]}` : 'home -';
    markOptions();
    renderAssign();
    drawPreview(true);
  }

  // Animated portrait of the selected look, built from the same sheets the village uses.
  let lastDraw = 0;
  function drawPreview(force) {
    const now = performance.now();
    if (!force && now - lastDraw < 90) return;
    lastDraw = now;

    previewCtx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
    previewCtx.imageSmoothingEnabled = false;
    const entry = selected();
    if (!entry) return;

    const sheets = sheetsFor(entry);
    const walk = sheets.walk && sheets.idle;
    const sheet = walk ? sheets.walk : sheets.idle;
    if (!sheet) return;

    const frames = walk ? 8 : 9;
    const frame = Math.floor(now / (walk ? 110 : 160)) % frames;
    previewCtx.drawImage(sheet, frame * CELL_W, 0, CELL_W, CELL_H, 0, 0, PREVIEW_W, PREVIEW_H);
  }

  function loop() {
    if (!open) return;
    drawPreview(false);
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ edits
  function commit() {
    onChange();
    renderRoster();
    homeLabel.textContent = (() => {
      const entry = selected();
      return entry ? `home ${entry.home[0]}, ${entry.home[1]}` : 'home -';
    })();
  }

  nameInput.addEventListener('input', () => {
    const entry = selected();
    if (!entry) return;
    entry.name = nameInput.value.slice(0, 24);
    commit();
  });

  personalityInput.addEventListener('input', () => {
    const entry = selected();
    if (!entry) return;
    entry.personality = personalityInput.value
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean);
    commit();
  });

  backstoryInput.addEventListener('input', () => {
    const entry = selected();
    if (entry) entry.backstory = backstoryInput.value;
    commit();
  });

  notesInput.addEventListener('input', () => {
    const entry = selected();
    if (entry) entry.notes = notesInput.value;
    commit();
  });

  const listField = (input, field) => input.addEventListener('input', () => {
    commitProfileField(field, input.value.split(',').map((word) => word.trim()).filter(Boolean));
  });

  listField(interestsInput, 'interests');
  listField(likesInput, 'likes');
  listField(dislikesInput, 'dislikes');
  listField(tendenciesInput, 'tendencies');

  memoriesInput.addEventListener('input', () => {
    commitProfileField('memories', memoriesInput.value.split('\n').map((line) => line.trim()).filter(Boolean));
  });

  styleSelect.addEventListener('change', () => commitProfileField('style', styleSelect.value));

  socialInput.addEventListener('input', () => {
    socialOut.textContent = `${socialInput.value}%`;
    commitSocial('sociability', Number(socialInput.value) / 100);
  });

  newsInput.addEventListener('input', () => {
    newsOut.textContent = `${newsInput.value}%`;
    commitSocial('newsInterest', Number(newsInput.value) / 100);
  });

  panel.querySelector('#np-new').addEventListener('click', () => {
    const entry = {
      id: nextId(state.roster),
      name: `Villager ${state.roster.length + 1}`,
      body: BODIES[0].id,
      hair: HAIRS[state.roster.length % HAIRS.length].id,
      hand: 'none',
      skin: null,
      shirt: null,
      hairColor: null,
      home: firstOpenCell(village, state.roster),
      backstory: '',
      personality: [],
      notes: '',
      profile: null,
      homes: null,
    };
    state.roster.push(entry);
    selectedId = entry.id;
    onChange();
    renderRoster();
    syncFields();
  });

  panel.querySelector('#np-dup').addEventListener('click', () => {
    const entry = selected();
    if (!entry) return;
    const copy = {
      ...entry,
      id: nextId(state.roster),
      name: `${entry.name} (copy)`.slice(0, 24),
      home: [...entry.home],
      personality: [...entry.personality],
      // a copy keeps the character but must not inherit the original's bed
      profile: entry.profile ? JSON.parse(JSON.stringify(entry.profile)) : null,
      homes: null,
    };
    state.roster.push(copy);
    selectedId = copy.id;
    onChange();
    renderRoster();
    syncFields();
  });

  panel.querySelector('#np-del').addEventListener('click', () => {
    const entry = selected();
    if (!entry) return;
    const index = state.roster.indexOf(entry);
    state.roster.splice(index, 1);
    const next = state.roster[Math.min(index, state.roster.length - 1)];
    selectedId = next ? next.id : null;
    onChange();
    renderRoster();
    syncFields();
  });

  // ------------------------------------------------------------- home tile
  placeBtn.addEventListener('click', () => {
    if (!selected()) return;
    placing = !placing;
    placeBtn.classList.toggle('is-on', placing);
    status.textContent = placing
      ? 'Click a walkable tile to move this villager\'s home.'
      : '';
    canvas.style.cursor = placing ? 'crosshair' : '';
  });

  function tileAt(ev) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left - state.offset.x) / state.scale / T);
    const y = Math.floor((ev.clientY - r.top - state.offset.y) / state.scale / T);
    if (x < 0 || y < 0 || x >= village.cols || y >= village.rows) return null;
    return { x, y };
  }

  // World position of the pointer, so a villager can be picked up by their feet.
  function worldAt(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left - state.offset.x) / state.scale,
      y: (ev.clientY - r.top - state.offset.y) / state.scale,
    };
  }

  function npcAt(ev) {
    const p = worldAt(ev);
    let best = null;
    let bestD = 16;
    for (const npc of state.npcs) {
      const d = Math.hypot(p.x - npc.x, p.y - npc.y);
      if (d < bestD) {
        bestD = d;
        best = npc;
      }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (!open) return;

    if (placing) {
      const tile = tileAt(ev);
      if (!tile) return;
      if (village.isSolid(tile.x, tile.y)) {
        status.textContent = 'That tile is blocked - pick open ground.';
        return;
      }
      const entry = selected();
      if (!entry) return;
      entry.home = [tile.x, tile.y];
      placing = false;
      placeBtn.classList.remove('is-on');
      canvas.style.cursor = '';
      status.textContent = `Home moved to ${tile.x}, ${tile.y}.`;
      onChange();
      homeLabel.textContent = `home ${tile.x}, ${tile.y}`;
      ev.preventDefault();
      return;
    }

    // dragging a villager moves them, which is also their new home
    const npc = npcAt(ev);
    if (!npc) return;
    dragNpc = npc;
    canvas.setPointerCapture(ev.pointerId);
    canvas.style.cursor = 'grabbing';
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!open) return;
    hoverTile = tileAt(ev);

    if (dragNpc) {
      status.textContent = hoverTile
        ? (village.isSolid(hoverTile.x, hoverTile.y)
          ? 'Blocked tile - drop them somewhere open.'
          : `Drop at ${hoverTile.x}, ${hoverTile.y}`)
        : '';
      return;
    }
    if (!placing) canvas.style.cursor = npcAt(ev) ? 'grab' : '';
  });

  function finishDrag(ev, commit) {
    if (!dragNpc) return;
    const npc = dragNpc;
    dragNpc = null;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    canvas.style.cursor = '';
    status.textContent = '';

    if (!commit || !hoverTile) return;
    if (village.isSolid(hoverTile.x, hoverTile.y)) {
      status.textContent = 'That tile is blocked - they stayed put.';
      return;
    }

    const entry = state.roster.find((item) => item.id === npc.config.id);
    if (!entry) return;
    entry.home = [hoverTile.x, hoverTile.y];

    const T2 = village.tileSize;
    npc.setHome({ x: hoverTile.x, y: hoverTile.y });
    npc.x = hoverTile.x * T2 + T2 / 2;
    npc.y = hoverTile.y * T2 + T2 / 2;
    npc.path = [];
    npc.pendingRoom = null;
    npc.approach = null;
    npc.moving = false;
    npc.idle();

    homeLabel.textContent = `home ${hoverTile.x}, ${hoverTile.y}`;
    onChange();
  }

  canvas.addEventListener('pointerup', (ev) => finishDrag(ev, true));
  canvas.addEventListener('pointercancel', (ev) => finishDrag(ev, false));

  // Home markers so every villager's spot is visible while the studio is open.
  function overlay(ctx) {
    if (!open) return;
    const lw = 1 / Math.max(1, state.scale);
    ctx.save();
    for (const entry of state.roster) {
      const isSelected = entry.id === selectedId;
      const [hx, hy] = entry.home;
      ctx.strokeStyle = isSelected ? 'rgba(255, 214, 102, 0.95)' : 'rgba(120, 220, 255, 0.45)';
      ctx.lineWidth = lw;
      ctx.strokeRect(hx * T + lw / 2, hy * T + lw / 2, T - lw, T - lw);
      if (isSelected) {
        ctx.fillStyle = 'rgba(255, 214, 102, 0.16)';
        ctx.fillRect(hx * T, hy * T, T, T);
      }
    }
    if ((placing || dragNpc) && hoverTile) {
      ctx.strokeStyle = village.isSolid(hoverTile.x, hoverTile.y)
        ? 'rgba(255, 120, 120, 0.95)'
        : 'rgba(255, 214, 102, 0.95)';
      ctx.lineWidth = lw * 2;
      ctx.strokeRect(hoverTile.x * T, hoverTile.y * T, T, T);
    }

    if (dragNpc) {
      ctx.strokeStyle = 'rgba(255, 214, 102, 0.95)';
      ctx.lineWidth = lw * 2;
      ctx.beginPath();
      ctx.arc(dragNpc.x, dragNpc.y - 6, T * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ export
  const modal = document.createElement('div');
  modal.id = 'np-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="ed-modal-box">
      <h2>NPC code</h2>
      <p>Copy this and paste it back in chat - these villagers get baked into the project.</p>
      <textarea readonly spellcheck="false"></textarea>
      <div class="ed-modal-actions">
        <button type="button" class="ed-btn ed-primary" id="np-copy-code">Copy</button>
        <button type="button" class="ed-btn" id="np-modal-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const codeArea = modal.querySelector('textarea');
  const copyBtn = modal.querySelector('#np-copy-code');

  function rosterJson() {
    const npcs = state.roster.map((entry) => ({
      id: entry.id,
      name: entry.name,
      body: entry.body,
      hair: entry.hair,
      hand: entry.hand,
      skin: entry.skin || null,
      shirt: entry.shirt || null,
      hairColor: entry.hairColor || null,
      home: [entry.home[0], entry.home[1]],
      backstory: entry.backstory,
      personality: [...entry.personality],
      notes: entry.notes,
      profile: entry.profile ? {
        interests: entry.profile.interests || [],
        likes: entry.profile.likes || [],
        dislikes: entry.profile.dislikes || [],
        tendencies: entry.profile.tendencies || [],
        memories: entry.profile.memories || [],
        style: entry.profile.style || null,
        social: entry.profile.social || null,
      } : null,
      homes: entry.homes ? { room: entry.homes.room, bed: entry.homes.bed } : null,
    }));
    return JSON.stringify({ v: 1, npcs }, null, 2);
  }

  function showExport() {
    codeArea.value = rosterJson();
    modal.hidden = false;
    codeArea.focus();
    codeArea.select();
    return codeArea.value;
  }

  panel.querySelector('#np-export').addEventListener('click', showExport);
  modal.querySelector('#np-modal-close').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (ev) => { if (ev.target === modal) modal.hidden = true; });
  panel.querySelector('#np-export-homes').addEventListener('click', () => {
    if (!state.homes) return;
    codeArea.value = state.homes.exportCode();
    modal.hidden = false;
    codeArea.focus();
    codeArea.select();
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeArea.value);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    } catch {
      codeArea.select();
    }
  });

  // -------------------------------------------------------- panel dragging
  let drag = null;

  head.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    panel.style.left = `${r.left}px`;
    panel.style.top = `${r.top}px`;
    panel.style.right = 'auto';
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
    head.setPointerCapture(ev.pointerId);
    head.classList.add('is-dragging');
    ev.preventDefault();
  });

  head.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
    panel.style.left = `${Math.min(Math.max(0, ev.clientX - drag.dx), maxX)}px`;
    panel.style.top = `${Math.min(Math.max(0, ev.clientY - drag.dy), maxY)}px`;
  });

  function endDrag(ev) {
    if (!drag) return;
    drag = null;
    head.classList.remove('is-dragging');
    if (head.hasPointerCapture(ev.pointerId)) head.releasePointerCapture(ev.pointerId);
  }

  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------------ open/close
  function setOpen(next) {
    open = next;
    panel.hidden = !next;
    toggle.textContent = next ? 'Close NPC studio' : 'NPC studio';
    state.npcOverlay = next ? overlay : null;
    if (next) {
      if (!selectedId && state.roster.length) selectedId = state.roster[0].id;
      renderRoster();
      syncFields();
      requestAnimationFrame(loop);
    } else {
      placing = false;
      placeBtn.classList.remove('is-on');
      canvas.style.cursor = '';
      status.textContent = '';
      hoverTile = null;
    }
  }

  toggle.addEventListener('click', () => setOpen(!open));

  window.addEventListener('keydown', (ev) => {
    if (!open) return;
    if (ev.key !== 'Escape') return;
    if (!modal.hidden) { modal.hidden = true; return; }
    if (placing) {
      placing = false;
      placeBtn.classList.remove('is-on');
      canvas.style.cursor = '';
      status.textContent = '';
      return;
    }
    setOpen(false);
  });

  renderRoster();
  syncFields();

  return {
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    rosterJson,
    showExport,
    selectedId: () => selectedId,
    select: (id) => {
      if (!state.roster.some((entry) => entry.id === id)) return false;
      selectedId = id;
      renderRoster();
      syncFields();
      return true;
    },
    refresh: () => {
      if (!selected() && state.roster.length) selectedId = state.roster[0].id;
      renderRoster();
      syncFields();
    },
  };
}
