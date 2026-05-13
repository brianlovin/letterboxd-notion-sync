# Conventions

## TypeScript

- `strict` is on. Run `npm run check` after any edit; expect zero errors.
- **Tabs** for indentation (matches the `ntn` CLI's scaffolded files).
- Never `as any` to silence a Notion SDK type error — the SDK's types compile when called correctly. If something doesn't typecheck, you're sending the wrong shape.

## Imports

| For | Import from | Why |
|---|---|---|
| Worker (`src/index.ts`) | `@notionhq/workers` (+ `/builder`, `/schema`) | Worker class, schema helpers |
| Standalone scripts | `@notionhq/client` | The workers SDK doesn't re-export `Client` |
| Shared parsers | `../src/letterboxd` | RSS/HTML/JSON-LD parsers used by worker AND scripts |
| Shared schema | `../src/films-schema` | The Films DB property definitions + view payloads |

## Notion API versions

Two pin points, two reasons:

- **Worker** (`src/index.ts`) uses the SDK's default `2022-06-28` via `context.notion`. Writes `parent: { database_id }`.
- **Scripts** (`scripts/*.ts`) pin `2026-03-11` via `scripts/lib.ts` because they hit `/v1/data_sources` and `/v1/views`. Write `parent: { data_source_id }`.

The differing `parent` shape between the worker and scripts is intentional — keep both. Don't try to unify the version.

## Error handling

- **Scripts**: `process.exit(1)` on fatal errors, with a one-line message that points at the fix (e.g., "Set NOTION_API_TOKEN").
- **Worker**: errors propagate inside per-step `try/catch` (RSS / watchlist / each-page). They land in the audit-log `Notes` field rather than failing the whole sync.

## Useful Notion docs

- [Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Workers sync guide](https://developers.notion.com/workers/guides/syncs)
- [Calling the Notion API from a worker](https://developers.notion.com/workers/guides/api-client)
- [Views API](https://developers.notion.com/guides/data-apis/working-with-views)
- [`ntn` CLI reference](https://developers.notion.com/cli/get-started/overview)
