import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	parseDiaryRss,
	parseWatchlistHtml,
	nextWatchlistPagePath,
	parseFilmPage,
	extractJsonLd,
	extractOgImage,
	decodeXmlEntities,
	sanitizeOptionName,
	STAR_RATING_MAP,
} from "../src/letterboxd";

// `npm test` runs from the repo root, so resolving from cwd is reliable
// and avoids the ESM-only `import.meta.url` dance under `module: nodenext`.
const fixturesDir = path.join(process.cwd(), "tests", "fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), "utf8");

// ---------- decodeXmlEntities ---------------------------------------------

test("decodeXmlEntities handles named entities", () => {
	assert.equal(decodeXmlEntities("Foo &amp; Bar"),       "Foo & Bar");
	assert.equal(decodeXmlEntities("&lt;tag&gt;"),         "<tag>");
	assert.equal(decodeXmlEntities("&quot;hi&quot;"),      `"hi"`);
	assert.equal(decodeXmlEntities("can&apos;t"),          "can't");
	assert.equal(decodeXmlEntities("non&nbsp;breaking"),   "non breaking");
});

test("decodeXmlEntities handles numeric entities", () => {
	assert.equal(decodeXmlEntities("caf&#233;"), "café");
});

// ---------- sanitizeOptionName --------------------------------------------

test("sanitizeOptionName drops commas (Notion rejects them)", () => {
	assert.equal(sanitizeOptionName("Tyler, The Creator"),         "Tyler The Creator");
	assert.equal(sanitizeOptionName("Tomson (HK) Films Co., Ltd."), "Tomson (HK) Films Co. Ltd.");
});

test("sanitizeOptionName trims whitespace and caps length", () => {
	assert.equal(sanitizeOptionName("  hello  world  "), "hello world");
	const long = "x".repeat(150);
	assert.equal(sanitizeOptionName(long).length, 100);
});

// ---------- parseDiaryRss --------------------------------------------------

test("parseDiaryRss extracts diary entries and skips non-film items", () => {
	const entries = parseDiaryRss(fixture("diary.rss"));
	assert.equal(entries.length, 2, "should skip the non-film item with no filmTitle");

	const [first, second] = entries;
	assert.equal(first.title,       "One Battle After Another");
	assert.equal(first.year,        2025);
	assert.equal(first.rating,      "★★★★");
	assert.equal(first.rewatch,     false);
	assert.equal(first.watchedDate, "2025-12-19");
	assert.match(first.poster ?? "", /oboaa\.jpg$/);

	assert.equal(second.title,   "Heart Eyes");
	assert.equal(second.rating,  "★★½");
	assert.equal(second.rewatch, true);
});

// ---------- parseWatchlistHtml --------------------------------------------

test("parseWatchlistHtml extracts items from data-* attributes", () => {
	const items = parseWatchlistHtml(fixture("watchlist.html"));
	assert.equal(items.length, 3);

	assert.deepEqual(items[0], {
		title: "Thief",
		year:  1981,
		url:   "https://letterboxd.com/film/thief/",
		slug:  "thief",
	});
	assert.equal(items[1].title, "Marty Supreme");
	// HTML entity decoded:
	assert.equal(items[2].title, "Mr. & Mrs. Smith");
});

test("nextWatchlistPagePath finds the Older link", () => {
	assert.equal(nextWatchlistPagePath(fixture("watchlist.html")), "/brianlovin/watchlist/page/2/");
});

test("nextWatchlistPagePath returns null when there is no next page", () => {
	assert.equal(nextWatchlistPagePath("<p>no pagination</p>"), null);
});

// ---------- parseFilmPage --------------------------------------------------

test("parseFilmPage extracts JSON-LD fields with comment+CDATA wrapper", () => {
	const meta = parseFilmPage(fixture("film-page.html"));

	assert.deepEqual(meta.directors, ["Jane Director"]);
	assert.deepEqual(meta.cast,      ["Actor One", "Actor Two", "Actor Three", "Actor Four", "Actor Five"]);
	assert.deepEqual(meta.studios,   ["Studio One", "Studio Two", "Studio Three"]);
	assert.deepEqual(meta.genres,    ["Drama", "Thriller"]);
	assert.deepEqual(meta.countries, ["USA", "UK"]);
	assert.equal(meta.rating,        4.15);
	assert.equal(meta.ratingCount,   12345);
});

test("parseFilmPage extracts footer + meta fields", () => {
	const meta = parseFilmPage(fixture("film-page.html"));

	assert.equal(meta.runtimeMins, 162);
	assert.equal(meta.imdbUrl,     "https://www.imdb.com/title/tt12345678/");
	assert.equal(meta.tmdbUrl,     "https://www.themoviedb.org/movie/999/");
	assert.equal(meta.filmId,      "film:451");
	assert.equal(meta.tagline,     "A great tagline lives here.");
	assert.match(meta.plot ?? "",  /A test plot synopsis goes here, with "quotes" and & ampersand\./);
});

test("parseFilmPage respects castTopN and studioTopN options", () => {
	const meta = parseFilmPage(fixture("film-page.html"), { castTopN: 2, studioTopN: 1 });
	assert.deepEqual(meta.cast,    ["Actor One", "Actor Two"]);
	assert.deepEqual(meta.studios, ["Studio One"]);
});

test("parseFilmPage handles missing JSON-LD gracefully", () => {
	const meta = parseFilmPage(`<html><body>no metadata</body></html>`);
	assert.deepEqual(meta.directors, []);
	assert.deepEqual(meta.cast,      []);
	assert.equal(meta.rating,        null);
	assert.equal(meta.runtimeMins,   null);
});

// ---------- extractJsonLd / extractOgImage --------------------------------

test("extractJsonLd returns null when no script tag is present", () => {
	assert.equal(extractJsonLd("<p>plain html</p>"), null);
});

test("extractJsonLd returns null when JSON parsing fails", () => {
	const broken = `<script type="application/ld+json">/* <![CDATA[ */ {not-json /* ]]> */</script>`;
	assert.equal(extractJsonLd(broken), null);
});

test("extractOgImage decodes the og:image URL", () => {
	const html = `<meta property="og:image" content="https://a.ltrbxd.com/x.jpg?v=1&amp;y=2">`;
	assert.equal(extractOgImage(html), "https://a.ltrbxd.com/x.jpg?v=1&y=2");
});

// ---------- STAR_RATING_MAP -----------------------------------------------

test("STAR_RATING_MAP covers all half-star increments", () => {
	for (const raw of ["0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.0"]) {
		assert.ok(STAR_RATING_MAP[raw], `expected mapping for "${raw}"`);
	}
});
