import { sanitizeOptionName, type FilmMeta } from "./letterboxd.js";

export function richText(s: string | null) {
	return s
		? { rich_text: [{ type: "text", text: { content: s.slice(0, 2000) } }] }
		: { rich_text: [] };
}

export function multiSelect(values: string[]) {
	return {
		multi_select: values
			.map(sanitizeOptionName)
			.filter((v) => v.length > 0)
			.map((name) => ({ name })),
	};
}

export function numberProp(n: number | null) { return { number: n }; }
export function urlProp(u: string | null)    { return { url: u }; }

export function buildMetaProps(m: FilmMeta) {
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
