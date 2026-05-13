# Workflow

## Plan first for non-trivial work

For anything beyond a one-file edit — schema changes, parser changes, new scripts, anything that touches >1 of `worker + scripts + tests` — plan in the conversation before writing. Use the TaskCreate tooling to track steps; mark each completed as you finish.

If something goes sideways, stop and re-plan rather than pushing through.

## Verify before claiming done

Three gates, in order:

1. `npm run check` — type-check
2. `npm test` — unit tests (24 against fixtures; ~150ms)
3. `RUN_E2E=1 npm run test:e2e` — E2E against real Notion + live Letterboxd (~18s) when the change touches anything Notion-API or Letterboxd-parser shaped

The E2E test exists *because* unit tests against fixtures can't catch Notion API or Letterboxd HTML drift. Don't skip it on changes that could be affected.

## Capture lessons from corrections

If the user catches a mistake or asks for the same thing twice, write a one-line lesson to `tasks/lessons.md` (create if missing). Look there at the start of future sessions.

Examples of lesson-worthy moments:
- "Don't assume Notion's `me.type` distinguishes PATs from integrations — check `bot.owner.type` instead"
- "Database trash uses `/v1/databases/{id}` PATCH, not the pages endpoint"
- "Notion normalizes formula expressions to internal block_property refs — assert on rendered output, not the stored expression"

## Demand elegance (when it matters)

For non-trivial changes, pause and ask "is there a simpler shape?" before submitting. For one-line fixes, don't.

If a fix feels hacky — duplicated logic, a workaround that papers over the real bug, a comment that starts with "TODO: clean this up later" — implement the elegant solution before you finish.

## Don't ask permission for routine work

When you see a failing test, a typecheck error, or a Notion API mismatch — fix it. Don't ask the user to hand-hold you through it. The point of the workflow is autonomous iteration toward a working result.
