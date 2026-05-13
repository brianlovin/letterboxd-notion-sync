<img width="3584" height="2352" alt="Letterboxd to Notion sync" src="https://github.com/user-attachments/assets/e1e04e90-3b12-4028-9ad6-f20c5edbb5d5" />

# Letterboxd → Notion

[![CI](https://github.com/brianlovin/letterboxd-notion-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/brianlovin/letterboxd-notion-sync/actions/workflows/ci.yml)

Sync your Letterboxd diary and watchlist into a Notion database — hourly, with poster covers and rich metadata (director, cast, runtime, genres, IMDb/TMDB links). Runs in Notion's cloud, no server or cron required.

## Setup

Needs [Node 22+](https://nodejs.org).

```bash
curl -fsSL https://ntn.dev | bash                              # Notion CLI (one-time)
git clone https://github.com/brianlovin/letterboxd-notion-sync.git
cd letterboxd-notion-sync && npm install && npm run setup
```

Setup asks for a Notion [Personal Access Token](https://www.notion.so/developers/tokens) and your Letterboxd username, creates a `🎬 Films` database with three views (Watched / Watchlist / All Films), deploys the worker, and triggers the first sync. Open the database to watch films arrive.

### Bring in your history (optional)

The hourly sync only sees ~50 recent diary entries. To import everything you've ever logged:

```bash
# Export at https://letterboxd.com/settings/data/, unzip, then:
npm run import-csv -- ~/Downloads/letterboxd-yourname
npm run backfill   # adds posters + metadata
```

## What you get

One Notion page per film, with: status (Watched/Watchlist, transitioned automatically), your rating (★★★★½) and watched date, director, cast (top 5), genres, country, studio, runtime (rendered as `2h 30m`), tagline, plot, Letterboxd community rating, IMDb/TMDB links, and the film's poster as the page cover. A separate `🎬 Letterboxd sync runs` database logs every sync for debugging.

## Maintenance

```bash
ntn workers sync trigger letterboxdSync   # force a sync now
ntn workers sync status                   # health check
ntn workers runs list                     # recent runs
```

Edit `schedule: "1h"` in `src/index.ts` (valid `5m` … `7d`) and run `ntn workers deploy` to change the cadence.

## License

MIT — see [LICENSE](./LICENSE).
