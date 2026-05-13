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
 *
 * Also handles the Runtime → "Runtime minutes" + Runtime (formula) migration
 * for databases that pre-date that schema split.
 */

import { notionClient, requireEnv, resolveDataSourceId } from "./lib";

// Renders "Runtime minutes" as "2h 30m" / "45m" / "2h" / "" (empty).
const RUNTIME_FORMULA_EXPRESSION =
	'if(empty(prop("Runtime minutes")), "", ' +
		'if(prop("Runtime minutes") < 60, format(prop("Runtime minutes")) + "m", ' +
			'if(prop("Runtime minutes") % 60 == 0, format(floor(prop("Runtime minutes") / 60)) + "h", ' +
				'format(floor(prop("Runtime minutes") / 60)) + "h " + format(prop("Runtime minutes") % 60) + "m")))';

const NEW_PROPERTIES: Record<string, any> = {
	Director:             { multi_select: {} },
	Cast:                 { multi_select: {} },
	Genres:               { multi_select: {} },
	Country:              { multi_select: {} },
	Studio:               { multi_select: {} },
	"Runtime minutes":    { number: { format: "number" } },
	Runtime:              { formula: { expression: RUNTIME_FORMULA_EXPRESSION } },
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
	const properties = ds.properties || {};

	// Legacy migration: if Runtime exists and is a number, rename it to
	// "Runtime minutes". This has to be a separate PATCH from creating the
	// new Runtime formula — Notion won't accept rename + create-with-same-name
	// in one payload (the keys collide).
	const runtime = properties.Runtime;
	if (runtime && runtime.type === "number") {
		console.log(`Migrating: renaming "Runtime" (number) → "Runtime minutes"`);
		await notion.request({
			path:   `data_sources/${dataSourceId}`,
			method: "patch",
			body:   { properties: { Runtime: { name: "Runtime minutes" } } },
		});
		// Reflect the rename locally so the next loop computes the right set.
		properties["Runtime minutes"] = { ...runtime, name: "Runtime minutes" };
		delete properties.Runtime;
	}

	const existing = new Set(Object.keys(properties));

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
