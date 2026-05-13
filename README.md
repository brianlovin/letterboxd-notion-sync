<img width="3584" height="2352" alt="Letterboxd to Notion sync" src="https://github.com/user-attachments/assets/e1e04e90-3b12-4028-9ad6-f20c5edbb5d5" />

# Letterboxd → Notion

[![CI](https://github.com/brianlovin/letterboxd-notion-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/brianlovin/letterboxd-notion-sync/actions/workflows/ci.yml)

Sync your Letterboxd diary and watchlist into a Notion database — hourly, with poster covers and rich metadata (director, cast, runtime, genres, IMDb/TMDB links). No server, no cron, no laptop staying on; the worker runs in Notion's cloud.

## Setup

You'll need [Node 22+](https://nodejs.org) and a Notion account.

```bash
# 1. Install the Notion CLI (one-time)
curl -fsSL https://ntn.dev | bash

# 2. Clone, install, run setup
git clone https://github.com/brianlovin/letterboxd-notion-sync.git
cd letterboxd-notion-sync
npm install
npm run setup
```

The setup script will:

1. Ask you to paste a **Personal Access Token** from <https://www.notion.so/developers/tokens> (click _New personal access token_, tick both **Notion API** and **Workers**, click Create, copy the token)
2. Ask for your Letterboxd username
3. Create a `🎬 Films` database at the root of your Notion workspace (with three views: Watched, Watchlist, All Films)
4. Deploy the sync worker — runs hourly from then on

That's it. New diary entries and watchlist additions appear in Notion within an hour.

### Optional: bring in your history on day one

The hourly sync only sees recent diary entries (Letterboxd's RSS caps at about 50). If you want everything:

```bash
# Download your CSV export at https://letterboxd.com/settings/data/, unzip it,
# then point the importer at the unzipped folder:
npm run import-csv -- ~/Downloads/letterboxd-yourname
npm run backfill                                       # adds posters + metadata
```

## What you get

| Property | Source |
|----------|--------|
| Title, Year, Letterboxd URI | Letterboxd diary / watchlist |
| Status (Watched / Watchlist) | Automatic; transitions Watchlist → Watched when you log a film |
| Rating (★★★★½), Watched Date, Rewatch, Review, Tags | Your diary entry |
| Director, Cast (top 5), Genres, Country, Studio (top 3) | Multi-select for filtering |
| Runtime (rendered as `2h 30m`) | Formula property over `Runtime minutes` |
| Letterboxd Rating, Rating Count | Community average from the film page |
| Tagline, Plot | Film page |
| IMDb, TMDB | Direct links |
| Cover image | Film's landscape poster |

Plus a separate `🎬 Letterboxd sync runs` database that logs every sync (added, updated, errors, notes) — useful for debugging, easy to hide otherwise.

## Maintenance

```bash
ntn workers sync status                              # health check
ntn workers sync trigger letterboxdSync              # force a sync now
ntn workers sync trigger letterboxdSync --preview    # dry-run a sync
ntn workers runs list                                # recent runs
```

To change the sync cadence, edit `schedule: "1h"` in `src/index.ts` (valid: `5m` … `7d`) and run `ntn workers deploy`.

## License

MIT — see [LICENSE](./LICENSE).
