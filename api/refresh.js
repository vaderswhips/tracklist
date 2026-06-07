// api/refresh.js
// Runs on a schedule (Vercel Cron). Asks Claude — WITH the web search tool —
// to find current UAE car events, then stores the result in Vercel KV.
// The app reads the stored list; it never calls Claude on page load.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SYSTEM = `You are the event-sourcing engine for TrackList, a UAE car-scene events app.
Use the web_search tool to find upcoming car-related events in the United Arab Emirates over the
next ~35 days. Categories: Track Day, Drift, Drag, Meet, Cars & Coffee, Show.
Good sources: Dubai Autodrome, Yas Marina Circuit, Platinumlist, Dubai Calendar, time out Dubai,
venue and organizer pages, and reputable event listings.

IMPORTANT — you DO have working web search. Run several searches, read the results, and base your
output on what you find. Do not claim search is unavailable; if a search returns little, try a
different query (e.g. "Dubai Autodrome track day 2026", "UAE car meet this month", "Yas Marina
trackday tickets", "car show Dubai 2026").

INCLUSION RULES (balanced — do not return an empty list just to be safe):
- Include events you found referenced in search results, including recurring/regular events that
  reliable sources describe (e.g. a weekly Cars & Coffee, a venue's regular track nights).
- Prefer events with a specific date. If a real recurring event has no exact published date but
  clearly recurs (e.g. "every Saturday"), include it with your best date estimate for the next
  occurrence and set confidence "medium".
- Do NOT fabricate a specific named event that no source mentions. But you do not need a perfect
  official listing for every field — partial info with a source link is fine; leave unknown fields null.
- Every event should have a source URL from your search results.
- Dates ISO YYYY-MM-DD, in the future. Aim for 6-15 events if the scene supports it.

After searching, respond with ONLY a JSON array (no prose, no markdown fences), each item:
{"title","type","emirate","venue","date","time","price","desc","source","confidence"}
"type" is one of the categories above. "emirate" one of: Dubai, Abu Dhabi, Sharjah, RAK, Ajman, Fujairah, UMQ, Al Ain.
"confidence" is "high" for official venue/ticketing sources, else "medium".`;

export default async function handler(req, res) {
  // Auth: Vercel Cron sends Bearer <CRON_SECRET>. For manual browser testing,
  // you can also pass ?debug=<CRON_SECRET> in the URL.
  const auth = req.headers['authorization'];
  const debugKey = req.query && req.query.debug;
  const authedByHeader = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const authedByQuery = process.env.CRON_SECRET && debugKey === process.env.CRON_SECRET;
  const noSecretSet = !process.env.CRON_SECRET;

  if (!authedByHeader && !authedByQuery && !noSecretSet) {
    return res.status(401).json({ error: 'unauthorized', hint: 'add ?debug=YOUR_CRON_SECRET to the URL to test in a browser' });
  }

  const debug = authedByQuery || (req.query && req.query.debug === '1');

  // Surface config problems immediately rather than failing deep in the call.
  const cfg = {
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    hasRedisUrl: !!process.env.KV_REST_API_URL,
    hasRedisToken: !!process.env.KV_REST_API_TOKEN,
  };
  if (!cfg.hasAnthropicKey || !cfg.hasRedisUrl || !cfg.hasRedisToken) {
    return res.status(500).json({ error: 'missing environment variables', cfg });
  }

  try {
    const { events, raw, searchCount, rateLimited } = await crawl(debug);
    // Don't overwrite existing good data with an empty rate-limited result.
    if (events.length === 0 && rateLimited) {
      const out = { ok: false, rateLimited: true, count: 0, note: 'hit per-minute rate limit before finding events; raise tier or try again' };
      if (debug) { out.searchCount = searchCount; out.rawFirst800 = (raw || '').slice(0, 800); }
      return res.status(200).json(out);
    }
    const payload = {
      events,
      updatedAt: new Date().toISOString(),
      count: events.length,
    };
    await redis.set('tracklist:events', payload);
    const out = { ok: true, count: events.length, updatedAt: payload.updatedAt, rateLimited };
    if (debug) { out.searchCount = searchCount; out.rawFirst800 = (raw || '').slice(0, 800); }
    return res.status(200).json(out);
  } catch (err) {
    console.error('refresh failed', err);
    return res.status(500).json({ error: String(err && err.message || err), stack: debug ? String(err && err.stack) : undefined });
  }
}

async function crawl(debug) {
  // Multi-turn loop so Claude can run several searches before answering.
  const messages = [{
    role: 'user',
    content: 'Find the UAE car events for the next ~35 days now. Search thoroughly, then return the JSON array.',
  }];

  let finalText = '';
  let searchCount = 0;
  let rateLimited = false;
  let rateLimitWaits = 0;
  for (let turn = 0; turn < 6; turn++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        system: SYSTEM,
        messages,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      }),
    });
    const data = await r.json();
    // Rate limited: wait for the per-minute window to reset, then retry the same turn.
    // Safe now that the function can run up to 300s with Fluid Compute.
    if (data.error && /rate limit/i.test(data.error.message || '')) {
      if (rateLimitWaits >= 2) { rateLimited = true; break; } // give up after 2 waits
      rateLimitWaits++;
      await new Promise((s) => setTimeout(s, 20000)); // wait 20s
      turn--; // redo this turn
      continue;
    }
    // Surface any other real API error (bad model name, auth, etc.).
    if (data.error) {
      const msg = data.error.message || JSON.stringify(data.error);
      throw new Error('Anthropic API: ' + msg);
    }

    messages.push({ role: 'assistant', content: data.content });

    // Count server-side searches Claude ran.
    searchCount += (data.content || []).filter((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result').length;

    // Gather any text Claude has emitted so far.
    finalText = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    // If Claude stopped to use a tool, the API already ran the search server-side
    // (web_search is a server tool), so we just continue the loop to let it read results.
    if (data.stop_reason === 'tool_use') continue;
    break;
  }

  // If we never got a JSON array (e.g. ran out of turns mid-search), ask once more
  // for the final answer based on everything searched so far — no new searches.
  if (!/\[/.test(finalText)) {
    messages.push({
      role: 'user',
      content: 'Based on the search results above, output the final JSON array of events now. ONLY the JSON array, no prose. If you genuinely found nothing, return [].',
    });
    try {
      const r2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: SYSTEM, messages }),
      });
      const d2 = await r2.json();
      if (!d2.error) {
        const t2 = (d2.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (t2) finalText = t2;
      }
    } catch (e) { /* keep what we have */ }
  }

  return { events: parseEvents(finalText), raw: finalText, searchCount, rateLimited };
}

function parseEvents(text) {
  if (!text) return [];
  let clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  clean = clean.slice(start, end + 1);

  let arr;
  try { arr = JSON.parse(clean); } catch { return []; }
  if (!Array.isArray(arr)) return [];

  const today = new Date(); today.setHours(0, 0, 0, 0);

  return arr
    .filter((e) => e && e.title && e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    .filter((e) => new Date(e.date + 'T00:00:00') >= today)
    .map((e, i) => ({
      id: 'e' + i + '_' + e.date.replace(/-/g, ''),
      title: String(e.title).slice(0, 120),
      type: e.type || 'Meet',
      emirate: e.emirate || 'Dubai',
      venue: e.venue || 'TBA',
      date: e.date,
      time: e.time || null,
      price: e.price || null,
      desc: e.desc || '',
      source: e.source || null,
      confidence: e.confidence === 'high' ? 'high' : 'medium',
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 60);
}
