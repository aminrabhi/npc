// Local development server: the static village plus the same api/* handlers Vercel
// runs in production.
//
//   npm run dev            (node tools/api_server.js 3000)
//
// This exists so the API routes can be exercised for real before deploying - the
// static file server used during part 1 could not run them. It reads .env itself,
// because the project has no dependencies on purpose.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function loadEnv() {
  const file = path.join(root, '.env');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const handlers = new Map();

async function loadHandler(name) {
  const clean = name.replace(/[^a-z0-9_-]/gi, '');
  if (!clean) return null;
  const file = path.join(root, 'api', `${clean}.js`);
  try {
    await stat(file);
  } catch {
    return null;
  }
  if (!handlers.has(clean)) {
    handlers.set(clean, import(pathToFileURL(file).href));
  }
  const mod = await handlers.get(clean);
  return mod && mod.default ? mod.default : null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad path');
    return;
  }
  const relative = decoded === '/' ? '/index.html' : decoded;
  const file = path.join(root, relative);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice('/api/'.length).replace(/\/$/, '');
    const handler = await loadHandler(name);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'no_route', message: `No API route called ${name}.` } }));
      return;
    }
    try {
      req.body = await readBody(req);
      await handler(req, res);
    } catch (error) {
      console.error('[dev-api]', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'dev_error', message: String(error && error.message ? error.message : error) } }));
      } else {
        res.end();
      }
    }
    return;
  }

  await serveStatic(req, res, pathname);
});

const port = Number(process.argv[2] || process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

await loadEnv();

server.listen(port, host, () => {
  console.log(`Simulora on http://${host}:${port}`);
  console.log(`  Groq: ${process.env.GROQ_API_KEY ? `configured (${process.env.GROQ_MODEL || 'allam-2-7b'})` : 'not configured - conversations run offline'}`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'not configured - memories stay local'}`);
});
