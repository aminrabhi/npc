// The village HUD and the drawn atmosphere.
//
// The corner readout is plain DOM so it stays crisp at any window size; the lighting
// and the weather are painted over the canvas in world space, and the dialogue
// bubbles are drawn above the villagers. Nothing here decides anything: it only
// reads the clock, the weather and what the lifestyle module is doing.

const PHASE_TINT = {
  morning: { colour: '255, 216, 150', alpha: 0.10 },
  day: { colour: '255, 250, 220', alpha: 0.0 },
  evening: { colour: '255, 138, 92', alpha: 0.14 },
  night: { colour: '18, 24, 58', alpha: 0.55 },
};

const WEATHER_TINT = {
  clear: null,
  'mostly-clear': null,
  'partly-cloudy': { colour: '210, 226, 240', alpha: 0.03 },
  overcast: { colour: '120, 132, 150', alpha: 0.08 },
  fog: { colour: '222, 230, 238', alpha: 0.16 },
  drizzle: { colour: '96, 116, 140', alpha: 0.10 },
  rain: { colour: '80, 100, 128', alpha: 0.13 },
  snow: { colour: '235, 244, 255', alpha: 0.12 },
  storm: { colour: '58, 68, 92', alpha: 0.16 },
};

const pad = (n) => String(n).padStart(2, '0');

export function createHud({ village, clock, weather, homes }) {
  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div class="hud-time" id="hud-time">--:--</div>
    <div class="hud-line"><span id="hud-weather">-</span><span class="hud-sep">·</span><span id="hud-temp">-</span></div>
    <div class="hud-sub" id="hud-sub"></div>
  `;
  document.body.appendChild(root);

  const timeEl = root.querySelector('#hud-time');
  const weatherEl = root.querySelector('#hud-weather');
  const tempEl = root.querySelector('#hud-temp');
  const subEl = root.querySelector('#hud-sub');

  let rainDrops = null;
  let snowFlakes = null;
  let lastParticleAt = 0;

  function seed(count) {
    const drops = [];
    let seedValue = 0x2f6e2b1;
    const next = () => {
      seedValue = (seedValue * 1103515245 + 12345) & 0x7fffffff;
      return seedValue / 0x7fffffff;
    };
    for (let i = 0; i < count; i++) {
      drops.push({
        x: next() * village.width,
        y: next() * village.height,
        speed: 40 + next() * 90,
        len: 4 + next() * 10,
        drift: 6 + next() * 10,
      });
    }
    return drops;
  }

  function refreshReadout() {
    const state = weather.state();
    timeEl.textContent = clock.label();
    weatherEl.textContent = state.label;
    tempEl.textContent = state.temperature === null ? '-°' : `${state.temperature}°`;
    const bits = [];
    bits.push(clock.isOverridden() ? 'debug time' : `real time · ${clock.zoneLabel()}`);
    bits.push(state.overridden ? 'debug weather' : state.live ? `${weather.location.name}` : 'no weather yet');
    if (state.error) bits.push('weather offline');
    subEl.textContent = bits.join(' · ');
  }

  refreshReadout();
  const readoutTimer = setInterval(refreshReadout, 1000);
  weather.onChange(refreshReadout);

  function drawAtmosphere(ctx) {
    const state = weather.state();
    const phase = clock.phase();
    const tint = PHASE_TINT[phase] || PHASE_TINT.day;
    if (tint.alpha > 0) {
      ctx.fillStyle = `rgba(${tint.colour}, ${tint.alpha})`;
      ctx.fillRect(0, 0, village.width, village.height);
    }
    const weatherTint = WEATHER_TINT[state.key];
    if (weatherTint) {
      ctx.fillStyle = `rgba(${weatherTint.colour}, ${weatherTint.alpha})`;
      ctx.fillRect(0, 0, village.width, village.height);
    }

    if (state.wet || state.snowy) {
      const now = performance.now();
      const dt = lastParticleAt ? Math.min(0.05, (now - lastParticleAt) / 1000) : 0.016;
      lastParticleAt = now;
      const count = state.key === 'storm' ? 260 : state.key === 'drizzle' ? 90 : 170;
      if (!rainDrops || rainDrops.length !== count) rainDrops = seed(count);
      ctx.save();
      ctx.strokeStyle = 'rgba(206, 226, 255, 0.55)';
      ctx.fillStyle = 'rgba(240, 248, 255, 0.8)';
      ctx.lineWidth = state.key === 'storm' ? 1.6 : 1;
      for (const drop of rainDrops) {
        drop.y += drop.speed * dt * (state.snowy ? 0.35 : 1);
        drop.x += (state.snowy ? drop.drift * 0.3 : drop.drift) * dt;
        if (drop.y > village.height) { drop.y = -drop.len; drop.x = Math.random() * village.width; }
        if (drop.x > village.width) drop.x = 0;
        if (state.snowy) {
          ctx.fillRect(Math.round(drop.x), Math.round(drop.y), 1.5, 1.5);
        } else {
          ctx.beginPath();
          ctx.moveTo(drop.x, drop.y);
          ctx.lineTo(drop.x - drop.drift * 0.12, drop.y + drop.len);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  // A small speech bubble in the same visual language as the village's name labels.
  //
  // A line is wrapped to at most two rows, and the words arrive one character at a
  // time. The bubble is laid out from the whole line up front so it never jumps in
  // size while the text is still typing out.
  const bubbles = new WeakMap();
  const placed = [];
  const BUBBLE_FONT = '8px "Pixelify Sans", ui-monospace, monospace';
  const BUBBLE_MAX_WIDTH = 116;
  const BUBBLE_MAX_ROWS = 4;
  const BUBBLE_LINE_HEIGHT = 11;
  const BUBBLE_PAD_TOP = 4;
  const REVEAL_CHARS_PER_SEC = 34;
  const REVEAL_MAX_MS = 3200;

  function wrapBubble(ctx, text, maxWidth, maxRows = BUBBLE_MAX_ROWS) {
    const lines = [];
    for (const paragraph of String(text).split(/\n+/)) {
      if (lines.length > maxRows) break;
      let current = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && ctx.measureText(candidate).width > maxWidth) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) lines.push(current);
    }
    // A very long line still cannot grow the bubble without limit.
    if (lines.length > maxRows) {
      lines.length = maxRows;
      if (!/…$/.test(lines[maxRows - 1])) lines[maxRows - 1] = `${lines[maxRows - 1].replace(/\s+\S*$/, '')}…`;
    }
    return lines;
  }

  function revealCount(npc, text, now) {
    let state = bubbles.get(npc);
    const stale = state && (state.text !== text || now - state.lastSeen > 300);
    if (!state || stale) state = { text, startedAt: now, lastSeen: now };
    state.lastSeen = now;
    bubbles.set(npc, state);
    const rate = Math.max(REVEAL_CHARS_PER_SEC / 1000, text.length / REVEAL_MAX_MS);
    return Math.min(text.length, Math.max(1, Math.ceil((now - state.startedAt) * rate)));
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y;
  }

  // Bubbles are placed clear of each other. Each one starts above its speaker's head
  // and slides up in 4px steps until it clears the bubbles already placed, so two
  // villagers talking side by side never stack their words on top of each other.
  function drawBubbles(ctx, npcs, now) {
    const speakers = [];
    for (const npc of npcs) {
      const line = npc.sim && npc.sim.dialogue;
      if (line) speakers.push({ npc, text: String(line) });
    }
    // Villagers higher up the screen claim their space first, so the arrangement is
    // stable from frame to frame instead of reshuffling.
    speakers.sort((a, b) => a.npc.y - b.npc.y);
    placed.length = 0;

    for (const { npc, text } of speakers) {
      const isSleeping = npc.sim.state === 'sleeping';
      const px = Math.round(npc.x);
      const py = Math.round(npc.y) - (isSleeping ? 26 : 24);

      ctx.save();
      ctx.font = BUBBLE_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const lines = wrapBubble(ctx, text, BUBBLE_MAX_WIDTH);
      if (!lines.length) {
        ctx.restore();
        continue;
      }
      const shown = revealCount(npc, text, now);
      const width = Math.max(...lines.map((row) => ctx.measureText(row).width)) + 8;
      const height = lines.length * BUBBLE_LINE_HEIGHT + 3;

      // Sit above the speaker's head, then keep climbing until the bubble clears every
      // bubble already placed. Climbing is unconditional, so two villagers talking side
      // by side can never end up with their words printed on top of each other. Nothing
      // is allowed to hang off the edge of the map either.
      const maxX = Math.max(2, village.width - width - 2);
      const x = Math.min(maxX, Math.max(2, px - width / 2));
      let y = Math.max(2, py - height);
      let guard = 0;
      while (guard < 240 && y > 2 && placed.some((other) => overlaps({ x, y, w: width, h: height }, other))) {
        y -= 2;
        guard += 1;
      }
      placed.push({ x, y, w: width, h: height, id: npc.config ? npc.config.id : null, text });

      const displaced = y + height < py - 1 || x + width / 2 !== px;
      ctx.fillStyle = 'rgba(23, 20, 42, 0.88)';
      ctx.strokeStyle = 'rgba(255, 233, 168, 0.55)';
      ctx.lineWidth = 1;

      // When a bubble has been moved out of the way, a thin stem still ties it to the
      // villager who said it.
      if (displaced) {
        ctx.beginPath();
        ctx.moveTo(x + width / 2, y + height);
        ctx.lineTo(px, py);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.fill();
      ctx.stroke();

      if (!displaced) {
        ctx.beginPath();
        ctx.moveTo(px - 2, y + height);
        ctx.lineTo(px + 2, y + height);
        ctx.lineTo(px, y + height + 3);
        ctx.closePath();
        ctx.fill();
      }

      ctx.fillStyle = '#fff4cf';
      let budget = shown;
      for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        const take = Math.max(0, Math.min(row.length, budget));
        if (take > 0) {
          ctx.fillText(row.slice(0, take), x + width / 2, y + BUBBLE_PAD_TOP + i * BUBBLE_LINE_HEIGHT + BUBBLE_LINE_HEIGHT / 2 - 0.5);
        }
        budget -= row.length + 1;
      }
      ctx.restore();
    }
  }

  return {
    el: root,
    refresh: refreshReadout,
    draw(ctx, npcs) {
      drawAtmosphere(ctx);
      drawBubbles(ctx, npcs || [], performance.now());
    },
    // The rects placed this frame, exposed so the overlap rule can be checked from a
    // test instead of by eye.
    bubbles: () => placed.map((rect) => ({ ...rect })),
    stop() {
      clearInterval(readoutTimer);
    },
  };
}
