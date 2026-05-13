# letterboxd-notion-sync

Notion Worker that syncs a Letterboxd diary + watchlist into a Notion database, plus CLI scripts for setup, CSV import, and metadata enrichment. See [README.md](./README.md) for user-facing docs.

## Rules

- [Conventions](./.claude/rules/conventions.md) — TypeScript, imports, Notion API versions, error handling
- [Invariants](./.claude/rules/invariants.md) — DB ownership, dedup key, cover URLs, multi-select, rate limit
- [Common tasks](./.claude/rules/tasks.md) — add a property, change schedule, debug a sync
- [Workflow](./.claude/rules/workflow.md) — plan first, verify, capture lessons

## Verification

- `npm run check` — type-check (no emit)
- `npm test` — unit tests, against fixtures only (~150ms, no network)
- `RUN_E2E=1 npm run test:e2e` — E2E against real Notion + live Letterboxd (~18s); requires `NOTION_API_TOKEN` (PAT preferred) and `E2E_PARENT_PAGE_ID` in `.env`. Run after any change to `src/letterboxd.ts`, `src/films-schema.ts`, the worker, or any script that hits Notion.

CI (`.github/workflows/ci.yml`) runs `check` + `test` on every push/PR. E2E is opt-in and not in CI by default.

## Don't

- **Hardcode user-specific values** (Letterboxd username, database IDs) anywhere in `src/` or `scripts/` — they live in env vars.
- **Commit `.env`.** It's git-ignored; use `.env.example` for documentation.
- **Bypass the 5 req/s Letterboxd pacer** — Cloudflare will challenge the worker IP if you sustain higher rates.
- **`as any` to silence Notion SDK types** — the types compile when called correctly; a TS error means the call shape is wrong.
