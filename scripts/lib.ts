/**
 * Shared helpers used by the CLI scripts.
 */

import { Client } from "@notionhq/client";

// All script-side Notion API calls use this version. We need 2026-03-11 for
// the Views API (list / delete) used during setup. The worker (src/index.ts)
// continues to use the SDK's default version (2022-06-28) inside
// `context.notion`, which is why the worker writes `parent: { database_id }`
// but the scripts use `parent: { data_source_id }`.
export const NOTION_VERSION = "2026-03-11";

export function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`Missing ${name}. See README.md → Configuration.`);
		process.exit(1);
	}
	return v;
}

export function notionClient(): Client {
	return new Client({
		auth:          requireEnv("NOTION_API_TOKEN"),
		notionVersion: NOTION_VERSION,
	});
}

/**
 * Resolves the data source ID for a Notion database. Notion's 2025-09-03 API
 * separates "databases" (the container) from "data sources" (the queryable
 * collection of rows). Almost every database has exactly one data source —
 * but they're different IDs, and only the data source ID works for
 * `/data_sources/{id}/query` and `/views`.
 *
 * Users typically know their database ID (it's in the URL). This function
 * resolves the data source ID with a single GET so scripts don't need users
 * to find it manually.
 */
export async function resolveDataSourceId(notion: Client, databaseId: string): Promise<string> {
	const db = await notion.request<any>({
		path:   `databases/${databaseId}`,
		method: "get",
	});
	const sources = db.data_sources;
	if (!Array.isArray(sources) || sources.length === 0) {
		throw new Error(
			`Database ${databaseId} has no data sources. Is it the right ID? ` +
			`(Open the database in Notion, then check the URL — it's the 32-char hex segment.)`,
		);
	}
	if (sources.length > 1) {
		console.warn(
			`Note: database has ${sources.length} data sources; using the first ("${sources[0].name}"). ` +
			`If that's wrong, file an issue — we'll add a way to pick.`,
		);
	}
	return sources[0].id;
}
