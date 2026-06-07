// api/events.js
// The app reads this on load. Returns the cached event list from KV.
// If the cache is empty (e.g. first deploy before cron runs), it triggers
// a one-off crawl so the app is never blank on day one.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  try {
    let payload = await redis.get('tracklist:events');

    if (!payload || !payload.events || payload.events.length === 0) {
      // Cold start: build it once, inline, so the first visitor sees data.
      const base = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      await fetch(`${base}/api/refresh`, {
        headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {},
      }).catch(() => {});
      payload = await redis.get('tracklist:events');
    }

    return res.status(200).json(payload || { events: [], updatedAt: null, count: 0 });
  } catch (err) {
    console.error('events read failed', err);
    return res.status(200).json({ events: [], updatedAt: null, count: 0, error: 'unavailable' });
  }
}
