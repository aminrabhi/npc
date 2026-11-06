// The browser's only door to the language model.
//
// Every call goes to /api/chat, which holds the Groq key. There is no Groq key, URL
// or model prompt construction in this file on purpose: the browser sends context,
// the server builds the prompt.
//
// When the server has no key (or Groq is unreachable) the village keeps living on a
// small offline line bank, and every one of those lines is marked as offline in the
// Conversation Logs panel. A failure is never disguised as a generated line.

const CHAT_URL = '/api/chat';
const STATUS_URL = '/api/status';

export function createAiClient({
  chatUrl = CHAT_URL,
  statusUrl = STATUS_URL,
  timeoutMs = 16_000,
  maxErrors = 60,
} = {}) {
  const stats = {
    requests: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    offline: 0,
    totalMs: 0,
    lastMs: null,
    lastError: null,
  };
  const errors = [];
  // Groq is an enhancement, never a dependency. When a call fails the model is left
  // alone until a cooldown expires - ten villagers must not hammer a rate-limited
  // API - and the village keeps talking on cached and procedural dialogue in the
  // meantime. When the cooldown ends, the next line tries the model again.
  const gate = {
    coolingUntil: 0,
    failures: 0,
    lastFailureAt: null,
    lastFailureCode: null,
    lastRetryAfter: null,
    lastSuccessAt: null,
  };
  const RATE_CODES = new Set([
    'groq_rate_limited', 'server_rate_limited', 'client_rate_limited', 'http_429',
    'rate_limited', 'rate_limit_exceeded', 'rate_limit_error',
  ]);
  // The model answered, the answer was unusable: worth a short pause, not a long one.
  const CONTENT_CODES = new Set(['groq_village_talk', 'groq_empty_reply']);
  const status = {
    checked: false,
    configured: false,
    model: null,
    backend: 'unknown',
    supabase: false,
    news: false,
    missing: [],
    error: null,
    checkedAt: 0,
  };

  function noteError(error, scope = 'chat') {
    const entry = {
      at: new Date().toISOString(),
      scope,
      code: error && error.code ? error.code : 'unknown',
      message: error && error.message ? error.message : String(error),
    };
    stats.lastError = entry;
    errors.unshift(entry);
    if (errors.length > maxErrors) errors.length = maxErrors;
    return entry;
  }

  function noteFailure(error, httpStatus = 0) {
    const code = error && error.code ? error.code : 'unknown';
    gate.failures += 1;
    gate.lastFailureAt = Date.now();
    gate.lastFailureCode = code;

    if (CONTENT_CODES.has(code)) {
      gate.coolingUntil = Date.now() + 15_000;
      return;
    }

    const retryAfter = Number(error && error.retryAfter) || null;
    gate.lastRetryAfter = retryAfter;
    const step = Math.min(gate.failures - 1, 3);
    let ms;
    // the route maps provider errors to its own codes, but a raw provider code is
    // still a rate limit: treat any "rate limit" wording as one
    if (RATE_CODES.has(code) || /rate.?limit/i.test(code) || httpStatus === 429) {
      // honour the server's own retry-after first, then back off further if it keeps
      // happening; never more than ten minutes
      ms = Math.max((retryAfter || 45) * 1000, 45_000) * Math.min(4, 1 + step * 0.5);
      ms = Math.min(ms, 10 * 60_000);
    } else if (code === 'groq_auth_failed' || code === 'groq_model_unavailable' || code === 'groq_not_configured') {
      // a wrong key or model is not going to fix itself in the next minute
      ms = 5 * 60_000;
    } else {
      ms = Math.min(5 * 60_000, 30_000 * Math.min(8, 1 + step * 2));
    }
    gate.coolingUntil = Date.now() + ms;
  }

  function noteSuccess() {
    gate.failures = 0;
    gate.coolingUntil = 0;
    gate.lastFailureCode = null;
    gate.lastSuccessAt = Date.now();
  }

  function canGenerate() {
    if (!status.configured) return false;
    return Date.now() >= gate.coolingUntil;
  }

  function availability() {
    const remaining = Math.max(0, Math.ceil((gate.coolingUntil - Date.now()) / 1000));
    return {
      configured: !!status.configured,
      available: canGenerate(),
      fallback: !canGenerate(),
      coolingDown: remaining > 0,
      cooldownSeconds: remaining,
      retryAt: gate.coolingUntil ? new Date(gate.coolingUntil).toISOString() : null,
      failures: gate.failures,
      lastFailureCode: gate.lastFailureCode,
      lastFailureAt: gate.lastFailureAt ? new Date(gate.lastFailureAt).toISOString() : null,
      lastSuccessAt: gate.lastSuccessAt ? new Date(gate.lastSuccessAt).toISOString() : null,
      model: status.model,
    };
  }

  // Drop the cooldown and ask the status route again: used by the debug panel's
  // "Try Groq now" button, and by anything that knows the network just came back.
  async function recover() {
    gate.coolingUntil = 0;
    gate.failures = 0;
    return probe();
  }

  async function probe() {
    try {
      const res = await fetch(`${statusUrl}?t=${Date.now()}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      status.checked = true;
      status.checkedAt = Date.now();
      if (!res.ok || !body || !body.ok) {
        status.configured = false;
        status.error = (body && body.error && body.error.message) || `status ${res.status}`;
        status.backend = 'unavailable';
        return status;
      }
      const wasConfigured = status.configured;
      status.configured = !!(body.groq && body.groq.configured);
      status.model = body.groq ? body.groq.model : null;
      // A key appearing, or a deployment waking up, is a reason to try again now.
      if (status.configured && !wasConfigured) noteSuccess();
      status.backend = status.configured ? 'groq' : 'offline';
      status.supabase = !!(body.supabase && body.supabase.configured);
      status.news = !!(body.news && body.news.cachedItems !== undefined);
      status.missing = body.missing || [];
      status.error = status.configured ? null : `Missing: ${(status.missing || []).join(', ') || 'GROQ_API_KEY'}`;
      return status;
    } catch (error) {
      status.checked = true;
      status.checkedAt = Date.now();
      status.configured = false;
      status.backend = 'unavailable';
      status.error = 'The village server is not answering.';
      noteError({ code: 'no_server', message: status.error }, 'status');
      return status;
    }
  }

  async function generate(payload, { signal = null } = {}) {
    stats.requests += 1;
    if (!status.configured) {
      stats.offline += 1;
      return { ok: false, error: { code: 'offline', message: status.error || 'Groq is not configured.' } };
    }
    // Cooling down after a failure: do not touch the API at all. The caller falls
    // back to cached or procedural dialogue, which is not an error.
    if (!canGenerate()) {
      stats.skipped += 1;
      const seconds = Math.max(1, Math.ceil((gate.coolingUntil - Date.now()) / 1000));
      return {
        ok: false,
        skipped: true,
        error: { code: 'groq_cooldown', message: `Groq is cooling down for ${seconds}s.` },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const abort = () => controller.abort(new Error('cancelled'));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const started = performance.now();

    try {
      const res = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      const ms = Math.round(performance.now() - started);
      stats.lastMs = ms;
      stats.totalMs += ms;

      if (!res.ok || !body || !body.ok) {
        const error = body && body.error ? body.error : { code: `http_${res.status}`, message: `Request failed (${res.status}).` };
        stats.failed += 1;
        noteError(error);
        noteFailure(error, res.status);
        return { ok: false, error, status: res.status };
      }

      stats.ok += 1;
      noteSuccess();
      return {
        ok: true,
        text: body.message.text,
        extra: Array.isArray(body.message.extra)
          ? body.message.extra.filter((part) => typeof part === 'string' && part.trim()).slice(0, 2)
          : [],
        model: body.message.model,
        messageNumber: body.message.messageNumber,
        usage: body.usage,
        ms,
      };
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      stats.lastMs = ms;
      stats.failed += 1;
      const code = controller.signal.aborted ? 'timeout' : 'network';
      const message = controller.signal.aborted
        ? 'The model did not answer in time.'
        : 'Could not reach the village server.';
      noteError({ code, message });
      noteFailure({ code, message }, 0);
      return { ok: false, error: { code, message } };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  return {
    probe,
    recover,
    generate,
    noteError,
    canGenerate,
    availability,
    status: () => ({ ...status }),
    stats: () => ({ ...stats }),
    errors: () => errors.slice(),
    clearErrors: () => { errors.length = 0; },
  };
}

// Offline line banks, used only when the model cannot answer. They are short,
// personality-flavoured and rotated, so a village with no key still has conversations
// instead of ten villagers staring at each other.
const OFFLINE = {
  opening: {
    blunt: ['You look like you have something to say.', 'Say it quick, I am working.'],
    warm: ['Oh, hello dear. Nice to see you out.', 'Come sit with me a minute.'],
    chatty: ['There you are! I have so much to tell you.', 'Wait till you hear what I heard.'],
    wry: ['Let me guess. You want something.', 'I was enjoying the silence, but go on.'],
    quiet: ['You are here. Good.', 'I was thinking about something.'],
    formal: ['Good day. Do you have a moment?', 'I have been meaning to speak with you.'],
    kid: ['Hi! Guess what!', 'Do you want to see something cool?'],
    plain: ['Morning. How are you keeping?', 'Good to see you about.'],
  },
  reply: {
    blunt: ['Fair enough.', 'That is not how I see it.'],
    warm: ['That is kind of you to say.', 'Bless you, I was thinking the same.'],
    chatty: ['Right? Exactly what I said!', 'No way, tell me the rest.'],
    wry: ['Bold of you to say that out loud.', 'I will pretend I did not hear that.'],
    quiet: ['Maybe.', 'That could be true.'],
    formal: ['I understand your meaning.', 'That is a fair position.'],
    kid: ['Wow, really?', 'That is so boring. I like it anyway.'],
    plain: ['Aye, that sounds right.', 'Makes sense to me.'],
  },
  closing: {
    blunt: ['Right. Back to it.', 'We will talk later.'],
    warm: ['Off you go, dear. Mind yourself.', 'Come by the garden sometime.'],
    chatty: ['Okay okay, I will let you go!', 'Tell me the rest later!'],
    wry: ['Well. This was almost pleasant.', 'I will be here, being mysterious.'],
    quiet: ['I should go.', 'Until later, then.'],
    formal: ['Good day to you.', 'We will speak again soon.'],
    kid: ['Bye! I have to go now.', 'Okay bye, this was fun!'],
    plain: ['See you around.', 'Take care now.'],
  },
};

export function offlineLine(profile, { mode = 'reply', rng = Math.random } = {}) {
  const style = profile && profile.style && OFFLINE[mode][profile.style] ? profile.style : 'plain';
  const bank = OFFLINE[mode][style];
  return bank[Math.floor(rng() * bank.length)];
}
