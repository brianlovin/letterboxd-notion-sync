<img width="3584" height="2352" alt="Letterboxd to Notion sync" src="https://github.com/user-attachments/assets/e1e04e90-3b12-4028-9ad6-f20c5edbb5d5" />

# Letterboxd → Notion

Sync your Letterboxd diary and watchlist into a Notion database. Pages are enriched with poster covers and metadata (director, cast, runtime, genres, IMDb/TMDB links). Runs on [Notion Workers](https://www.notion.so/developers/workers), no server or cron required.

## Setup

```bash
curl -fsSL https://ntn.dev | bash
```

```bash
ntn login
```

```bash
git clone https://github.com/brianlovin/letterboxd-notion-sync.git
```

```bash
cd letterboxd-notion-sync && npm install && npm run setup
```

Setup asks for a Notion [Personal Access Token](https://www.notion.so/developers/tokens) and your Letterboxd username, creates a `🎬 Films` database with three views (Watched / Watchlist / All Films), deploys the worker, and triggers the first sync.

### Bring in your history (optional)

The hourly sync only sees ~50 recent diary entries. To import everything you've ever logged:

```bash
# Export at https://letterboxd.com/settings/data/, unzip, then:
npm run import-csv -- ~/Downloads/NAME_OF_ZIP_EXPORT
```

```bash
npm run backfill   # adds posters + metadata
```

## Maintenance

```bash
ntn workers sync trigger letterboxdSync   # force a sync now
ntn workers sync status                   # health check
ntn workers runs list                     # recent runs
```

Edit `schedule: "1h"` in `src/index.ts` (valid `5m` … `7d`) and run `ntn workers deploy` to change the cadence.

## License

MIT — see [LICENSE](./LICENSE).
