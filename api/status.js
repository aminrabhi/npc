// /api/status
//
// What the browser is allowed to know about the deployment: whether Groq and
// Supabase are configured, which model is in use, and whether news is cached.
// Values of keys are never returned, only their presence.

import { route, requireMethod, sendJson } from '../server/http.js';
import { config, DEFAULT_MODEL, groqConfigured, supabaseConfigured, missingConfig } from '../server/env.js';
import { newsStatus } from '../server/news.js';

export default route(async (req, res) => {
  requireMethod(req, 'GET');
  const cfg = config();
  sendJson(res, 200, {
    ok: true,
    groq: {
      configured: groqConfigured(),
      model: cfg.groqModel,
      defaultModel: DEFAULT_MODEL,
      modelOverridden: cfg.groqModel !== DEFAULT_MODEL,
    },
    supabase: { configured: supabaseConfigured() },
    news: { configured: true, ...newsStatus() },
    missing: missingConfig(),
    version: 2,
  });
});
