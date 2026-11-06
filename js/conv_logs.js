// Conversation logs.
//
// This used to be a button in the tile editor's toolbar. It now lives in the debug dock
// (js/dock.js), so the live and recent conversations, the relationship context and the
// saved transcripts are reachable whether or not either editor is open.
//
// The panel watches the simulation: live conversations, recent ones, full transcripts,
// the relationship context and memories each one produced, and any failed model call.
// It is also the only place a transcript can be written to Supabase, and the only
// place previously saved transcripts are read back.

import { ensureDock, focusPanel } from './dock.js';

const REFRESH_MS = 1000;

const pad = (value) => String(value).padStart(2, '0');

function clockLabel(iso) {
  if (!iso) return '--:--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function durationLabel(start, end) {
  if (!start) return '-';
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function statusLabel(status) {
  return {
    active: 'live',
    complete: 'finished',
    abandoned: 'interrupted',
    failed: 'failed',
  }[status] || status;
}

export function createConvLogs({
  conversations,
  relationships,
  memories,
  news,
  ai,
  roster = [],
  endpoint = '/api/conversations',
}) {
  if (!conversations) return null;

  const dock = ensureDock();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ed-btn';
  button.id = 'ed-logs';
  button.dataset.panel = 'conv-logs';
  button.textContent = 'Logs';
  button.title = 'Conversation logs, relationships and saved transcripts';
  dock.buttons.appendChild(button);

  const section = document.createElement('div');
  section.id = 'conv-logs';
  section.className = 'dock-panel';
  section.hidden = true;
  section.innerHTML = `
    <div class="cl-head">
      <span class="cl-title">Conversation logs</span>
      <span class="cl-live" id="cl-live-count">live 0</span>
    </div>
    <div class="cl-filters">
      <select class="cl-select" id="cl-npc" aria-label="Filter by villager"></select>
      <input class="cl-search" id="cl-search" type="search" placeholder="search lines" aria-label="Search">
      <button type="button" class="ed-btn" id="cl-refresh">Refresh saved</button>
    </div>
    <div class="cl-cols">
      <div class="cl-list-wrap">
        <div class="cl-section">Live now</div>
        <div class="cl-list" id="cl-live"></div>
        <div class="cl-section">Recent conversations</div>
        <div class="cl-list" id="cl-recent"></div>
        <div class="cl-section">Saved to Supabase</div>
        <div class="cl-list" id="cl-saved"></div>
      </div>
      <div class="cl-detail" id="cl-detail">
        <div class="cl-empty">Select a conversation to read it.</div>
      </div>
    </div>
    <div class="cl-foot">
      <span class="cl-note" id="cl-note"></span>
      <button type="button" class="ed-btn ed-primary" id="cl-save" disabled>Save to Supabase</button>
    </div>
  `;
  dock.panels.appendChild(section);

  const liveList = section.querySelector('#cl-live');
  const recentList = section.querySelector('#cl-recent');
  const savedList = section.querySelector('#cl-saved');
  const detail = section.querySelector('#cl-detail');
  const npcFilter = section.querySelector('#cl-npc');
  const searchInput = section.querySelector('#cl-search');
  const noteEl = section.querySelector('#cl-note');
  const saveBtn = section.querySelector('#cl-save');
  const liveCount = section.querySelector('#cl-live-count');
  const refreshBtn = section.querySelector('#cl-refresh');

  const state = {
    selectedId: null,
    selectedSource: 'local',
    savedRows: [],
    savedError: null,
    saving: false,
    savedIds: new Map(),
    note: '',
  };

  let filterNpc = 'all';
  let query = '';

  npcFilter.innerHTML = '<option value="all">All villagers</option>';
  for (const entry of roster) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    npcFilter.appendChild(option);
  }

  function passesFilter(session) {
    if (filterNpc !== 'all' && !session.participants.some((participant) => participant.id === filterNpc)) return false;
    if (!query) return true;
    const needle = query.toLowerCase();
    return session.messages.some((message) => message.text.toLowerCase().includes(needle))
      || session.participants.some((participant) => participant.name.toLowerCase().includes(needle));
  }

  function sessionLabel(session) {
    return session.participants.map((participant) => participant.name).join(' & ');
  }

  function rowFor(session, { live }) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `cl-row ${session.status}${session.id === state.selectedId ? ' is-on' : ''}`;
    const head = document.createElement('div');
    head.className = 'cl-row-head';
    head.innerHTML = `<span class="cl-names">${sessionLabel(session)}</span>
      <span class="cl-badge cl-${session.status}">${statusLabel(session.status)}</span>`;
    const meta = document.createElement('div');
    meta.className = 'cl-row-meta';
    const last = session.messages[session.messages.length - 1];
    const bits = [
      `${session.messageCount}/${session.target || '-'} msgs`,
      live ? 'now' : clockLabel(session.startedAt),
      live ? '' : durationLabel(session.startedAt, session.endedAt),
      session.savedAt ? 'saved' : (!live && session.status !== 'active' ? 'local only' : ''),
      last && last.generatedBy === 'offline' ? 'offline line' : '',
      last && last.generatedBy === 'cached' ? 'cached line' : '',
    ].filter(Boolean);
    meta.textContent = bits.join(' · ');
    row.appendChild(head);
    row.appendChild(meta);
    if (last) {
      const line = document.createElement('div');
      line.className = 'cl-last';
      line.textContent = `${last.speakerName}: ${last.text}`;
      row.appendChild(line);
    }
    row.addEventListener('click', () => {
      state.selectedId = session.id;
      state.selectedSource = 'local';
      render();
    });
    return row;
  }

  function emptyNote(text, className = 'cl-empty') {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    return el;
  }

  function renderLive() {
    const active = conversations.active().filter(passesFilter);
    liveCount.textContent = `live ${active.length}`;
    liveList.innerHTML = '';
    if (!active.length) liveList.appendChild(emptyNote('Nobody is talking right now.'));
    for (const session of active) liveList.appendChild(rowFor(session, { live: true }));
  }

  function renderRecent() {
    const rows = conversations.recent().filter(passesFilter);
    recentList.innerHTML = '';
    if (!rows.length) recentList.appendChild(emptyNote('No conversations yet.'));
    for (const session of rows) {
      const enriched = { ...session };
      if (state.savedIds.has(session.id)) enriched.savedAt = state.savedIds.get(session.id);
      recentList.appendChild(rowFor(enriched, { live: false }));
    }
  }

  function renderSaved() {
    savedList.innerHTML = '';
    if (state.savedError) {
      savedList.appendChild(emptyNote(`Saved transcripts unavailable: ${state.savedError}`));
      return;
    }
    if (!state.savedRows.length) {
      savedList.appendChild(emptyNote('Nothing saved yet. Saving is manual.'));
      return;
    }
    for (const row of state.savedRows) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cl-row saved';
      button.innerHTML = `<div class="cl-row-head"><span class="cl-names">${row.participants.map((p) => p.name).join(' & ') || `${row.initiatorId} & ${row.responderId}`}</span>
        <span class="cl-badge cl-saved">saved</span></div>
        <div class="cl-row-meta">${row.messageCount} msgs · saved ${clockLabel(row.savedAt)} · ${row.outcome || 'complete'}</div>`;
      button.addEventListener('click', () => openSaved(row.id));
      savedList.appendChild(button);
    }
  }

  function relationshipBlock(session) {
    const rows = (session.relationshipChanges && session.relationshipChanges.length)
      ? session.relationshipChanges
      : (session.relationshipAtStart || []);
    if (!rows.length) return '';
    const lines = rows.map((row) => {
      if (row.from && row.to) {
        const arrow = row.from === row.to ? row.to : `${row.from} → ${row.to}`;
        return `<li>${nameOf(row.npcId)} → ${nameOf(row.otherId)}: ${arrow} (${row.delta >= 0 ? '+' : ''}${row.delta})</li>`;
      }
      return `<li>${nameOf(row.npcId)} → ${nameOf(row.otherId)}: ${row.category} (score ${row.score})</li>`;
    });
    return `<div class="cl-block"><div class="cl-block-title">Relationship</div><ul>${lines.join('')}</ul></div>`;
  }

  function nameOf(id) {
    const entry = roster.find((candidate) => candidate.id === id);
    return entry ? entry.name : id;
  }

  function memoryBlock(session) {
    if (!session.memories || !session.memories.length) return '';
    const rows = session.memories.map((memory) => (
      `<li><span class="cl-tag">${memory.kind}</span> ${memory.description}</li>`
    ));
    return `<div class="cl-block"><div class="cl-block-title">Memories kept from this talk</div><ul>${rows.join('')}</ul></div>`;
  }

  function newsBlock(session) {
    if (!session.news || !session.news.length) return '';
    const rows = session.news.map((item) => (
      `<li><a href="${item.url || '#'}" target="_blank" rel="noopener">${item.headline}</a>${item.summary ? `<div class="cl-sub">${item.summary}</div>` : ''}</li>`
    ));
    return `<div class="cl-block"><div class="cl-block-title">News context <span class="cl-sub">BBC News</span></div><ul>${rows.join('')}</ul></div>`;
  }

  function errorBlock(session) {
    if (!session.errors || !session.errors.length) return '';
    const rows = session.errors.map((error) => (
      `<li><span class="cl-tag cl-err">${error.code}</span> ${error.message}${error.mode ? ` <span class="cl-sub">(${error.mode})</span>` : ''}</li>`
    ));
    return `<div class="cl-block"><div class="cl-block-title">Errors</div><ul>${rows.join('')}</ul></div>`;
  }

  function transcriptBlock(messages) {
    if (!messages.length) return '<div class="cl-empty">No messages.</div>';
    const rows = messages.map((message) => {
      const badges = [message.generatedBy === 'offline'
        ? '<span class="cl-tag cl-offline">offline</span>'
        : message.generatedBy === 'cached'
          ? '<span class="cl-tag cl-cached">cached</span>'
          : '<span class="cl-tag cl-groq">model</span>'];
      if (message.closing) badges.push('<span class="cl-tag">closing</span>');
      return `<div class="cl-msg">
        <div class="cl-msg-head"><span class="cl-speaker">${message.speakerName}</span>
        <span class="cl-sub">#${message.number} · ${clockLabel(message.at)}</span>${badges.join('')}</div>
        <div class="cl-text">${escapeHtml(message.text)}</div>
      </div>`;
    });
    return `<div class="cl-transcript">${rows.join('')}</div>`;
  }

  function renderDetail() {
    if (!state.selectedId) {
      detail.innerHTML = '<div class="cl-empty">Select a conversation to read it.</div>';
      saveBtn.disabled = true;
      return;
    }

    if (state.selectedSource === 'saved') {
      const saved = state.savedConversation;
      if (!saved) {
        detail.innerHTML = '<div class="cl-empty">Loading saved transcript…</div>';
        saveBtn.disabled = true;
        return;
      }
      const session = saved.conversation;
      detail.innerHTML = `
        <div class="cl-detail-head">
          <div>
            <div class="cl-detail-title">${session.participants.map((p) => p.name).join(' & ')}</div>
            <div class="cl-sub">${session.initiatorId} & ${session.responderId} · saved ${clockLabel(session.savedAt)}</div>
          </div>
          <span class="cl-badge cl-saved">in Supabase</span>
        </div>
        <div class="cl-meta">
          <span>started ${clockLabel(session.startedAt)}</span>
          <span>ended ${clockLabel(session.endedAt)}</span>
          <span>${session.messageCount} messages</span>
          <span>outcome ${session.outcome || 'complete'}</span>
        </div>
        ${transcriptBlock(saved.messages)}
        ${relationshipBlock(session)}
        ${memoryBlock(session)}
        ${newsBlock(session)}
        ${session.error ? `<div class="cl-block"><div class="cl-block-title">Error</div><div>${escapeHtml(session.error)}</div></div>` : ''}
      `;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saved';
      return;
    }

    const session = conversations.byId(state.selectedId);
    if (!session) {
      detail.innerHTML = '<div class="cl-empty">That conversation is no longer in memory.</div>';
      saveBtn.disabled = true;
      return;
    }

    const savedAt = state.savedIds.get(session.id) || session.savedAt;
    const duration = durationLabel(session.startedAt, session.endedAt);
    detail.innerHTML = `
      <div class="cl-detail-head">
        <div>
          <div class="cl-detail-title">${sessionLabel(session)}</div>
          <div class="cl-sub">${session.participants.map((p) => p.id).join(' & ')} · ${session.id}</div>
        </div>
        <span class="cl-badge cl-${session.status}">${statusLabel(session.status)}</span>
        ${savedAt ? '<span class="cl-badge cl-saved">saved</span>' : ''}
      </div>
      <div class="cl-meta">
        <span>started ${clockLabel(session.startedAt)}</span>
        <span>${session.status === 'active' ? 'live' : `lasted ${duration}`}</span>
        <span>${session.messageCount} / ${session.target} messages</span>
        ${session.closeReason ? `<span>reason ${session.closeReason}</span>` : ''}
        ${session.mood === 'tense' ? '<span class="cl-tag cl-err">tense</span>' : ''}
        ${session.topic ? `<span>topic: ${escapeHtml(session.topic)}</span>` : ''}
        <span>${savedAt ? 'saved to Supabase' : 'local only · not saved'}</span>
      </div>
      ${transcriptBlock(session.messages)}
      ${relationshipBlock(session)}
      ${memoryBlock(session)}
      ${newsBlock(session)}
      ${errorBlock(session)}
    `;

    saveBtn.disabled = !!savedAt || state.saving || session.messageCount === 0;
    saveBtn.textContent = savedAt ? 'Saved' : state.saving ? 'Saving…' : 'Save to Supabase';
  }

  function renderNote() {
    const status = relationships ? relationships.status() : null;
    const memoryStatus = memories ? memories.status() : null;
    const aiStatus = ai ? ai.status() : null;
    const bits = [];
    if (aiStatus) {
      bits.push(aiStatus.configured ? `model ${aiStatus.model}` : 'model offline (no server key)');
    }
    if (conversations && conversations.dialogueStatus) {
      const dialogue = conversations.dialogueStatus();
      bits.push(`dialogue ${dialogue.mode}${dialogue.fallback ? ' (fallback)' : ''}`);
    }
    // both queues report the number of successful saves, and how many rows are
    // still waiting to go out
    if (status) bits.push(`relationships ${status.saves} saved${status.pending ? `, ${status.pending} pending` : ''}`);
    if (memoryStatus) bits.push(`memories ${memoryStatus.saves} saved${memoryStatus.pending ? `, ${memoryStatus.pending} pending` : ''}`);
    if (status && status.persistBlocked) bits.push('persistence off: no Supabase');
    // a rejected save or load is named here, so "nothing in Supabase" is never a
    // mystery: the real message from the deployment is on screen
    if (status && (status.saveError || status.loadError)) {
      bits.push(`relationships: ${status.saveError || status.loadError}`);
    }
    if (news) {
      const newsStatus = news.status();
      bits.push(`news ${newsStatus.items} cached`);
    }
    if (state.note) bits.push(state.note);
    noteEl.textContent = bits.join(' · ');
  }

  function render() {
    renderLive();
    renderRecent();
    renderSaved();
    renderDetail();
    renderNote();
  }

  async function refreshSaved() {
    state.savedError = null;
    try {
      const res = await fetch(`${endpoint}?list=1&t=${Date.now()}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        state.savedError = (body && body.error && body.error.message) || `request failed (${res.status})`;
        state.savedRows = [];
      } else {
        state.savedRows = body.conversations || [];
        for (const row of state.savedRows) state.savedIds.set(row.id, row.savedAt);
      }
    } catch {
      state.savedError = 'could not reach the server';
      state.savedRows = [];
    }
    render();
  }

  async function openSaved(id) {
    state.selectedId = id;
    state.selectedSource = 'saved';
    state.savedConversation = null;
    renderDetail();
    try {
      const res = await fetch(`${endpoint}?id=${encodeURIComponent(id)}&t=${Date.now()}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        state.savedError = (body && body.error && body.error.message) || 'could not load that transcript';
        detail.innerHTML = `<div class="cl-empty">${state.savedError}</div>`;
        return;
      }
      state.savedConversation = body;
    } catch {
      detail.innerHTML = '<div class="cl-empty">Could not load that transcript.</div>';
      return;
    }
    renderDetail();
  }

  async function saveSelected() {
    const session = conversations.byId(state.selectedId);
    if (!session || state.saving) return;
    state.saving = true;
    renderDetail();
    state.note = 'saving transcript…';
    renderNote();

    const relationshipContext = {
      atStart: session.relationshipAtStart,
      changes: session.relationshipChanges,
    };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation: {
            id: session.id,
            initiatorId: session.initiatorId,
            responderId: session.responderId,
            participants: session.participants,
            startedAt: session.startedAt,
            endedAt: session.endedAt || new Date().toISOString(),
            messageCount: session.messageCount,
            outcome: session.outcome || 'complete',
            relationshipContext,
            newsRefs: session.news,
            memories: session.memories,
            error: session.errors.length ? session.errors[session.errors.length - 1].message : null,
          },
          messages: session.messages.map((message) => ({
            id: message.id,
            speakerId: message.speakerId,
            speakerName: message.speakerName,
            text: message.text,
            at: message.at,
            number: message.number,
            generatedBy: message.generatedBy,
            closing: message.closing,
          })),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        state.note = `save failed: ${(body && body.error && body.error.message) || res.status}`;
      } else {
        const savedAt = (body.conversation && body.conversation.savedAt) || new Date().toISOString();
        state.savedIds.set(session.id, savedAt);
        state.note = body.alreadySaved
          ? 'already saved earlier — nothing duplicated'
          : `saved ${body.savedMessages} messages`;
        refreshSaved();
      }
    } catch {
      state.note = 'save failed: could not reach the server';
    } finally {
      state.saving = false;
      render();
    }
  }

  saveBtn.addEventListener('click', saveSelected);
  refreshBtn.addEventListener('click', refreshSaved);
  npcFilter.addEventListener('change', () => {
    filterNpc = npcFilter.value;
    render();
  });
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim();
    render();
  });

  button.addEventListener('click', () => {
    section.hidden = !section.hidden;
    button.classList.toggle('is-on', !section.hidden);
    if (!section.hidden) {
      focusPanel(section);
      render();
      refreshSaved();
    }
  });

  const timer = setInterval(() => {
    if (section.hidden) return;
    render();
  }, REFRESH_MS);

  return {
    button,
    section,
    open() {
      section.hidden = false;
      button.classList.add('is-on');
      render();
      refreshSaved();
    },
    close() {
      section.hidden = true;
      button.classList.remove('is-on');
    },
    refresh: render,
    refreshSaved,
    select: (id) => {
      state.selectedId = id;
      state.selectedSource = 'local';
      render();
    },
    saveSelected,
    stop: () => clearInterval(timer),
  };
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
