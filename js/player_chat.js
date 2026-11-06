// The one-line player chat menu.
//
// Press / near a villager to choose someone, or to join a conversation already in
// progress. Once a chat is open the same input becomes the player's line; NPCs
// answer through the normal conversation manager, including its offline fallback.

const REACH_TILES = 5;

function participantNames(snapshot, npcs) {
  return snapshot.participants.map((participant) => {
    const npc = npcs.find((candidate) => candidate.config && candidate.config.id === participant.id);
    return npc ? npc.name : participant.name;
  });
}

export function createPlayerChat({ state, conversations, getNpcs, getPlayer }) {
  let open = false;
  let mode = 'choose';
  let sessionId = null;
  let choices = [];
  let selected = 0;
  let timer = null;
  let ended = false;

  const root = document.createElement('div');
  root.id = 'player-chat';
  root.hidden = true;
  root.innerHTML = `
    <div class="pc-panel">
      <div class="pc-head">
        <span class="pc-title" id="pc-title">Talk</span>
        <span class="pc-keys">/ open · Enter send/close</span>
      </div>
      <div class="pc-log" id="pc-log" hidden></div>
      <div class="pc-choices" id="pc-choices"></div>
      <form class="pc-say" id="pc-form">
        <input class="pc-input" id="pc-input" type="text" maxlength="180" autocomplete="off" spellcheck="false" aria-label="Chat">
        <button class="ed-btn ed-primary" id="pc-send" type="submit">Say</button>
      </form>
      <div class="pc-status" id="pc-status"></div>
    </div>
  `;
  document.body.appendChild(root);

  const titleEl = root.querySelector('#pc-title');
  const logEl = root.querySelector('#pc-log');
  const choicesEl = root.querySelector('#pc-choices');
  const form = root.querySelector('#pc-form');
  const input = root.querySelector('#pc-input');
  const sendBtn = root.querySelector('#pc-send');
  const statusEl = root.querySelector('#pc-status');

  const player = () => (getPlayer ? getPlayer() : null);
  const npcById = (id) => getNpcs().find((npc) => npc.config && npc.config.id === id) || null;
  const snapshot = () => (sessionId ? conversations.byId(sessionId) : null);
  const T = state.village.tileSize;

  function distanceTo(npc, who) {
    return Math.hypot(npc.x - who.x, npc.y - who.y);
  }

  function nearbySessions(who) {
    const npcs = getNpcs();
    return conversations.active()
      .filter((session) => session.status === 'active' && !session.humanId && session.participants.length <= 2)
      .map((session) => {
        const members = session.participants
          .map((participant) => npcById(participant.id))
          .filter((npc) => npc && !npc.room);
        if (!members.length) return null;
        // Join only when the whole little group is in reach. If one of them is still
        // across the village, the chat is being walked to, not held here yet.
        const gap = Math.max(...members.map((npc) => distanceTo(npc, who)));
        if (gap > REACH_TILES * T) return null;
        return {
          type: 'join',
          id: session.id,
          label: `Join ${participantNames(session, npcs).join(' and ')}`,
          sub: 'conversation in progress',
          gap,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.gap - b.gap);
  }

  function nearbyNpcs(who) {
    return getNpcs()
      .filter((npc) => npc !== who && npc.config && !npc.room)
      .filter((npc) => !npc.sim || !npc.sim.session)
      .filter((npc) => distanceTo(npc, who) <= REACH_TILES * T)
      .sort((a, b) => distanceTo(a, who) - distanceTo(b, who))
      .map((npc) => ({
        type: 'talk',
        npc,
        label: `Talk to ${npc.name || 'villager'}`,
        sub: 'start a conversation',
        gap: distanceTo(npc, who),
      }));
  }

  function buildChoices() {
    const who = player();
    choices = [];
    if (!who) return;
    choices = [...nearbySessions(who), ...nearbyNpcs(who)];
    selected = Math.min(selected, Math.max(0, choices.length - 1));
  }

  function visibleChoices() {
    const query = mode === 'choose' ? input.value.trim().toLowerCase() : '';
    if (!query) return choices;
    return choices.filter((choice) => choice.label.toLowerCase().includes(query));
  }

  function renderChoices() {
    const visible = visibleChoices();
    choicesEl.innerHTML = '';
    if (!choices.length) {
      const empty = document.createElement('div');
      empty.className = 'pc-empty';
      empty.textContent = 'Nobody close enough. Walk nearer to a villager.';
      choicesEl.appendChild(empty);
      statusEl.textContent = 'Press Enter to close.';
      return;
    }
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'pc-empty';
      empty.textContent = 'No matching name.';
      choicesEl.appendChild(empty);
      statusEl.textContent = 'Enter to close · Backspace to see everyone.';
      return;
    }
    selected = Math.min(selected, visible.length - 1);
    visible.forEach((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pc-choice';
      if (index === selected) button.classList.add('is-on');
      const label = document.createElement('span');
      label.className = 'pc-choice-label';
      label.textContent = choice.label;
      const sub = document.createElement('span');
      sub.className = 'pc-choice-sub';
      sub.textContent = choice.sub;
      button.append(label, sub);
      button.addEventListener('click', () => choose(choice));
      choicesEl.appendChild(button);
    });
    statusEl.textContent = visible.length === 1
      ? 'Enter to choose.'
      : 'Enter to choose · ↑↓ to move.';
  }

  function setChooseMode() {
    mode = 'choose';
    ended = false;
    sessionId = null;
    titleEl.textContent = 'Talk';
    logEl.hidden = true;
    choicesEl.hidden = false;
    form.hidden = false;
    input.disabled = !player();
    sendBtn.disabled = !player();
    input.value = '';
    input.placeholder = player() ? 'Find someone nearby…' : 'No character selected';
    buildChoices();
    renderChoices();
    requestAnimationFrame(() => input.focus());
  }

  function setEmptyMode(message, hint = 'Press I to spawn a character.') {
    mode = 'empty';
    titleEl.textContent = 'No character yet';
    logEl.hidden = true;
    choicesEl.hidden = false;
    choicesEl.innerHTML = `<div class="pc-empty">${message}</div>`;
    form.hidden = true;
    statusEl.textContent = hint;
  }

  function addLogLine(message) {
    const row = document.createElement('div');
    row.className = 'pc-line';
    if (message.generatedBy === 'player') row.classList.add('is-player');
    const who = document.createElement('span');
    who.className = 'pc-speaker';
    who.textContent = message.speakerName;
    const text = document.createElement('span');
    text.className = 'pc-text';
    text.textContent = message.text;
    row.append(who, text);
    logEl.appendChild(row);
  }

  function renderSession(snap) {
    if (!snap) {
      mode = 'ended';
      ended = true;
      statusEl.textContent = 'That conversation has ended.';
      input.disabled = true;
      sendBtn.disabled = true;
      return;
    }
    const names = participantNames(snap, getNpcs());
    const me = getPlayer();
    const others = snap.participants
      .map((participant, index) => ({ ...participant, displayName: names[index] || participant.name }))
      .filter((participant) => !me || participant.id !== me.config.id);
    const otherNames = others.map((participant) => participant.displayName);
    const active = snap.status === 'active';
    ended = !active;
    titleEl.textContent = active
      ? (otherNames.length ? `Chatting with ${otherNames.join(' & ')}` : 'Conversation')
      : 'Conversation ended';
    choicesEl.hidden = true;
    logEl.hidden = false;
    form.hidden = false;
    logEl.innerHTML = '';
    for (const message of snap.messages.slice(-4)) addLogLine(message);
    logEl.scrollTop = logEl.scrollHeight;

    if (!active) {
      mode = 'ended';
      input.disabled = true;
      sendBtn.disabled = true;
      statusEl.textContent = snap.closeReason === 'session_cap'
        ? 'The chat came to a natural end. Enter to close.'
        : `Ended: ${snap.closeReason || snap.outcome}. Enter to close.`;
      return;
    }

    mode = 'say';
    const waiting = !!snap.pending;
    input.disabled = waiting || !snap.awaitingHuman;
    sendBtn.disabled = input.disabled;
    const other = otherNames;
    input.placeholder = other.length
      ? `Say something to ${other.join(' & ')}…`
      : 'Say something…';
    if (waiting) statusEl.textContent = `${other.join(' & ') || 'They'} ${other.length > 1 ? 'are' : 'is'} thinking…`;
    else if (snap.awaitingHuman) statusEl.textContent = 'Your turn. Type, then Enter. Empty Enter closes.';
    else statusEl.textContent = 'Listening…';
    if (snap.awaitingHuman && !waiting) input.focus();
  }

  function poseForChat(session) {
    const who = player();
    if (!who || !session) return;
    const ids = new Set(session.participants.map((participant) => participant.id));
    const members = getNpcs().filter((npc) => npc.config && ids.has(npc.config.id));
    const anchor = members.find((npc) => npc !== who) || null;

    who.path = [];
    who.moving = false;
    who.waitTime = 1e9;
    who.sim = who.sim || {};
    who.sim.state = 'talking';
    who.sim.partner = anchor;
    who.sim.session = session;
    who.sim.timer = 600;
    who.sim.dialogue = null;
    who.sim.approachTime = 0;

    for (const npc of members) {
      if (npc === who) continue;
      npc.path = [];
      npc.moving = false;
      npc.waitTime = 1e9;
      npc.sim = npc.sim || {};
      npc.sim.state = 'talking';
      npc.sim.session = session;
      npc.sim.timer = 600;
      npc.sim.approachTime = 0;
      if (!npc.sim.partner || !npc.sim.partner.config || !ids.has(npc.sim.partner.config.id)) {
        npc.sim.partner = who;
      }
      if (!npc.sim.dialogue) npc.sim.dialogue = '…';
    }
    if (anchor) {
      who.facing = anchor.x >= who.x ? 1 : -1;
      anchor.facing = who.x >= anchor.x ? 1 : -1;
    }
  }

  function choose(choice) {
    const who = player();
    if (!who || !choice) return;
    let session = null;
    if (choice.type === 'join') {
      session = conversations.joinPlayer(choice.id, who);
      if (!session) {
        statusEl.textContent = 'They cannot take another voice right now.';
        return;
      }
    } else if (choice.type === 'talk') {
      session = conversations.beginPlayer(who, choice.npc);
      if (!session) {
        statusEl.textContent = 'They are not free to talk.';
        return;
      }
    }
    if (!session) return;
    sessionId = session.id;
    ended = false;
    poseForChat(session);
    setSayMode(snapshot());
    schedulePoll();
  }

  function setSayMode(snap) {
    if (!snap) {
      setChooseMode();
      return;
    }
    mode = 'say';
    logEl.hidden = false;
    choicesEl.hidden = true;
    form.hidden = false;
    renderSession(snap);
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (!open || !sessionId) return;
    timer = setTimeout(() => {
      if (!open || !sessionId) return;
      const snap = snapshot();
      if (!snap) {
        mode = 'ended';
        ended = true;
        statusEl.textContent = 'That conversation has ended.';
        input.disabled = true;
        sendBtn.disabled = true;
        return;
      }
      renderSession(snap);
      if (snap.status === 'active') schedulePoll();
    }, 180);
  }

  function submit() {
    if (mode === 'ended' || mode === 'empty') {
      close();
      return;
    }
    if (mode === 'choose') {
      const visible = visibleChoices();
      const choice = visible[selected] || visible[0];
      if (choice) choose(choice);
      else close();
      return;
    }
    if (mode !== 'say' || !sessionId) return;
    const text = input.value.trim();
    if (!text) {
      close();
      return;
    }
    const result = conversations.playerSay(sessionId, text);
    if (!result.ok) {
      statusEl.textContent = result.reason;
      return;
    }
    input.value = '';
    renderSession(result.session);
    schedulePoll();
  }

  function close() {
    if (sessionId && !ended) conversations.leavePlayer(sessionId, 'player_left');
    sessionId = null;
    open = false;
    ended = false;
    root.hidden = true;
    clearTimeout(timer);
    timer = null;
    input.value = '';
    if (state.player) state.player.clearKeys();
  }

  function openChat() {
    if (open) {
      if (sessionId && snapshot()) setSayMode(snapshot());
      else setChooseMode();
      input.focus();
      return;
    }
    open = true;
    root.hidden = false;
    selected = 0;
    if (!player()) {
      const hero = state.heroId && state.roster
        ? state.roster.find((entry) => entry.id === state.heroId)
        : null;
      setEmptyMode(
        hero ? `Press I to spawn ${hero.name} on a random bed.` : 'Create a character in the NPC studio and press Play as.',
        hero ? 'I spawns and removes them.' : 'Open the NPC studio, choose a character and press Play as.',
      );
      return;
    }
    if (sessionId) {
      const snap = snapshot();
      if (snap && snap.status === 'active') {
        setSayMode(snap);
        schedulePoll();
        return;
      }
      sessionId = null;
    }
    setChooseMode();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (mode !== 'choose') return;
    const visible = visibleChoices();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = Math.min(visible.length - 1, selected + 1);
      renderChoices();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = Math.max(0, selected - 1);
      renderChoices();
    }
  });

  input.addEventListener('input', () => {
    if (mode === 'choose') renderChoices();
  });

  window.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') {
      if (event.target === input) return;
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter' && (mode === 'ended' || mode === 'empty')) {
      if (event.target === input) return;
      event.preventDefault();
      close();
    }
  });

  return {
    open: openChat,
    close,
    isOpen: () => open,
    refresh: () => {
      if (!open) return;
      if (sessionId) renderSession(snapshot());
      else setChooseMode();
    },
  };
}
