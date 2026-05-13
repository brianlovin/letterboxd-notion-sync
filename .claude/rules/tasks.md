# Common tasks

## Add a property to the Films DB

1. Add it to `SCHEMA` in `src/films-schema.ts`.
2. Add it to `NEW_PROPERTIES` in `scripts/add-properties.ts` so users with pre-existing databases can migrate.
3. Populate it in `buildUpdate()` in `scripts/backfill.ts` if it's metadata-derived (scraped from Letterboxd).
4. Populate it in `buildCreateProps()` in `src/index.ts` if the worker should set it on create.

Run `RUN_E2E=1 npm run test:e2e` after — the schema test verifies every property in `SCHEMA` lands with the right type.

## Change the sync schedule

`src/index.ts` → `schedule: "1h"`. Valid: `5m`, `15m`, `30m`, `1h`, `1d`, ... up to `7d`. Run `ntn workers deploy` after.

## Debug a stuck sync

```bash
ntn workers sync status                                                            # health
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

The Notes field on the most recent row of the "🎬 Letterboxd sync runs" database is a one-line summary of what happened (existing count, diary count, watchlist count, errors).

## Change what watchlist HTML the parser handles

`parseWatchlistHtml` in `src/letterboxd.ts` matches `<div data-component-class="LazyPoster" data-item-name="..." data-item-slug="...">`. If Letterboxd's template changes, the live E2E test (`RUN_E2E=1 npm run test:e2e`) catches it — the fixture in `tests/fixtures/watchlist.html` would not.

## Change what the film-page parser extracts

`parseFilmPage` in `src/letterboxd.ts` pulls from three places:
- JSON-LD block (director, cast, genres, country, studios, rating, ratingCount)
- Footer `<p class="text-link text-footer">` (runtime, IMDb/TMDB IDs)
- `<meta>` + `<h4 class="tagline">` (plot, tagline)

Add new fields to the `FilmMeta` interface there, populate them in `parseFilmPage`, then thread them through `buildUpdate` in `scripts/backfill.ts`.
