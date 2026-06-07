// api/refresh.js
// Runs on a schedule (Vercel Cron). Asks Claude — WITH the web search tool —
// to find current UAE car events, then stores the result in Vercel KV.
// The app reads the stored list; it never calls Claude on page load.

import { kv } from '@vercel/kv';

const SYSTEM = `You are the event-sourcing engine for TrackList, a UAE car-scene events app.
Use the web_search tool to find REAL, upcoming car-related events in the United Arab Emirates
over roughly the next 35 days. Categories: Track Day, Drift, Drag, Meet, Cars & Coffee, Show.
Search official + reliable sources: Dubai Autodrome, Yas Marina Circuit, Platinumlist, Dubai
Calendar, venue and organizer Instagram/sites, and reputable listings.

RULES:
- Only include events you actually found a source for. Never invent dates, prices, or venues.
- If you are unsure of a detail, leave it null rather than guessing.
- Every event MUST include the source URL you found it on.
- Dates must be ISO YYYY-MM-DD. Skip anything in the past or with no findable date.

Respond with ONLY a JSON array (no prose, no markdown fences), each item:
{"title","type","emirate","venue","date","time","price","desc","source","confidence"}
"type" is one of the categories above. "emirate" one of: Dubai, Abu Dhabi, Sharjah, RAK, Ajman, Fujairah, UMQ, Al Ain.
"confidence" is "high" if from an official venue/ticketing source, else "medium".`;

export default async function handler(req, res) {
  // Protect the endpoint: Vercel Cron sends a bearer token you set as CRON_SECRET.
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const events = await crawl();
    const payload = {
      events,
      updatedAt: new Date().toISOString(),
      count: events.length,
    };
    await kv.set('tracklist:events', payload);
    return res.status(200).json({ ok: true, count: events.length, updatedAt: payload.updatedAt });
  } catch (err) {
    console.error('refresh failed', err);
    return res.status(500).json({ error: String(err) });
  }
}

async function crawl() {
  // Multi-turn loop so Claude can run several searches before answering.
  const messages = [{
    role: 'user',
    content: 'Find the UAE car events for the next ~35 days now. Search thoroughly, then return the JSON array.',
  }];

  let finalText = '';
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
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    messages.push({ role: 'assistant', content: data.content });

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

  return parseEvents(finalText);
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
