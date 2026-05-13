/**
 * Pure parsers for Letterboxd RSS, watchlist HTML, and film pages.
 *
 * Shared between the worker (`src/index.ts`) and the backfill script
 * (`scripts/backfill.ts`). No I/O — pass in the raw response body, get back
 * structured data.
 */

export interface DiaryEntry {
	title:        string;
	year:         number | null;
	url:          string;
	poster:       string | null;
	watchedDate:  string | null;  // YYYY-MM-DD
	rating:       string | null;  // star string or null
	rewatch:      boolean;
}

export interface WatchlistEntry {
	title: string;
	year:  number | null;
	url:   string;
	slug:  string;
}

export interface FilmMeta {
	directors:    string[];
	cast:         string[];
	genres:       string[];
	countries:    string[];
	studios:      string[];
	runtimeMins:  number | null;
	rating:       number | null;
	ratingCount:  number | null;
	tagline:      string | null;
	plot:         string | null;
	imdbUrl:      string | null;
	tmdbUrl:      string | null;
	filmId:       string | null;
}

// Letterboxd's `<letterboxd:memberRating>` is a decimal between 0.5 and 5.0.
// Render as a star string to match how Letterboxd displays ratings.
export const STAR_RATING_MAP: Record<string, string> = {
	"5":   "★★★★★", "5.0": "★★★★★",
	"4.5": "★★★★½",
	"4":   "★★★★",  "4.0": "★★★★",
	"3.5": "★★★½",
	"3":   "★★★",   "3.0": "★★★",
	"2.5": "★★½",
	"2":   "★★",    "2.0": "★★",
	"1.5": "★½",
	"1":   "★",     "1.0": "★",
	"0.5": "½",
};

// ---------- XML/HTML primitives -------------------------------------------

export function decodeXmlEntities(s: string): string {
	return s
		.replace(/&amp;/g,  "&")
		.replace(/&lt;/g,   "<")
		.replace(/&gt;/g,   ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
		.replace(/&nbsp;/g,  " ");
}

function unwrapCdata(s: string): string {
	const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(s);
	return m ? m[1] : s;
}

function getTag(block: string, tag: string): string {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag.split(":")[0]}(?::[^>]*)?>`);
	const m = re.exec(block);
	return m ? decodeXmlEntities(unwrapCdata(m[1])).trim() : "";
}

// ---------- Diary RSS ------------------------------------------------------

export function parseDiaryRss(xml: string): DiaryEntry[] {
	const out: DiaryEntry[] = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const block = m[1];
		const title = getTag(block, "letterboxd:filmTitle");
		if (!title) continue;
		const yearStr     = getTag(block, "letterboxd:filmYear");
		const link        = getTag(block, "link");
		const description = getTag(block, "description");
		const watched     = getTag(block, "letterboxd:watchedDate");
		const rewatchStr  = getTag(block, "letterboxd:rewatch");
		const ratingRaw   = getTag(block, "letterboxd:memberRating");
		const posterM = /<img[^>]+src="([^"]+)"/.exec(description);
		out.push({
			title,
			year:        yearStr ? (parseInt(yearStr, 10) || null) : null,
			url:         link,
			poster:      posterM ? posterM[1] : null,
			watchedDate: watched || null,
			rating:      ratingRaw ? (STAR_RATING_MAP[ratingRaw] ?? null) : null,
			rewatch:     rewatchStr.toLowerCase() === "yes",
		});
	}
	return out;
}

// ---------- Watchlist HTML -------------------------------------------------

// Each watchlist page lists films inside <div data-component-class="LazyPoster">
// elements. Title and slug live in data-* attributes. Posters are NOT
// extractable from the markup (only a CF-blocked /image-150/ redirect URL is
// there); resolveFilmPoster() reads og:image from the film page instead.
export function parseWatchlistHtml(html: string): WatchlistEntry[] {
	const out: WatchlistEntry[] = [];
	for (const m of html.matchAll(/<div[^>]+data-component-class="LazyPoster"[^>]*>/g)) {
		const tag = m[0];
		const name = /data-item-name="([^"]+)"/.exec(tag)?.[1];
		const slug = /data-item-slug="([^"]+)"/.exec(tag)?.[1];
		const link = /data-item-link="([^"]+)"/.exec(tag)?.[1];
		if (!name || !slug) continue;
		const decoded = decodeXmlEntities(name);
		const ym = /^(.+) \((\d{4})\)$/.exec(decoded);
		out.push({
			title: ym ? ym[1] : decoded,
			year:  ym ? parseInt(ym[2], 10) : null,
			url:   `https://letterboxd.com${link ?? `/film/${slug}/`}`,
			slug,
		});
	}
	return out;
}

// Returns the path of the next watchlist page (e.g. "/USER/watchlist/page/2/")
// or null when we're on the last page.
export function nextWatchlistPagePath(html: string): string | null {
	const tag = /<a[^>]*\bclass="next"[^>]*>/i.exec(html);
	if (!tag) return null;
	const href = /href="([^"]+)"/.exec(tag[0]);
	return href ? href[1] : null;
}

// ---------- Film page (for poster + enrichment) ---------------------------

// Notion's cover renderer can't follow Letterboxd's /image-150/ redirect
// (it 403s outside a real browser). The film page's og:image tag has the
// final CDN URL, which Notion accepts.
export function extractOgImage(html: string): string | null {
	const m = /<meta property="og:image" content="([^"]+)"/.exec(html);
	return m ? decodeXmlEntities(m[1]) : null;
}

// Letterboxd wraps the JSON-LD payload like:
//   <script type="application/ld+json">
//   /* <![CDATA[ */
//   {...}
//   /* ]]> */
//   </script>
// We extract just the {...} payload — the simplest reliable way to handle
// nested braces.
export function extractJsonLd(html: string): any | null {
	const block = /<script type="application\/ld\+json">[^]*?<\/script>/.exec(html);
	if (!block) return null;
	const start = block[0].indexOf("{");
	const end   = block[0].lastIndexOf("}");
	if (start < 0 || end < start) return null;
	try { return JSON.parse(block[0].slice(start, end + 1)); }
	catch { return null; }
}

interface FilmMetaOptions {
	castTopN?:   number;
	studioTopN?: number;
}

export function parseFilmPage(html: string, opts: FilmMetaOptions = {}): FilmMeta {
	const castTopN   = opts.castTopN   ?? 5;
	const studioTopN = opts.studioTopN ?? 3;
	const json = extractJsonLd(html) ?? {};

	const directors: string[] = (json.director ?? []).map((d: any) => d.name).filter(Boolean);
	const cast:      string[] = ((json.actors ?? []) as any[]).slice(0, castTopN).map((a) => a.name).filter(Boolean);
	const genres:    string[] = (json.genre ?? []).filter(Boolean);
	const countries: string[] = (json.countryOfOrigin ?? []).map((c: any) => c.name).filter(Boolean);
	const studios:   string[] = ((json.productionCompany ?? []) as any[]).slice(0, studioTopN).map((s) => s.name).filter(Boolean);

	const rating      = typeof json.aggregateRating?.ratingValue === "number" ? json.aggregateRating.ratingValue : null;
	const ratingCount = typeof json.aggregateRating?.ratingCount === "number" ? json.aggregateRating.ratingCount : null;

	// Footer paragraph: "162&nbsp;mins &nbsp; More at <a ...IMDb...> <a ...TMDB...>"
	const footer       = /class="text-link text-footer"[^>]*>([^]*?)<\/p>/.exec(html)?.[1] ?? "";
	const runtimeM     = /(\d+)\s*(?:&nbsp;|\s)mins?/.exec(footer);
	const runtimeMins  = runtimeM ? parseInt(runtimeM[1], 10) : null;
	const imdbM        = /imdb\.com\/title\/(tt\d+)/.exec(footer);
	const tmdbM        = /themoviedb\.org\/movie\/(\d+)/.exec(footer);

	// Letterboxd's internal film ID lives in the report-form URL.
	const filmIdM = /\/ajax\/(film:\d+)\//.exec(html);

	const taglineM = /<h4 class="tagline">([^<]+)<\/h4>/.exec(html);
	const descM    = /<meta name="description" content="([^"]+)"/.exec(html);

	return {
		directors, cast, genres, countries, studios,
		runtimeMins, rating, ratingCount,
		imdbUrl: imdbM ? `https://www.imdb.com/title/${imdbM[1]}/` : null,
		tmdbUrl: tmdbM ? `https://www.themoviedb.org/movie/${tmdbM[1]}/` : null,
		filmId:  filmIdM ? filmIdM[1] : null,
		tagline: taglineM ? decodeXmlEntities(taglineM[1]).trim() : null,
		plot:    descM    ? decodeXmlEntities(descM[1]).trim()    : null,
	};
}

// ---------- Property-value sanitization -----------------------------------

// Notion multi-select option names can't contain commas. The natural
// affected cases are names like "Tyler, The Creator" or "Foo Co., Ltd." —
// dropping the comma reads cleanly in both.
export function sanitizeOptionName(name: string): string {
	return name.replace(/,/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
}
