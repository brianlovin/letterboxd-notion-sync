/**
 * Pure CSV parsing + Letterboxd row builders. No I/O, no env lookups —
 * safe to import from tests.
 */

import { STAR_RATING_MAP } from "../src/letterboxd";

export interface ImportRow {
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

export function buildProperties(r: ImportRow) {
	const props: Record<string, any> = {
		Title:  { title: [{ text: { content: r.title } }] },
		Status: { select: { name: r.status } },
	};
	if (r.year !== null) props.Year              = { number: r.year };
	if (r.uri)           props["Letterboxd URI"] = { url: r.uri };
	if (r.rating)        props.Rating            = { select: { name: r.rating } };
	if (r.rewatch)       props.Rewatch           = { checkbox: true };
	if (r.watchedDate)   props["Watched Date"]   = { date: { start: r.watchedDate } };
	if (r.loggedDate)    props["Logged Date"]    = { date: { start: r.loggedDate } };
	if (r.tags)          props.Tags              = { rich_text: [{ text: { content: r.tags.slice(0, 2000) } }] };
	return props;
}
