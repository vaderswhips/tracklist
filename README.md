# TrackList — deploy on Vercel

Self-populating UAE car-events app. A daily cron asks Claude (with the web search tool)
to find current events, caches them in Vercel KV, and the app reads that cache.
**No business ever has to add an event manually.**

## Files
```
api/refresh.js   ← cron: Claude + web search → KV   (the engine)
api/events.js    ← what the app fetches on load (cached, fast)
public/index.html← the app (List + Calendar views)
public/manifest.webmanifest
vercel.json      ← cron schedule (daily 02:00 UTC = 6am Dubai)
package.json     ← @vercel/kv
```

## Deploy (≈5 min, no new signups — all inside Vercel)

1. **Push to Vercel.** Same as PartHunter: new project → import this folder (or drag-drop / `vercel` CLI).

2. **Add Vercel KV** (this is Vercel's own storage, not a new account):
   - In the project → **Storage** tab → **Create** → **KV** → connect to the project.
   - It auto-injects the `KV_*` env vars. Nothing to copy.

3. **Set environment variables** (Project → Settings → Environment Variables):
   - `ANTHROPIC_API_KEY` — same key you use for BuildAI on PartHunter.
   - `CRON_SECRET` — any random string (e.g. from `openssl rand -hex 16`). Protects the refresh endpoint.

4. **Redeploy.** On first visit, `events.js` sees an empty cache and triggers one crawl, so the app fills itself. After that the daily cron at 6am Dubai keeps it fresh.

5. **Add to home screen** (the "widget"): open the deployed URL on your phone → Share → *Add to Home Screen*. Opens fullscreen like an app. (Add `icon-192.png` / `icon-512.png` to `/public` for the icon — any square red/black logo.)

## Manual refresh / test
Hit `https://YOURAPP.vercel.app/api/refresh` with header `Authorization: Bearer <CRON_SECRET>`
to force a crawl. View raw data at `/api/events`.

## Honesty built in
Each event carries a **source link** and a confidence badge (`✓ verified source` from official
venue/ticketing pages, else `check details`). The crawler is told never to invent dates/prices —
unknowns come back blank rather than guessed. Spot-check before relying on a date.

## Cost
One Claude call/day with ~8 searches. Pennies/day. Bump cron frequency in `vercel.json` if you
want intra-day freshness (e.g. `0 */6 * * *` = every 6h).

## Real OS home-screen widget (the live tile)
PWA "add to home screen" gives an app icon, not a live tile showing your next event. A true
widget needs a native wrapper (Capacitor + WidgetKit/Glance). Worth doing only once there's usage.
