/**
 * Interactive first-time setup.
 *
 *   npm run setup
 *
 * What this does
 * ──────────────
 *   1. Prompts for a Notion API token and your Letterboxd username.
 *   2. Creates a "🎬 Films" database at the root of your workspace with the
 *      full property schema.
 *   3. Creates three views (Watched, Watchlist, All Films) — gallery
 *      layouts for the first two, table for the third.
 *   4. Deletes the empty default view that Notion creates with every new
 *      database, so users only see our three.
 *   5. Writes everything to `.env`.
 *
 * Idempotency
 * ───────────
 *   Refuses to run if `.env` already has FILMS_DATABASE_ID set, unless
 *   `--force` is passed. (Re-running creates a *new* Films DB next to your
 *   old one, which is rarely what you want.)
 */

import { Client } from "@notionhq/client";
import * as fs from "node:fs";
import * as readline from "node:readline/promises";

import { NOTION_VERSION } from "./lib";

// ---------- CLI ------------------------------------------------------------

const FORCE = process.argv.includes("--force");

// ---------- Tiny helpers ---------------------------------------------------

async function prompt(rl: readline.Interface, question: string, fallback?: string): Promise<string> {
	const suffix = fallback ? ` [${fallback}]` : "";
	const answer = (await rl.question(`${question}${suffix}: `)).trim();
	return answer || fallback || "";
}

function bail(msg: string): never {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

function info(msg: string)    { console.log(`  ${msg}`); }
function step(msg: string)    { console.log(`\n▸ ${msg}`); }
function success(msg: string) { console.log(`✓ ${msg}`); }

// ---------- Schema ---------------------------------------------------------

// Star rating options, in display order (top to bottom of the picker).
const RATING_OPTIONS = [
	{ name: "★★★★★", color: "yellow" as const },
	{ name: "★★★★½", color: "yellow" as const },
	{ name: "★★★★",  color: "yellow" as const },
	{ name: "★★★½",  color: "yellow" as const },
	{ name: "★★★",   color: "yellow" as const },
	{ name: "★★½",   color: "yellow" as const },
	{ name: "★★",    color: "yellow" as const },
	{ name: "★½",    color: "yellow" as const },
	{ name: "★",     color: "yellow" as const },
	{ name: "½",     color: "yellow" as const },
];

const STATUS_OPTIONS = [
	{ name: "Watched",   color: "green" as const },
	{ name: "Watchlist", color: "blue"  as const },
];

// Formula expression that renders "Runtime minutes" as e.g. "2h 30m".
// Edge cases: empty input → "", < 60min → "Xm", exact hour → "Xh".
const RUNTIME_FORMULA_EXPRESSION =
	'if(empty(prop("Runtime minutes")), "", ' +
		'if(prop("Runtime minutes") < 60, format(prop("Runtime minutes")) + "m", ' +
			'if(prop("Runtime minutes") % 60 == 0, format(floor(prop("Runtime minutes") / 60)) + "h", ' +
				'format(floor(prop("Runtime minutes") / 60)) + "h " + format(prop("Runtime minutes") % 60) + "m")))';

const SCHEMA = {
	// Required by Notion: every database has exactly one title property.
	Title:                 { title: {} },
	Year:                  { number: { format: "number" } },
	Status:                { select: { options: STATUS_OPTIONS } },
	Rating:                { select: { options: RATING_OPTIONS } },
	"Watched Date":        { date: {} },
	"Logged Date":         { date: {} },
	Rewatch:               { checkbox: {} },
	Review:                { rich_text: {} },
	Tags:                  { rich_text: {} },
	"Letterboxd URI":      { url: {} },

	// Metadata enriched from Letterboxd (populated by the worker on create
	// and by `scripts/backfill.ts` for existing pages).
	Director:              { multi_select: { options: [] } },
	Cast:                  { multi_select: { options: [] } },
	Genres:                { multi_select: { options: [] } },
	Country:               { multi_select: { options: [] } },
	Studio:                { multi_select: { options: [] } },
	"Runtime minutes":     { number: { format: "number" } },
	// Rendered runtime (e.g. "2h 30m"). Formula-derived from "Runtime minutes".
	Runtime:               { formula: { expression: RUNTIME_FORMULA_EXPRESSION } },
	"Letterboxd Rating":   { number: { format: "number" } },
	"Rating Count":        { number: { format: "number_with_commas" } },
	Tagline:               { rich_text: {} },
	Plot:                  { rich_text: {} },
	IMDb:                  { url: {} },
	TMDB:                  { url: {} },
	"Letterboxd Film ID":  { rich_text: {} },
};

// ---------- Views ----------------------------------------------------------

function viewPayloads(databaseId: string, dataSourceId: string) {
	return [
		// Watched: gallery sorted by Watched Date desc, filtered to Watched.
		{
			database_id:    databaseId,
			data_source_id: dataSourceId,
			name:           "Watched",
			type:           "gallery",
			configuration: {
				type:         "gallery",
				cover:        { type: "page_cover" },
				cover_size:   "medium",
				cover_aspect: "cover",
				card_layout:  "compact",
			},
			filter: {
				property: "Status",
				select:   { equals: "Watched" },
			},
			sorts: [{ property: "Watched Date", direction: "descending" }],
		},
		// Watchlist: gallery sorted by Logged Date desc (when added).
		{
			database_id:    databaseId,
			data_source_id: dataSourceId,
			name:           "Watchlist",
			type:           "gallery",
			configuration: {
				type:         "gallery",
				cover:        { type: "page_cover" },
				cover_size:   "medium",
				cover_aspect: "cover",
				card_layout:  "compact",
			},
			filter: {
				property: "Status",
				select:   { equals: "Watchlist" },
			},
			sorts: [{ property: "Logged Date", direction: "descending" }],
		},
		// All Films: table, sortable by anything.
		{
			database_id:    databaseId,
			data_source_id: dataSourceId,
			name:           "All Films",
			type:           "table",
			configuration:  { type: "table" },
			sorts:          [{ property: "Watched Date", direction: "descending" }],
		},
	];
}

// ---------- Main -----------------------------------------------------------

async function main() {
	// Refuse to clobber an already-configured .env.
	const existing = readDotenv(".env");
	if (existing.FILMS_DATABASE_ID && !FORCE) {
		bail(`.env already has FILMS_DATABASE_ID set. Re-run with --force if you really want to create a new database.`);
	}

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	console.log("Letterboxd → Notion setup");
	console.log("=========================");
	console.log();
	console.log("This script will create a Films database at the root of your Notion");
	console.log("workspace, add three views (Watched, Watchlist, All Films), and write");
	console.log("a .env file with everything the worker and helper scripts need.");

	step("Step 1 / 3 — Notion API token");
	console.log("  Easiest: create a Personal Access Token (PAT). PATs act as you,");
	console.log("  so the worker can read/write any page you can — no per-page sharing.");
	console.log("    https://www.notion.so/developers/tokens");
	console.log("  Click \"New personal access token\", give it Read/Insert/Update,");
	console.log("  pick your workspace, copy the token.");
	console.log();
	console.log("  (Alternative: an internal integration token from");
	console.log("   notion.so/profile/integrations/internal also works, but you'll have");
	console.log("   to share the Films DB with that integration after it's created.)");
	const token = await prompt(rl, "  NOTION_API_TOKEN", existing.NOTION_API_TOKEN);
	if (!token.startsWith("ntn_")) bail(`Token doesn't look right (should start with "ntn_")`);

	const notion = new Client({ auth: token, notionVersion: NOTION_VERSION });

	// Validate token by hitting /users/me.
	try {
		const me = await notion.request<any>({ path: "users/me", method: "get" });
		success(`Authenticated as ${me?.bot?.workspace_name ?? me?.name ?? "unknown workspace"}`);
	} catch (e: any) {
		bail(`Token failed: ${e.message}`);
	}

	step("Step 2 / 3 — Letterboxd username");
	console.log("  Your Letterboxd profile is at letterboxd.com/USERNAME.");
	const letterboxdUser = await prompt(rl, "  LETTERBOXD_USER", existing.LETTERBOXD_USER);
	if (!letterboxdUser) bail("Letterboxd username is required");

	step("Step 3 / 3 — Creating database + views");

	// Create the database at the workspace root. The post-2025-09 API wraps
	// the property schema under `initial_data_source`. Notion auto-creates a
	// default view alongside the data source; we'll list and delete it after
	// creating our three custom views.
	const db = await notion.request<any>({
		path: "databases",
		method: "post",
		body: {
			parent: { type: "workspace", workspace: true },
			title: [{ type: "text", text: { content: "🎬 Films" } }],
			initial_data_source: { properties: SCHEMA },
		},
	});
	const databaseId = db.id;
	const dataSourceId: string | undefined = db.data_sources?.[0]?.id;
	if (!dataSourceId) bail("Database created but no data source ID returned — can't create views without it.");
	success(`Database created at workspace root`);
	info(`  database_id     = ${databaseId}`);
	info(`  data_source_id  = ${dataSourceId}`);

	// Create our three views.
	const createdViewIds = new Set<string>();
	for (const v of viewPayloads(databaseId, dataSourceId)) {
		try {
			const created = await notion.request<any>({ path: "views", method: "post", body: v });
			if (created?.id) createdViewIds.add(created.id);
			success(`View "${v.name}" created`);
		} catch (e: any) {
			console.log(`  ✗ View "${v.name}" failed: ${e.message}`);
		}
	}

	// Delete any other view on the database. This is just the auto-created
	// "Default view" that Notion makes alongside every new database.
	try {
		const listed = await notion.request<any>({
			path: `views?database_id=${databaseId}`,
			method: "get",
		});
		for (const v of listed?.results ?? []) {
			if (!createdViewIds.has(v.id)) {
				await notion.request({ path: `views/${v.id}`, method: "delete" });
				success(`Removed default view`);
			}
		}
	} catch (e: any) {
		// Non-fatal: the user can delete it manually in the UI.
		console.log(`  (couldn't auto-remove the default view: ${e.message}) ` +
			`You can delete it manually in Notion.`);
	}

	// Write .env. We deliberately don't persist the data source ID — the
	// scripts resolve it from FILMS_DATABASE_ID at startup, so users only
	// have to know the database ID (which is in the URL).
	writeDotenv(".env", {
		NOTION_API_TOKEN:  token,
		LETTERBOXD_USER:   letterboxdUser,
		FILMS_DATABASE_ID: databaseId,
	});
	success(`Wrote .env`);

	rl.close();

	console.log("\nNext steps");
	console.log("──────────");
	console.log("  1. ntn login                  (one-time)");
	console.log("  2. ntn workers new --here     (if you haven't already scaffolded)");
	console.log("     or just `ntn workers env push` if you're inside this repo");
	console.log("  3. ntn workers env push       (uploads .env to the worker's secret store)");
	console.log("  4. ntn workers deploy");
	console.log("  5. ntn workers sync trigger letterboxdSync --preview");
	console.log("     → confirms the worker can reach both Letterboxd and your DB");
	console.log("  6. ntn workers sync trigger letterboxdSync");
	console.log("");
	console.log("  Optional: import your full Letterboxd history before the first sync:");
	console.log("     npm run import-csv -- /path/to/letterboxd-export");
	console.log("");
	console.log("  Optional: enrich existing pages with metadata (director / cast / etc.):");
	console.log("     npm run backfill");
}

// ---------- .env helpers ---------------------------------------------------

function readDotenv(path: string): Record<string, string> {
	if (!fs.existsSync(path)) return {};
	const out: Record<string, string> = {};
	for (const line of fs.readFileSync(path, "utf8").split("\n")) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
		if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
	return out;
}

function writeDotenv(path: string, vars: Record<string, string>) {
	const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
	fs.writeFileSync(path, lines.join("\n") + "\n");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
