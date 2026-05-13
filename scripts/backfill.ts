/**
 * Enriches existing Films pages with metadata scraped from Letterboxd:
 * Director, Cast (top 5), Genres, Country, Studio (top 3), Runtime,
 * Letterboxd Rating, Rating Count, Tagline, Plot, IMDb URL, TMDB URL,
 * Letterboxd Film ID.
 *
 *   npm run backfill
 *   npm run backfill -- --limit 5            # test on a small batch
 *   npm run backfill -- --dry-run            # show what would change
 *   npm run backfill -- --force              # re-enrich pages that already
 *                                            # have a Director set
 *   npm run backfill -- --order oldest       # oldest pages first
 *
 * Idempotent: by default, skips pages whose Director property is non-empty.
 *
 * Multi-select options grow organically — when we PATCH with a value that
 * doesn't exist as an option, Notion auto-creates it. No upfront option
 * registration required.
 */

import { notionClient, requireEnv, resolveDataSourceId } from "./lib";
import { parseFilmPage, sanitizeOptionName, type FilmMeta } from "../src/letterboxd";

const HTML_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LETTERBOXD_RPS = 5;

// ---------- CLI ------------------------------------------------------------

const args = new Map<string, string | true>();
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a.startsWith("--")) {
		const eq = a.indexOf("=");
		if (eq > 0) args.set(a.slice(2, eq), a.slice(eq + 1));
		else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--"))
			args.set(a.slice(2), process.argv[++i]);
		else args.set(a.slice(2), true);
	}
}
const LIMIT   = args.has("limit") ? Number(args.get("limit")) : Infinity;
const ORDER   = (args.get("order") as string) ?? "recent";
const DRY_RUN = args.has("dry-run");
const FORCE   = args.has("force");

// ---------- Client + IDs ---------------------------------------------------

const notion     = notionClient();
const databaseId = requireEnv("FILMS_DATABASE_ID");

// ---------- Rate limiter ---------------------------------------------------

class Pacer {
	private slots: number[] = [];
	constructor(private readonly rps: number) {}
	async wait(): Promise<void> {
		const now = Date.now();
		this.slots = this.slots.filter((t) => now - t < 1000);
		if (this.slots.length >= this.rps) {
			const delay = 1000 - (now - this.slots[0]) + 5;
			await new Promise((r) => setTimeout(r, delay));
			return this.wait();
		}
		this.slots.push(Date.now());
	}
}
const pacer = new Pacer(LETTERBOXD_RPS);

// ---------- Letterboxd fetch ----------------------------------------------

async function fetchFilm(url: string): Promise<string> {
	await pacer.wait();
	const r = await fetch(url, {
		headers:  { "User-Agent": HTML_UA, "Accept": "text/html" },
		redirect: "follow",
	});
	if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
	return r.text();
}

// ---------- Notion property builders --------------------------------------

function richText(s: string | null) {
	return s ? { rich_text: [{ type: "text", text: { content: s.slice(0, 2000) } }] } : { rich_text: [] };
}

function multiSelect(values: string[]) {
	return {
		multi_select: values
			.map(sanitizeOptionName)
			.filter((v) => v.length > 0)
			.map((name) => ({ name })),
	};
}

function numberProp(n: number | null) { return { number: n }; }
function urlProp(u: string | null)    { return { url: u }; }

function buildUpdate(m: FilmMeta) {
	return {
		Director:             multiSelect(m.directors),
		Cast:                 multiSelect(m.cast),
		Genres:               multiSelect(m.genres),
		Country:              multiSelect(m.countries),
		Studio:               multiSelect(m.studios),
		"Runtime minutes":    numberProp(m.runtimeMins),
		"Letterboxd Rating":  numberProp(m.rating !== null ? Math.round(m.rating * 100) / 100 : null),
		"Rating Count":       numberProp(m.ratingCount),
		Tagline:              richText(m.tagline),
		Plot:                 richText(m.plot),
		IMDb:                 urlProp(m.imdbUrl),
		TMDB:                 urlProp(m.tmdbUrl),
		"Letterboxd Film ID": richText(m.filmId),
	};
}

// ---------- Page iteration -------------------------------------------------

interface FilmPage {
	id: string;
	title: string;
	year: number | null;
	uri: string | null;
	directorAlreadySet: boolean;
}

async function* iterPages(dataSourceId: string): AsyncGenerator<FilmPage> {
	let cursor: string | undefined;
	const sortDirection = ORDER === "oldest" ? "ascending" : "descending";
	while (true) {
		const r = await notion.request<any>({
			path: `data_sources/${dataSourceId}/query`,
			method: "post",
			body: {
				page_size:    100,
				start_cursor: cursor,
				sorts:        [{ timestamp: "created_time", direction: sortDirection }],
			},
		});
		for (const p of r.results) {
			const props = p.properties;
			const title = (props.Title?.title ?? []).map((t: any) => t.plain_text).join("").trim();
			const year  = props.Year?.number ?? null;
			const uri   = props["Letterboxd URI"]?.url ?? null;
			const directorAlreadySet = (props.Director?.multi_select?.length ?? 0) > 0;
			yield { id: p.id, title, year, uri, directorAlreadySet };
		}
		if (!r.has_more) break;
		cursor = r.next_cursor;
	}
}

// ---------- Main -----------------------------------------------------------

async function main() {
	const dataSourceId = await resolveDataSourceId(notion, databaseId);

	let scanned = 0, skipped = 0, enriched = 0, failed = 0;
	const errors: string[] = [];

	for await (const page of iterPages(dataSourceId)) {
		if (scanned >= LIMIT) break;
		scanned++;

		if (page.directorAlreadySet && !FORCE) { skipped++; continue; }
		if (!page.uri) {
			failed++;
			errors.push(`${page.title} (${page.year}): no Letterboxd URI`);
			continue;
		}

		try {
			const html   = await fetchFilm(page.uri);
			const meta   = parseFilmPage(html);
			const update = buildUpdate(meta);

			const dirStr   = meta.directors.join(", ") || "?";
			const genreStr = meta.genres.join("/")     || "?";
			console.log(`[${scanned}] ${page.title} (${page.year}) — ${dirStr} • ${genreStr} • ${meta.runtimeMins ?? "?"}m • ★${meta.rating ?? "?"}`);

			if (!DRY_RUN) {
				await notion.request({
					path:   `pages/${page.id}`,
					method: "patch",
					body:   { properties: update },
				});
			}
			enriched++;
		} catch (e: any) {
			failed++;
			const msg = `${page.title} (${page.year}): ${e.message ?? e}`;
			errors.push(msg);
			console.error("  !", msg);
		}
	}

	console.log("\n----");
	console.log(`Scanned:  ${scanned}`);
	console.log(`Skipped:  ${skipped} (already had Director set; use --force to re-enrich)`);
	console.log(`Enriched: ${enriched}${DRY_RUN ? " (dry-run, no writes)" : ""}`);
	console.log(`Failed:   ${failed}`);
	if (errors.length) {
		console.log(`\nErrors:\n  ${errors.slice(0, 20).join("\n  ")}${errors.length > 20 ? `\n  ... ${errors.length - 20} more` : ""}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
