# AGENTS.md

Guidance for AI agents (Claude Code, Cursor, etc.) working in this repo.

## What this is

A Notion Worker that syncs Letterboxd diary + watchlist into a Notion database, plus a small kit of CLI scripts for setup, CSV import, and metadata enrichment.

See [README.md](./README.md) for the user-facing overview.

## Layout

```
src/
  index.ts            # The worker. Hourly sync; reads LETTERBOXD_USER and
                      # FILMS_DATABASE_ID from worker env (set via
                      # `ntn workers env set` or pushed from .env).

scripts/
  setup.ts            # Interactive first-time setup. Creates the Films
                      # database + 3 views and writes .env.
  import-csv.ts       # Bulk-imports Letterboxd's CSV export. Idempotent on
                      # (title, year).
  backfill.ts         # Enriches existing pages with 13 metadata properties
                      # scraped from Letterboxd film pages. Idempotent on
                      # the Director property; --force to re-enrich.
  add-properties.ts   # Adds the 13 metadata properties to a Films DB that
                      # was created before this script was written. New
                      # installs don't need it (setup.ts creates them).

.env.example          # Template for the four required env vars.
```

## Conventions

- **TypeScript with `strict` on.** Run `npm run check` after any edit; no errors expected.
- **Tabs for indentation**, matching the `ntn` CLI's scaffolded files.
- **Imports**: `@notionhq/workers` for the Worker class / Schema / Builder. `@notionhq/client` for the standalone scripts (the worker SDK doesn't re-export it).
- **Notion-Version**: scripts pin `2025-09-03` because they hit `/v1/data_sources` and `/v1/views`. The worker uses the SDK default (`2022-06-28`) inside `context.notion`, which is why the worker writes `parent: { database_id }` while the scripts write `parent: { data_source_id }`.
- **Error handling**: scripts use `process.exit(1)` on fatal errors with a clear message. Worker code lets errors propagate inside `try/catch` blocks per RSS / watchlist / page step and reports them in the audit-log `Notes` field.

## Key invariants

1. **Films database is user-owned, audit DB is worker-owned.** The worker's `worker.database("syncRuns", { type: "managed", ... })` declaration creates the audit DB. The Films DB is created by `setup.ts` (or pre-existing) and lives in the user's workspace.
2. **Dedup key is `(title, year)`.** Both worker and CSV importer use this. The Letterboxd URI is *not* a stable key — older diary entries use `boxd.it/...` shortlinks, RSS feeds use full URLs, the watchlist HTML uses yet another shape.
3. **Covers must be direct CDN URLs.** Notion's image proxy can't follow Letterboxd's `/image-150/` redirect (it returns 403 outside a real browser). For watchlist entries, the worker fetches the film page and reads the `og:image` meta tag. Diary entries get a portrait poster URL directly from the RSS `<description>`.
4. **Multi-select options grow organically.** When PATCHing a page with a multi-select value that isn't already an option, Notion auto-creates the option. No upfront registration. `backfill.ts` sanitizes option names — Notion rejects commas in option names.

## Common tasks

### Make a change to what gets enriched

Touch `scripts/backfill.ts` and the worker's `buildCreateProps` in `src/index.ts`. Keep their shapes in sync.

### Add a new property

1. Add it to the schema in `scripts/setup.ts` (`SCHEMA` object).
2. Add it to `scripts/add-properties.ts` (`NEW_PROPERTIES`) so users with existing databases can migrate.
3. Populate it in `scripts/backfill.ts` (`buildUpdate`) if it's metadata-derived.
4. Populate it in `src/index.ts` (`buildCreateProps`) if the worker should set it on create.

### Change the sync schedule

`src/index.ts` → `schedule: "1h"`. Valid: `5m`, `15m`, `30m`, `1h`, `1d`, ... up to `7d`. Redeploy after.

### Debugging a stuck sync

```bash
ntn workers sync status                                                  # health
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

The Notes field on the most recent row of the `🎬 Letterboxd sync runs` database is also a quick summary.

## What NOT to do

- **Don't hardcode user-specific values** (Letterboxd username, database IDs) anywhere in `src/` or `scripts/`. They live in env vars.
- **Don't commit `.env`.** It's git-ignored. Use `.env.example` for documentation.
- **Don't add `as any` casts to silence Notion SDK type errors.** The SDK's types are usable; if something doesn't compile, the call signature is probably wrong.
- **Don't bypass the `letterboxd` pacer** in the worker, or the standalone `Pacer` class in `backfill.ts`. 5 req/sec is the budget; sustained higher rates risk getting Cloudflare-challenged.

## Testing

There's no test runner. Validate with:
1. `npm run check` — type-check
2. `npm run setup` against a throwaway parent page
3. `npm run backfill -- --limit 5 --dry-run` after import
4. `ntn workers sync trigger letterboxdSync --preview` after deploy

## Useful docs

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Using the Notion API from a worker](https://developers.notion.com/workers/guides/api-client)
- [Views API](https://developers.notion.com/guides/data-apis/working-with-views)
- [`ntn` CLI reference](https://developers.notion.com/cli/get-started/overview)
