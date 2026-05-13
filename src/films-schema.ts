/**
 * Schema + view definitions for the Films database.
 *
 * Lives outside `scripts/setup.ts` so tests can import these values without
 * triggering setup's top-level prompts/side effects.
 */

export const RATING_OPTIONS = [
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

export const STATUS_OPTIONS = [
	{ name: "Watched",   color: "green" as const },
	{ name: "Watchlist", color: "blue"  as const },
];

// Renders "Runtime minutes" as e.g. "2h 30m" / "45m" / "2h" / "".
export const RUNTIME_FORMULA =
	'if(empty(prop("Runtime minutes")), "", ' +
		'if(prop("Runtime minutes") < 60, format(prop("Runtime minutes")) + "m", ' +
			'if(prop("Runtime minutes") % 60 == 0, format(floor(prop("Runtime minutes") / 60)) + "h", ' +
				'format(floor(prop("Runtime minutes") / 60)) + "h " + format(prop("Runtime minutes") % 60) + "m")))';

export const SCHEMA: Record<string, any> = {
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
	Runtime:               { formula: { expression: RUNTIME_FORMULA } },
	"Letterboxd Rating":   { number: { format: "number" } },
	"Rating Count":        { number: { format: "number_with_commas" } },
	Tagline:               { rich_text: {} },
	Plot:                  { rich_text: {} },
	IMDb:                  { url: {} },
	TMDB:                  { url: {} },
	"Letterboxd Film ID":  { rich_text: {} },
};

export function viewPayloads(databaseId: string, dataSourceId: string) {
	const galleryConfig = {
		type:         "gallery",
		cover:        { type: "page_cover" },
		cover_size:   "medium",
		cover_aspect: "cover",
		card_layout:  "compact",
	};
	return [
		{
			database_id: databaseId, data_source_id: dataSourceId,
			name: "Watched", type: "gallery",
			configuration: galleryConfig,
			filter: { property: "Status", select: { equals: "Watched" } },
			sorts: [{ property: "Watched Date", direction: "descending" }],
		},
		{
			database_id: databaseId, data_source_id: dataSourceId,
			name: "Watchlist", type: "gallery",
			configuration: galleryConfig,
			filter: { property: "Status", select: { equals: "Watchlist" } },
			sorts: [{ property: "Logged Date", direction: "descending" }],
		},
		{
			database_id: databaseId, data_source_id: dataSourceId,
			name: "All Films", type: "table",
			configuration: { type: "table" },
			sorts: [{ property: "Watched Date", direction: "descending" }],
		},
	];
}
