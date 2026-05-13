/**
 * Bulk-import your Letterboxd CSV export into the Films database.
 *
 *   npm run import-csv -- /path/to/letterboxd-export
 *   npm run import-csv -- /path/to/diary.csv
 *   npm run import-csv -- --dry-run /path/to/letterboxd-export
 *   npm run import-csv -- --limit 10 /path/to/diary.csv
 *
 * What's imported
 * ───────────────
 *   • diary.csv     → pages with Status="Watched", Watched Date, Rating,
 *                     Rewatch, Tags
 *   • watchlist.csv → pages with Status="Watchlist"
 *
 * Idempotent: dedupes against existing pages by (title, year). Pages already
 * in the Films DB are skipped — re-run safely after a partial failure.
 *
 * Posters are NOT set here. Run `npm run backfill` afterwards to enrich
 * imported pages with cover images, director, cast, runtime, etc.
 *
 * Get your CSV export at: letterboxd.com/settings/data/
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { notionClient, requireEnv, resolveDataSourceId } from "./lib";
import {
	parseCsv,
	diaryRow,
	watchlistRow,
	buildProperties,
	type ImportRow,
} from "./csv";

// ---------- CLI ------------------------------------------------------------

const args = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a.startsWith("--")) {
		const eq = a.indexOf("=");
		if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
		else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--") && a !== "--dry-run") {
			args.set(a.slice(2), process.argv[++i]);
		} else args.set(a.slice(2), true);
	} else positional.push(a);
}

const INPUT_PATH = positional[0];
const LIMIT      = args.has("limit") ? Number(args.get("limit")) : Infinity;
const DRY_RUN    = args.has("dry-run");

if (!INPUT_PATH) {
	console.error("Usage: import-csv <path-to-export-dir-or-csv> [--dry-run] [--limit N]");
	console.error("Tip:   get your export at letterboxd.com/settings/data/");
	process.exit(1);
}

// ---------- Client + IDs ---------------------------------------------------

const notion     = notionClient();
const databaseId = requireEnv("FILMS_DATABASE_ID");

// ---------- Existing-page index --------------------------------------------

async function readExistingKeys(dataSourceId: string): Promise<Set<string>> {
	const keys = new Set<string>();
	let cursor: string | undefined;
	do {
		const r = await notion.request<any>({
			path: `data_sources/${dataSourceId}/query`,
			method: "post",
			body: { page_size: 100, start_cursor: cursor },
		});
		for (const p of r.results) {
			const title = (p.properties?.Title?.title ?? []).map((t: any) => t.plain_text).join("").trim();
			const year  = p.properties?.Year?.number ?? null;
			keys.add(`${title}|${year ?? ""}`);
		}
		cursor = r.has_more ? r.next_cursor : undefined;
	} while (cursor);
	return keys;
}

// ---------- Source resolution ---------------------------------------------

function resolveSources(input: string): { diary?: string; watchlist?: string } {
	const stat = fs.statSync(input);
	if (stat.isDirectory()) {
		const diary     = path.join(input, "diary.csv");
		const watchlist = path.join(input, "watchlist.csv");
		return {
			diary:     fs.existsSync(diary)     ? diary     : undefined,
			watchlist: fs.existsSync(watchlist) ? watchlist : undefined,
		};
	}
	const name = path.basename(input).toLowerCase();
	if (name.includes("diary"))     return { diary: input };
	if (name.includes("watchlist")) return { watchlist: input };
	console.error(`Couldn't infer CSV type from "${name}" (expected "diary" or "watchlist" in the filename).`);
	process.exit(1);
}

// ---------- Main -----------------------------------------------------------

async function main() {
	const dataSourceId = await resolveDataSourceId(notion, databaseId);

	const { diary, watchlist } = resolveSources(INPUT_PATH);
	if (!diary && !watchlist) {
		console.error(`No diary.csv or watchlist.csv found in ${INPUT_PATH}`);
		process.exit(1);
	}

	console.log(`Reading existing pages from Notion…`);
	const existing = await readExistingKeys(dataSourceId);
	console.log(`  ${existing.size} pages already in the database`);

	const rows: ImportRow[] = [];
	if (diary) {
		const parsed = parseCsv(fs.readFileSync(diary, "utf8")).map(diaryRow);
		console.log(`  diary.csv:     ${parsed.length} rows`);
		rows.push(...parsed);
	}
	if (watchlist) {
		const parsed = parseCsv(fs.readFileSync(watchlist, "utf8")).map(watchlistRow);
		console.log(`  watchlist.csv: ${parsed.length} rows`);
		rows.push(...parsed);
	}

	let imported = 0, skipped = 0, failed = 0;
	for (const r of rows) {
		if (imported + skipped >= LIMIT) break;
		if (!r.title) { skipped++; continue; }

		const key = `${r.title}|${r.year ?? ""}`;
		if (existing.has(key)) { skipped++; continue; }

		try {
			if (!DRY_RUN) {
				await notion.request({
					path: "pages",
					method: "post",
					body: {
						parent:     { type: "data_source_id", data_source_id: dataSourceId },
						properties: buildProperties(r),
					},
				});
			}
			imported++;
			existing.add(key);  // prevent later duplicates within same run
			if (imported % 25 === 0) console.log(`  + imported ${imported}`);
		} catch (e: any) {
			failed++;
			console.error(`  ! ${r.title} (${r.year}): ${e.message}`);
		}
	}

	console.log("\n----");
	console.log(`Imported: ${imported}${DRY_RUN ? " (dry-run, no writes)" : ""}`);
	console.log(`Skipped:  ${skipped}`);
	console.log(`Failed:   ${failed}`);
	if (imported > 0 && !DRY_RUN) {
		console.log(`\nNow run \`npm run backfill\` to add poster covers + metadata.`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
