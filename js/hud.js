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
    bits.push(clock.isOverridden() ? 'debug time' : 'real time');
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

  function drawBubbles(ctx, npcs, now) {
    for (const npc of npcs) {
      const line = npc.sim && npc.sim.dialogue;
      if (!line) continue;
      const isSleeping = npc.sim.state === 'sleeping';
      const px = Math.round(npc.x);
      const py = Math.round(npc.y) - (isSleeping ? 26 : 24);

      ctx.save();
      ctx.font = BUBBLE_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const text = String(line);
      const lines = wrapBubble(ctx, text, BUBBLE_MAX_WIDTH);
      if (!lines.length) {
        ctx.restore();
        continue;
      }
      const shown = revealCount(npc, text, now);
      const width = Math.max(...lines.map((row) => ctx.measureText(row).width)) + 8;
      const height = lines.length * BUBBLE_LINE_HEIGHT + 3;
      const x = px - width / 2;
      const y = py - height;
      ctx.fillStyle = 'rgba(23, 20, 42, 0.88)';
      ctx.strokeStyle = 'rgba(255, 233, 168, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px - 2, y + height);
      ctx.lineTo(px + 2, y + height);
      ctx.lineTo(px, y + height + 3);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff4cf';
      let budget = shown;
      for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        const take = Math.max(0, Math.min(row.length, budget));
        if (take > 0) {
          ctx.fillText(row.slice(0, take), px, y + BUBBLE_PAD_TOP + i * BUBBLE_LINE_HEIGHT + BUBBLE_LINE_HEIGHT / 2 - 0.5);
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
    stop() {
      clearInterval(readoutTimer);
    },
  };
}
