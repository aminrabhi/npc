// Small HTTP helpers shared by every API route: JSON bodies, method checks, error
// shaping and a per-instance rate limiter.
//
// The routes are plain Vercel Node functions, so this only uses the request and
// response objects those hand over.

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(text);
}

export function requireMethod(req, ...allowed) {
  const method = (req.method || 'GET').toUpperCase();
  if (!allowed.includes(method)) {
    throw new HttpError(405, 'method_not_allowed', `${method} is not allowed here.`, {
      allow: allowed,
    });
  }
  return method;
}

const MAX_BODY = 256 * 1024;

export async function readJson(req) {
  let body = req.body;
  if (body === undefined || body === null || body === '') {
    // Vercel parses JSON bodies for us; the local runner hands over a stream.
    body = await readStream(req);
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    if (text.length > MAX_BODY) throw new HttpError(413, 'body_too_large', 'Request body is too large.');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
    }
  }
  if (body && typeof body === 'object') return body;
  return {};
}

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new HttpError(413, 'body_too_large', 'Request body is too large.'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

export function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : (forwarded || '').split(',')[0].trim();
  return ip || req.socket?.remoteAddress || 'unknown';
}

// A tiny fixed-window limiter. Serverless instances are ephemeral and there can be
// several of them, so this is a best-effort guard; the real protection against a
// runaway simulation is the message cap enforced in api/chat.js and the client's
// own conversation target.
const buckets = new Map();

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  }
  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    return { ok: false, retryAfter };
  }
  return { ok: true, remaining: limit - bucket.count };
}

// Wraps a handler so every route answers JSON and no stack trace or secret ever
// reaches the browser.
export function route(handler) {
  return async function wrapped(req, res) {
    const started = Date.now();
    try {
      await handler(req, res);
    } catch (error) {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      const code = known ? error.code : 'internal_error';
      const message = known ? error.message : 'The server could not complete that request.';
      if (!known) {
        // The real error stays in the function log; the response only carries the id.
        console.error('[api] unhandled', error && error.stack ? error.stack : error);
      }
      if (!res.headersSent) {
        sendJson(res, status, {
          ok: false,
          error: { code, message, ...(known ? error.extra : {}) },
          ms: Date.now() - started,
        });
      } else {
        res.end();
      }
    }
  };
}

export function asString(value, max = 400) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function asArray(value, max = 24) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max);
}

export function asNumber(value, fallback = 0, min = -Infinity, max = Infinity) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function clamp01(value, fallback = 0) {
  return asNumber(value, fallback, 0, 1);
}
