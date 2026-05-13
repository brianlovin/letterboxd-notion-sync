# Invariants

Things that *will* break if you change them.

## Films DB is user-owned, audit DB is worker-owned

`worker.database("syncRuns", { type: "managed", ... })` in `src/index.ts` declares the audit DB — Notion Workers' sync API requires a managed DB to exist. The actual Films DB is created by `scripts/setup.ts` (or pre-existing) and lives in the user's workspace. The worker writes to it via `context.notion`, not as a managed sync target.

Don't try to make the Films DB a managed sync DB. The whole point of this two-DB shape is that the user owns their film data.

## Dedup key is `(title, year)`

Both the worker and the CSV importer use this. The Letterboxd URI is *not* stable:

- Older diary entries: `boxd.it/...` shortlinks
- RSS feed: full `letterboxd.com/USER/film/SLUG/` URLs
- Watchlist HTML scrape: yet another shape (`/film/SLUG/`)

If you change the dedup key, make sure to update both `readExistingFilms` in `src/index.ts` and `readExistingKeys` in `scripts/import-csv.ts`.

## Covers must be direct CDN URLs

Notion's image proxy can't follow Letterboxd's `/image-150/` redirect — it returns 403 outside a real browser.

- **Diary entries**: portrait poster URL is in the RSS `<description>` (`<img src="...">`). Use that.
- **Watchlist entries**: the watchlist HTML only exposes the CF-blocked redirect URL. Fetch the film page and read `<meta property="og:image" content="...">` instead.

## Multi-select options grow organically

When the worker (or `backfill.ts`) PATCHes a page with a multi-select value that doesn't exist yet, Notion auto-creates the option. **Don't register option lists upfront** — they grow from real data.

One gotcha: Notion rejects commas in option names. `backfill.ts` has `sanitizeOptionName` that strips them. If you add a new code path that writes multi-select values, route them through that.

## 5 req/s pacer for Letterboxd

The worker's `worker.pacer("letterboxd", { allowedRequests: 5, intervalMs: 1000 })` and the standalone `Pacer` in `scripts/backfill.ts` are the budget. Sustained higher rates risk a Cloudflare challenge — once that happens, the worker IP can be stuck behind a JS challenge that we can't solve from a fetch.

Don't bypass either pacer. If you need more throughput, raise both in lockstep.
