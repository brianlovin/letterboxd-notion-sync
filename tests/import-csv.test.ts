import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	parseCsv,
	parseCsvLine,
	diaryRow,
	watchedRow,
	watchlistRow,
	buildRatingsMap,
} from "../scripts/csv";

const fixturesDir = path.join(process.cwd(), "tests", "fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), "utf8");

test("parseCsvLine handles plain values", () => {
	assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("parseCsvLine handles quoted values with embedded commas", () => {
	assert.deepEqual(
		parseCsvLine(`Foo,"bar, baz",qux`),
		["Foo", "bar, baz", "qux"],
	);
});

test("parseCsvLine handles escaped double quotes", () => {
	assert.deepEqual(
		parseCsvLine(`Foo,"she said ""hi""",end`),
		["Foo", `she said "hi"`, "end"],
	);
});

test("parseCsv yields one object per data row, keyed by header", () => {
	const rows = parseCsv(fixture("diary.csv"));
	assert.equal(rows.length, 3);
	assert.equal(rows[0]["Name"], "One Battle After Another");
	assert.equal(rows[0]["Year"], "2025");
	assert.equal(rows[0]["Rating"], "4.0");
});

test("diaryRow maps Letterboxd's decimal rating to a star string", () => {
	const rows = parseCsv(fixture("diary.csv")).map(diaryRow);

	assert.equal(rows[0].rating, "★★★★");
	assert.equal(rows[1].rating, "★★½");
	assert.equal(rows[1].rewatch, true);
	assert.equal(rows[0].rewatch, false);
	assert.equal(rows[0].status, "Watched");
});

test("diaryRow preserves comma-bearing values inside quoted CSV fields", () => {
	const rows = parseCsv(fixture("diary.csv")).map(diaryRow);
	// "Foo, the Movie" appears as a CSV-quoted value with an embedded comma.
	// The CSV parser must keep it whole.
	assert.equal(rows[2].title, "Foo, the Movie");
	assert.equal(rows[2].tags, `comma "in" tag`);
});

test("watchlistRow defaults status, no rating or watch date", () => {
	const row = watchlistRow({
		Date: "2026-01-15",
		Name: "Thief",
		Year: "1981",
		"Letterboxd URI": "https://boxd.it/1TEc",
	});
	assert.equal(row.status, "Watchlist");
	assert.equal(row.rating, null);
	assert.equal(row.watchedDate, null);
	assert.equal(row.title, "Thief");
});

test("watchlistRow handles missing year", () => {
	const row = watchlistRow({ Date: "", Name: "Untitled", Year: "", "Letterboxd URI": "" });
	assert.equal(row.year, null);
	assert.equal(row.uri,  null);
});

test("watchedRow gives Status=Watched with no rating/watched date", () => {
	const rows = parseCsv(fixture("watched.csv")).map(watchedRow);
	assert.equal(rows.length, 3);
	assert.equal(rows[0].title,       "Whiplash");
	assert.equal(rows[0].year,        2014);
	assert.equal(rows[0].status,      "Watched");
	assert.equal(rows[0].rating,      null);
	assert.equal(rows[0].watchedDate, null);
	assert.equal(rows[0].loggedDate,  "2024-05-12");
});

test("buildRatingsMap turns ratings.csv into a (title|year) → star map", () => {
	const map = buildRatingsMap(parseCsv(fixture("ratings.csv")));
	// "not-a-number" Rating is silently dropped
	assert.equal(map.size, 2);
	assert.equal(map.get("Whiplash|2014"),          "★★★★★");
	assert.equal(map.get("Mad Max: Fury Road|2015"), "★★★★½");
});
