/**
 * Letterboxd → Notion sync.
 *
 * Daily worker that pulls your Letterboxd diary RSS and watchlist HTML,
 * then writes new entries into your Films database with poster covers.
 *
 * Architecture
 * ────────────
 * Notion Workers' sync API requires a managed database. We declare a tiny
 * audit-log database ("🎬 Letterboxd sync runs") that the worker owns, one
 * row per run with counts and notes. The real work happens inside `execute`
 * via `context.notion`, which writes to your existing Films database.
 *
 * Configuration (worker secrets via `ntn workers env push`)
 * ─────────────────────────────────────────────────────────
 *   LETTERBOXD_USER     — your Letterboxd username (e.g. "brianlovin")
 *   FILMS_DATABASE_ID   — Notion database ID of your Films DB (UUID)
 *   NOTION_API_TOKEN    — integration token with access to the Films DB
 */

import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";

import {
	parseDiaryRss,
	parseWatchlistHtml,
	nextWatchlistPagePath,
	extractOgImage,
	parseFilmPage,
	type DiaryEntry,
	type WatchlistEntry,
	type FilmMeta,
} from "./letterboxd.js";
import { buildMetaProps } from "./film-props.js";

// ---------- Config ---------------------------------------------------------

// Read at module load but tolerate missing values — Notion's capability
// introspection runs this module without env injected. We assert at execute
// time instead, so a misconfigured worker fails loudly into the audit log
// rather than silently breaking the deploy.
const LETTERBOXD_USER   = process.env.LETTERBOXD_USER   ?? "";
const FILMS_DATABASE_ID = process.env.FILMS_DATABASE_ID ?? "";

function assertEnv() {
	const missing = (["LETTERBOXD_USER", "FILMS_DATABASE_ID"] as const)
		.filter(n => !process.env[n]);
	if (missing.length) throw new Error(
		`Missing env: ${missing.join(", ")}. Set with: ntn workers env set <KEY>=<VALUE>`,
	);
}

const worker = new Worker();
export default worker;

// ---------- Audit-log database (managed by the worker) --------------------

const syncRuns = worker.database("syncRuns", {
	type: "managed",
	initialTitle: "🎬 Letterboxd sync runs",
	primaryKeyProperty: "Run ID",
	schema: {
		properties: {
			"Run ID":  Schema.title(),
			Started:   Schema.date(),
			Added:     Schema.number(),
			Updated:   Schema.number(),
			Errors:    Schema.number(),
			Notes:     Schema.richText(),
		},
	},
});

// ---------- Rate limit -----------------------------------------------------

// 5 requests/second is comfortable for Letterboxd. If you start seeing 429s,
// drop this to 2.
const letterboxd = worker.pacer("letterboxd", {
	allowedRequests: 5,
	intervalMs: 1000,
});

// ---------- Constants ------------------------------------------------------

// Letterboxd's CDN tolerates anything browser-shaped, but a bare RSS-style
// User-Agent gets Cloudflare-challenged on some endpoints (notably
// /watchlist/rss/). Use a realistic browser string for HTML fetches.
const HTML_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const WATCHLIST_PAGE_CAP = 20;
const NOTES_MAX_CHARS    = 1900;

// ---------- Types ----------------------------------------------------------

interface ExistingEntry {
	pageId: string;
	status: string | null;
}

// ---------- Letterboxd fetchers --------------------------------------------

async function fetchLetterboxdRss(path: string): Promise<string> {
	await letterboxd.wait();
	const url = `https://letterboxd.com/${LETTERBOXD_USER}/${path}`;
	const r = await fetch(url, {
		headers: {
			"User-Agent": "LetterboxdNotionSync/1.0",
			"Accept":     "application/rss+xml, application/xml",
		},
	});
	if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
	return r.text();
}

async function fetchLetterboxdHtml(path: string): Promise<string> {
	await letterboxd.wait();
	const url = `https://letterboxd.com/${LETTERBOXD_USER}/${path}`;
	const r = await fetch(url, {
		headers: {
			"User-Agent": HTML_UA,
			"Accept":     "text/html,application/xhtml+xml",
		},
	});
	if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
	return r.text();
}

// Fetches the canonical film page and returns the og:image cover URL plus
// parsed metadata (director, cast, genres, runtime, IMDb/TMDB IDs, ...).
// Returns nulls on any failure — a single film's enrichment failing shouldn't
// block adding the film with basic info.
async function fetchFilmPage(slug: string): Promise<{ poster: string | null; meta: FilmMeta | null }> {
	try {
		await letterboxd.wait();
		const r = await fetch(`https://letterboxd.com/film/${slug}/`, {
			headers: { "User-Agent": HTML_UA, "Accept": "text/html" },
		});
		if (!r.ok) return { poster: null, meta: null };
		const html = await r.text();
		return { poster: extractOgImage(html), meta: parseFilmPage(html) };
	} catch {
		return { poster: null, meta: null };
	}
}

// Diary RSS links look like https://letterboxd.com/USER/film/SLUG/... — strip
// the slug so we can hit the canonical /film/SLUG/ page. Older entries use
// boxd.it/... shortlinks; for those we skip enrichment.
function slugFromDiaryUrl(url: string): string | null {
	const m = /\/film\/([^/?#]+)/.exec(url);
	return m ? m[1] : null;
}

// ---------- Notion database read ------------------------------------------

async function readExistingFilms(notion: any): Promise<Map<string, ExistingEntry>> {
	const map = new Map<string, ExistingEntry>();
	let cursor: string | undefined;
	do {
		const r: any = await notion.databases.query({
			database_id:  FILMS_DATABASE_ID,
			page_size:    100,
			start_cursor: cursor,
		});
		for (const p of r.results) {
			const titleArr = p.properties?.Title?.title || [];
			const title = titleArr.map((t: any) => t.plain_text).join("").trim();
			const year   = p.properties?.Year?.number ?? null;
			const status = p.properties?.Status?.select?.name ?? null;
			map.set(`${title}|${year ?? ""}`, { pageId: p.id, status });
		}
		cursor = r.has_more ? r.next_cursor : undefined;
	} while (cursor);
	return map;
}

// ---------- Property payload builders -------------------------------------

function buildCreateProps(entry: DiaryEntry | WatchlistEntry, status: "Watched" | "Watchlist") {
	const today = new Date().toISOString().slice(0, 10);
	const props: Record<string, any> = {
		"Title":          { title: [{ text: { content: entry.title } }] },
		"Status":         { select: { name: status } },
		"Letterboxd URI": { url: entry.url },
		"Logged Date":    { date: { start: today } },
	};
	if (entry.year !== null) props["Year"] = { number: entry.year };
	if ("rating" in entry && entry.rating)           props["Rating"]       = { select: { name: entry.rating } };
	if ("watchedDate" in entry && entry.watchedDate) props["Watched Date"] = { date: { start: entry.watchedDate } };
	if ("rewatch" in entry && entry.rewatch)         props["Rewatch"]      = { checkbox: true };
	return props;
}

function buildTransitionProps(entry: DiaryEntry) {
	const props: Record<string, any> = { "Status": { select: { name: "Watched" } } };
	if (entry.rating)      props["Rating"]       = { select: { name: entry.rating } };
	if (entry.watchedDate) props["Watched Date"] = { date: { start: entry.watchedDate } };
	if (entry.rewatch)     props["Rewatch"]      = { checkbox: true };
	return props;
}

function truncate(s: string, n = 80): string {
	if (!s) return "";
	return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------- The sync -------------------------------------------------------

worker.sync("letterboxdSync", {
	database: syncRuns,
	mode:     "incremental",
	schedule: "1d",
	execute:  async (_state, { notion }) => {
		const started = new Date();
		const runId   = `run-${started.toISOString().replace(/[:.]/g, "-")}`;
		let added = 0, updated = 0, errors = 0;
		const notes: string[] = [];

		try { assertEnv(); } catch (e: any) {
			errors++;
			notes.push(e.message);
			return logRun(runId, started, added, updated, errors, notes);
		}

		// 1. Read existing films so we can dedupe by (title, year).
		let existing: Map<string, ExistingEntry>;
		try {
			existing = await readExistingFilms(notion);
			notes.push(`existing=${existing.size}`);
		} catch (e: any) {
			errors++;
			notes.push(`READ_DB_FAILED: ${e.message}`);
			return logRun(runId, started, added, updated, errors, notes);
		}

		// 2. Diary RSS — recently watched films.
		try {
			const diary = parseDiaryRss(await fetchLetterboxdRss("rss/"));
			notes.push(`diary=${diary.length}`);
			for (const e of diary) {
				const key = `${e.title}|${e.year ?? ""}`;
				const ex  = existing.get(key);
				try {
					if (!ex) {
						const slug = slugFromDiaryUrl(e.url);
						const { poster, meta } = slug ? await fetchFilmPage(slug) : { poster: null, meta: null };
						const properties = meta
							? { ...buildCreateProps(e, "Watched"), ...buildMetaProps(meta) }
							: buildCreateProps(e, "Watched");
						const params: any = {
							parent: { database_id: FILMS_DATABASE_ID },
							properties,
						};
						// RSS poster wins (it's the user's own watched-poster); fall back to
						// the film page's og:image when RSS didn't include one.
						const cover = e.poster ?? poster;
						if (cover) params.cover = { type: "external", external: { url: cover } };
						await notion.pages.create(params);
						added++;
					} else if (ex.status === "Watchlist") {
						// Watchlist → Watched transition: keep the existing page,
						// upgrade its status + add watch date / rating.
						const params: any = {
							page_id: ex.pageId,
							properties: buildTransitionProps(e),
						};
						if (e.poster) params.cover = { type: "external", external: { url: e.poster } };
						await notion.pages.update(params);
						updated++;
					}
				} catch (err: any) {
					errors++;
					notes.push(`diary[${e.title}]: ${truncate(err.message)}`);
				}
			}
		} catch (e: any) {
			errors++;
			notes.push(`DIARY_RSS_FAILED: ${e.message}`);
		}

		// 3. Watchlist HTML (the /watchlist/rss/ endpoint is CF-blocked, but
		//    the HTML page renders fine for datacenter IPs). Walks pages via
		//    the "next" link until exhausted.
		try {
			const wl: WatchlistEntry[] = [];
			let path = "watchlist/";
			let pages = 0;
			while (path) {
				const html = await fetchLetterboxdHtml(path);
				wl.push(...parseWatchlistHtml(html));
				pages++;
				const next = nextWatchlistPagePath(html);
				if (!next) break;
				// next looks like "/USER/watchlist/page/N/"; strip the user
				// prefix so fetchLetterboxdHtml can prepend it again.
				const prefix = `/${LETTERBOXD_USER}/`;
				path = next.startsWith(prefix) ? next.slice(prefix.length) : next.replace(/^\//, "");
				if (pages > WATCHLIST_PAGE_CAP) {
					notes.push(`wl: pagination cap (${WATCHLIST_PAGE_CAP}) hit`);
					break;
				}
			}
			notes.push(`watchlist=${wl.length} (${pages} pages)`);
			for (const e of wl) {
				const key = `${e.title}|${e.year ?? ""}`;
				if (existing.has(key)) continue;
				try {
					const { poster, meta } = await fetchFilmPage(e.slug);
					const properties = meta
						? { ...buildCreateProps(e, "Watchlist"), ...buildMetaProps(meta) }
						: buildCreateProps(e, "Watchlist");
					const params: any = {
						parent: { database_id: FILMS_DATABASE_ID },
						properties,
					};
					if (poster) params.cover = { type: "external", external: { url: poster } };
					await notion.pages.create(params);
					added++;
				} catch (err: any) {
					errors++;
					notes.push(`wl[${e.title}]: ${truncate(err.message)}`);
				}
			}
		} catch (e: any) {
			errors++;
			notes.push(`WATCHLIST_FAILED: ${e.message}`);
		}

		return logRun(runId, started, added, updated, errors, notes);
	},
});

function logRun(
	runId: string,
	started: Date,
	added: number,
	updated: number,
	errors: number,
	notes: string[],
) {
	return {
		changes: [{
			type: "upsert" as const,
			key: runId,
			properties: {
				"Run ID":  Builder.title(runId),
				Started:   Builder.date(started.toISOString().slice(0, 10)),
				Added:     Builder.number(added),
				Updated:   Builder.number(updated),
				Errors:    Builder.number(errors),
				Notes:     Builder.richText(truncate(notes.join("; "), NOTES_MAX_CHARS)),
			},
		}],
		hasMore: false,
	};
}

