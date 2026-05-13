# Letterboxd → Notion

[![CI](https://github.com/brianlovin/letterboxd-notion-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/brianlovin/letterboxd-notion-sync/actions/workflows/ci.yml)

Sync your Letterboxd diary and watchlist into a Notion database, hourly, with poster covers and rich metadata (director, cast, runtime, genres, IMDb/TMDB links).

Runs as a Notion Worker — no server, no cron, no laptop staying on.

---

## What you get

A Notion database with one page per film, three views (Watched / Watchlist / All Films), and:

- **Status** — `Watched` or `Watchlist`, transitioned automatically when you log a film you'd added to your watchlist
- **Rating** — your Letterboxd rating, rendered as stars (★★★★½)
- **Watched Date**, **Logged Date**, **Rewatch**, **Review**, **Tags** — straight from your diary
- **Director**, **Cast** (top 5), **Genres**, **Country**, **Studio** (top 3) — multi-select, so you can filter
- **Runtime minutes** (number) and **Runtime** (formula, renders as `2h 30m`)
- **Letterboxd Rating** (the community average), **Rating Count**
- **Tagline**, **Plot**
- **IMDb** and **TMDB** links
- **Cover image** — the page cover is the film's landscape poster

Plus a separate audit-log database (one row per sync run) so you can see exactly when each run happened, what got added, and any errors.

## Why two databases?

Notion Workers' sync API requires that the worker own a managed database. We can't directly own *your* Films database — you do — so we declare a tiny `🎬 Letterboxd sync runs` database as the audit log, and the worker writes the actual film data to your Films database via the Notion API. This is the recommended pattern in the [Workers docs](https://developers.notion.com/workers/guides/api-client).

You won't usually need to look at the sync-runs database, but it's useful when something goes wrong.

---

## Prerequisites

- macOS or Linux
- Node 22+ and npm 10+ (`brew install node`)
- A Notion account
- A Letterboxd account
- (Optional) A Letterboxd CSV export, if you want to seed your Films DB with your full history on day one

## Quick start

```bash
# 1. Install the ntn CLI (one-time)
curl -fsSL https://ntn.dev | bash

# 2. Log in
ntn login

# 3. Get the code
git clone https://github.com/brianlovin/letterboxd-notion-sync.git
cd letterboxd-notion-sync
npm install

# 4. Run the interactive setup
#    Creates your Films database + three views + writes .env
npm run setup

# 5. Push secrets to the worker and deploy
ntn workers env push
ntn workers deploy

# 6. (Optional) Import your full Letterboxd history before the first sync
npm run import-csv -- /path/to/letterboxd-export

# 7. (Optional) Enrich existing pages with metadata (covers / director / cast / etc.)
npm run backfill

# 8. Trigger the first real sync
ntn workers sync trigger letterboxdSync
```

The worker is now scheduled hourly. New diary entries appear in your Films database within a sync cycle, with the poster as the page cover.

---

## Step-by-step setup

### 1. Get a Notion API token

The simplest option is a **Personal Access Token (PAT)** — it acts as you, so the worker can read and write any page you can, no per-page sharing required.

1. Go to <https://www.notion.so/developers/tokens>
2. Click **New personal access token**
3. Name it (e.g. `letterboxd-notion-sync`), pick your workspace, give it **Read content**, **Update content**, **Insert content**
4. Copy the token (starts with `ntn_`)

PATs expire after one year. When yours expires, generate a new one and run `ntn workers env set NOTION_API_TOKEN=ntn_...`.

> **Alternative:** an [internal integration token](https://www.notion.so/profile/integrations/internal) works too, but you'll need to share the Films database and any parent page with that integration via each page's `⋯` → `Connections` menu. PATs skip this step.

### 2. Pick a parent page in your workspace

The setup script will create a new database inside an existing page. Open any page in your workspace and copy its URL.

(If you're using an internal integration instead of a PAT, also add the integration to that page via `⋯` → `Connections` → `Add connections` before continuing.)

### 3. Run `npm run setup`

The script will prompt you for:
- Notion integration token
- Letterboxd username
- Parent page URL

It then:
- Creates a `🎬 Films` database with all 23 properties pre-configured
- Creates three views (Watched gallery, Watchlist gallery, All Films table)
- Writes `.env` with everything the worker and helper scripts need

### 4. Deploy the worker

```bash
ntn workers env push   # uploads .env to the worker's secret store
ntn workers deploy
```

On deploy, the worker also creates its own `🎬 Letterboxd sync runs` audit database in your workspace.

### 5. (Optional but recommended) Seed history from your CSV export

Letterboxd doesn't expose your full history via RSS — only the most recent ~50 diary entries. If you want everything from day one:

1. At <https://letterboxd.com/settings/data/>, download your CSV export
2. Unzip it somewhere local
3. Run `npm run import-csv -- /path/to/letterboxd-export`

This creates one Notion page per row from `diary.csv` and `watchlist.csv`, with rating, watch date, rewatch flag, and tags filled in. It does *not* set posters or metadata — that's the next step.

### 6. (Optional) Enrich with covers + director + cast + etc.

```bash
npm run backfill
```

For each page that doesn't already have a `Director` set, the script fetches the film page on Letterboxd, parses the JSON-LD block plus a few footer/meta tags, and writes 13 metadata properties back to Notion.

At 5 requests/second to Letterboxd, ~1000 films takes ~3.5 minutes.

---

## Configuration

All configuration lives in `.env` (local) or as worker secrets (deployed via `ntn workers env push`).

| Variable | Purpose |
|----------|---------|
| `NOTION_API_TOKEN` | Internal integration token (starts with `ntn_`) |
| `LETTERBOXD_USER` | Your Letterboxd username (the part after `letterboxd.com/`) |
| `FILMS_DATABASE_ID` | UUID of your Films database. It's in the database URL — the helper scripts resolve the underlying data source ID automatically. |

To change one of these later:

```bash
ntn workers env set LETTERBOXD_USER=newusername
```

To change the sync cadence, edit `src/index.ts` (`schedule: "1h"` — valid values are `5m`, `15m`, `30m`, `1h`, `1d`, up to `7d`) and redeploy.

---

## How it works

### Diary

Pulled from `https://letterboxd.com/USER/rss/` (RSS, server-friendly).

For each entry, the worker dedupes against the Films DB by `(title, year)`. New entries are created with `Status="Watched"`, watched date, rating, rewatch flag, and the poster from the RSS as the cover.

If a film is already in the DB with `Status="Watchlist"`, it's *transitioned* to Watched: existing properties are kept, watched date / rating / cover are updated.

### Watchlist

Letterboxd doesn't publish the watchlist as RSS (the `/watchlist/rss/` URL is Cloudflare-blocked). The worker scrapes `letterboxd.com/USER/watchlist/` HTML instead — each page lists ~28 films in `data-item-*` attributes, and pagination is via the "Older" link until exhausted.

For each new watchlist film, the worker fetches the film page once to read its `og:image` (the real CDN poster URL — the `/image-150/` redirect URL in the watchlist markup is itself CF-blocked and won't render as a cover).

### Audit log

One row per run in the `🎬 Letterboxd sync runs` database with: started date, added, updated, errors, and a notes field summarizing what was scanned and any per-film errors.

---

## Maintenance

```bash
# Live status across all your workers' syncs
ntn workers sync status

# What happened in the most recent run
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}

# Force a sync right now
ntn workers sync trigger letterboxdSync

# Preview what a sync would do, without writing
ntn workers sync trigger letterboxdSync --preview

# Disable / re-enable the schedule
ntn workers capabilities disable letterboxdSync
ntn workers capabilities enable letterboxdSync
```

---

## Troubleshooting

### "API token is invalid" / "object not found"

- **Using a PAT?** Make sure it hasn't expired (PATs last 1 year). Generate a fresh one at <https://www.notion.so/developers/tokens> and run `ntn workers env set NOTION_API_TOKEN=ntn_...`, then `ntn workers deploy`.
- **Using an internal integration?** Make sure it's *connected* to your Films database — open the database page, click `⋯` → `Connections` → add your integration.

### Cover images aren't loading on new entries

Notion's image proxy needs the cover URL to be a directly-fetchable image, not a redirect. The worker resolves film posters via the film page's `og:image` tag. If a cover still doesn't load:

```bash
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

…and look at the notes for the affected film. If the film page returned 4xx, the slug Letterboxd assigned doesn't match what we extracted — open an issue with the title.

### `WATCHLIST_FAILED: GET https://letterboxd.com/USER/watchlist/ → 403`

Cloudflare started challenging the worker's IPs on the watchlist HTML endpoint too. Options:
1. Wait it out — usually transient
2. Switch the watchlist fetch to use [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) (requires a free CF account + API token)

### "Invalid multi_select option, commas not allowed"

The backfill script sanitizes commas in option names automatically (e.g., "Tyler, The Creator" → "Tyler The Creator"). If you see this from the *worker* (not the backfill), it means a new diary entry came in with a comma-bearing director or studio — open an issue with the film and we'll add it to the worker's sanitizer too.

### "Watchlist removals don't sync"

By design. The watchlist HTML scraper only sees what's currently on the watchlist, but the worker doesn't currently reconcile removals — if you remove a film from your Letterboxd watchlist, it stays in Notion until you delete it there. (PR welcome.)

### Rate limiting

The worker uses a 5 req/sec pacer for Letterboxd. If you see persistent 429s, drop `allowedRequests: 5` to `2` in `src/index.ts` and redeploy.

---

## Privacy

Everything runs in your own Notion workspace, against your own Letterboxd account. No third-party services involved beyond Notion and Letterboxd. The integration token is stored as a Notion worker secret (encrypted at rest) and never leaves Notion's infrastructure once you've run `ntn workers env push`.

## License

MIT — see [LICENSE](./LICENSE).
