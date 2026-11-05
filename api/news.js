// /api/news
//
// Headlines and one-line summaries only, from the BBC's own RSS feeds, cached for
// 15 minutes and mirrored to Supabase so a cold serverless instance still has news.
// Headlines are attributed to BBC News with a link, as the BBC's terms require.

import { route, requireMethod, sendJson } from '../server/http.js';
import { getNews, newsStatus } from '../server/news.js';

export default route(async (req, res) => {
  requireMethod(req, 'GET');
  const url = new URL(req.url, 'http://localhost');
  const force = url.searchParams.get('refresh') === '1';

  const result = await getNews({ force });
  sendJson(res, 200, {
    ok: true,
    items: result.items,
    fresh: result.fresh,
    cached: result.cached,
    fetchedAt: result.fetchedAt,
    error: result.error,
    status: newsStatus(),
    attribution: {
      source: 'BBC News',
      url: 'https://www.bbc.co.uk/news',
      note: 'Headlines and summaries from the BBC News RSS feeds. Article text is never stored or sent to the model.',
    },
  });
});
