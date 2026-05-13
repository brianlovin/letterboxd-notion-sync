/**
 * Adds the metadata properties to an existing Films data source.
 *
 *   npm run add-properties
 *
 * Use this if you already have a Films database (from an earlier version of
 * this project, or one you built by hand) that's missing some of the
 * enrichment columns. New installs get these properties automatically via
 * `npm run setup`.
 *
 * Idempotent: skips any property that already exists.
 *
 * Multi-select options are intentionally left empty — Notion auto-creates
 * an option the first time a page is written with a value that doesn't exist
 * yet, which is the self-healing behavior we want.
 */

import { notionClient, requireEnv, resolveDataSourceId } from "./lib";

const NEW_PROPERTIES: Record<string, any> = {
	Director:             { multi_select: {} },
	Cast:                 { multi_select: {} },
	Genres:               { multi_select: {} },
	Country:              { multi_select: {} },
	Studio:               { multi_select: {} },
	Runtime:              { number: { format: "number" } },
	"Letterboxd Rating":  { number: { format: "number" } },
	"Rating Count":       { number: { format: "number_with_commas" } },
	Tagline:              { rich_text: {} },
	Plot:                 { rich_text: {} },
	IMDb:                 { url: {} },
	TMDB:                 { url: {} },
	"Letterboxd Film ID": { rich_text: {} },
};

async function main() {
	const notion       = notionClient();
	const databaseId   = requireEnv("FILMS_DATABASE_ID");
	const dataSourceId = await resolveDataSourceId(notion, databaseId);

	const ds = await notion.request<any>({
		path:   `data_sources/${dataSourceId}`,
		method: "get",
	});
	const existing = new Set(Object.keys(ds.properties || {}));

	const toAdd: Record<string, any> = {};
	const skipped: string[] = [];
	for (const [name, config] of Object.entries(NEW_PROPERTIES)) {
		if (existing.has(name)) skipped.push(name);
		else toAdd[name] = config;
	}

	if (skipped.length) console.log(`Skipping existing: ${skipped.join(", ")}`);
	if (!Object.keys(toAdd).length) {
		console.log("All properties already exist. Nothing to do.");
		return;
	}

	console.log(`Adding: ${Object.keys(toAdd).join(", ")}`);
	await notion.request({
		path:   `data_sources/${dataSourceId}`,
		method: "patch",
		body:   { properties: toAdd },
	});
	console.log("Done.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
