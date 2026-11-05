// A small retry engine for background persistence.
//
// Relationships and memories are written by one of these each. It is deliberately
// dumb: run the batch, if it fails wait a bit and run it again, and never let a
// failed save break the simulation or block the next one.

export function createRetryQueue({ run, delays = [1200, 4000, 12000, 30000], onStatus = null } = {}) {
  const state = {
    running: false,
    attempts: 0,
    lastError: null,
    lastOkAt: 0,
    queued: false,
    saved: 0,
    failed: 0,
  };
  let timer = null;

  function notify() {
    if (onStatus) {
      try {
        onStatus({ ...state });
      } catch {
        // the status callback is for the panel; it must never affect saving
      }
    }
  }

  function schedule(delay) {
    state.queued = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      drain();
    }, Math.max(0, delay));
  }

  async function drain() {
    if (state.running) {
      state.queued = true;
      return;
    }
    state.running = true;
    state.queued = false;
    let result;
    try {
      result = await run();
    } catch (error) {
      result = { ok: false, error: error && error.message ? error.message : String(error) };
    }
    state.running = false;

    if (result && result.ok) {
      state.saved += Number(result.saved) || 0;
      state.attempts = 0;
      state.lastOkAt = Date.now();
      state.lastError = null;
      notify();
      // anything that arrived while the request was in flight goes out straight away
      if (state.queued) schedule(30);
      return;
    }

    state.failed += 1;
    state.attempts += 1;
    state.lastError = (result && result.error) || 'save failed';
    notify();
    const delay = delays[Math.min(state.attempts - 1, delays.length - 1)];
    schedule(delay);
  }

  return {
    // Ask for a flush. Coalesces: ten changes in a second make one request.
    schedule: () => schedule(0),
    stop: () => { if (timer) clearTimeout(timer); timer = null; },
    status: () => ({ ...state }),
  };
}
