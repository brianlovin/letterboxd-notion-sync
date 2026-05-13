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
import { STAR_RATING_MAP } from "../src/letterboxd";

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

// ---------- CSV parsing (exported for tests) -------------------------------

export function parseCsv(text: string): Record<string, string>[] {
	// Letterboxd CSVs are RFC-4180-ish: standard quoting with "" as escape.
	// They don't include embedded newlines in fields (which would need a more
	// stateful parser), so line-by-line is fine.
	const rows: string[][] = [];
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (!line) continue;
		rows.push(parseCsvLine(line));
	}
	if (rows.length === 0) return [];
	const headers = rows[0];
	return rows.slice(1).map((row) => {
		const obj: Record<string, string> = {};
		headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
		return obj;
	});
}

export function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "", inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inQuotes) {
			if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
			else if (c === '"') inQuotes = false;
			else cur += c;
		} else {
			if (c === '"' && cur === "") inQuotes = true;
			else if (c === ",") { out.push(cur); cur = ""; }
			else cur += c;
		}
	}
	out.push(cur);
	return out;
}

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

// ---------- Row builders --------------------------------------------------

interface ImportRow {
	title:        string;
	year:         number | null;
	uri:          string | null;
	rating:       string | null;
	rewatch:      boolean;
	watchedDate:  string | null;
	loggedDate:   string | null;
	tags:         string | null;
	status:       "Watched" | "Watchlist";
}

function buildProperties(r: ImportRow) {
	const props: Record<string, any> = {
		Title:    { title: [{ text: { content: r.title } }] },
		Status:   { select: { name: r.status } },
	};
	if (r.year !== null)  props.Year                = { number: r.year };
	if (r.uri)            props["Letterboxd URI"]   = { url: r.uri };
	if (r.rating)         props.Rating              = { select: { name: r.rating } };
	if (r.rewatch)        props.Rewatch             = { checkbox: true };
	if (r.watchedDate)    props["Watched Date"]     = { date: { start: r.watchedDate } };
	if (r.loggedDate)     props["Logged Date"]      = { date: { start: r.loggedDate } };
	if (r.tags)           props.Tags                = { rich_text: [{ text: { content: r.tags.slice(0, 2000) } }] };
	return props;
}

export function diaryRow(raw: Record<string, string>): ImportRow {
	const title = raw["Name"]?.trim() ?? "";
	const year  = raw["Year"] ? parseInt(raw["Year"], 10) : null;
	const ratingRaw = raw["Rating"]?.trim();
	return {
		title,
		year:        Number.isFinite(year) ? year : null,
		uri:         raw["Letterboxd URI"]?.trim() || null,
		rating:      ratingRaw ? (STAR_RATING_MAP[ratingRaw] ?? null) : null,
		rewatch:     (raw["Rewatch"] ?? "").trim().toLowerCase() === "yes",
		watchedDate: raw["Watched Date"]?.trim() || null,
		loggedDate:  raw["Date"]?.trim() || null,
		tags:        raw["Tags"]?.trim() || null,
		status:      "Watched",
	};
}

export function watchlistRow(raw: Record<string, string>): ImportRow {
	const title = raw["Name"]?.trim() ?? "";
	const year  = raw["Year"] ? parseInt(raw["Year"], 10) : null;
	return {
		title,
		year:        Number.isFinite(year) ? year : null,
		uri:         raw["Letterboxd URI"]?.trim() || null,
		rating:      null,
		rewatch:     false,
		watchedDate: null,
		loggedDate:  raw["Date"]?.trim() || null,
		tags:        null,
		status:      "Watchlist",
	};
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
