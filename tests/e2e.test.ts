/**
 * End-to-end tests against a real Notion workspace.
 *
 * Gated behind RUN_E2E=1 so CI doesn't trip without a token.
 *
 *   NOTION_API_TOKEN=ntn_... RUN_E2E=1 npm test -- tests/e2e.test.ts
 *
 * Token type matters:
 *   • PAT (`type: person`): tests create sandbox DBs at the workspace root.
 *   • Internal integration (`type: bot`): tests need E2E_PARENT_PAGE_ID
 *     pointing to a page the integration has been added to via Connections.
 *
 * Each test creates a sandbox database with a known title ("[E2E] …"), runs
 * its assertions, and trashes the database when done. If a previous run was
 * interrupted, trashed-but-not-yet-purged databases linger in the user's
 * trash; they fall off after a few days.
 *
 * Covers:
 *   • The schema in src/films-schema.ts matches what Notion accepts.
 *   • Every declared property lands with the correct type.
 *   • The Runtime formula renders as expected for 162, 120, 45, and empty.
 *   • Views API: create, list, delete.
 *   • The add-properties migration (legacy "Runtime" number → renamed to
 *     "Runtime minutes" with a new "Runtime" formula).
 */

import { test, after } from "node:test";
import * as assert from "node:assert/strict";

import { Client } from "@notionhq/client";

import { NOTION_VERSION } from "../scripts/lib";
import { SCHEMA, viewPayloads, RUNTIME_FORMULA } from "../src/films-schema";
import {
	parseDiaryRss,
	parseWatchlistHtml,
	parseFilmPage,
	nextWatchlistPagePath,
} from "../src/letterboxd";

const RUN_E2E         = process.env.RUN_E2E === "1";
const TOKEN           = process.env.NOTION_API_TOKEN ?? "";
const PARENT_PAGE_ID  = process.env.E2E_PARENT_PAGE_ID ?? "";

if (!RUN_E2E) {
	test("e2e tests skipped (set RUN_E2E=1 to enable)", () => {
		assert.ok(true);
	});
} else {
	if (!TOKEN) throw new Error("RUN_E2E=1 but NOTION_API_TOKEN is not set.");

	const notion = new Client({ auth: TOKEN, notionVersion: NOTION_VERSION });

	// Sandbox DBs need to be created under a *parent page* (not workspace
	// root), because workspace-root databases can't be trashed via the API
	// — repeated test runs would otherwise accumulate orphan DBs.
	//
	// If E2E_PARENT_PAGE_ID is set, use it. Otherwise we create a fresh
	// "[E2E] sandboxes" page once per test run (we can't trash *that* via
	// API either, so set E2E_PARENT_PAGE_ID once after the first run).
	let parentParamPromise: Promise<any> | null = null;
	function getParentParam(): Promise<any> {
		if (parentParamPromise) return parentParamPromise;
		parentParamPromise = (async () => {
			if (PARENT_PAGE_ID) return { type: "page_id", page_id: PARENT_PAGE_ID };

			const me = await notion.request<any>({ path: "users/me", method: "get" });
			const isPat = me?.bot?.owner?.type === "user";
			if (!isPat) {
				throw new Error(
					"This token is an internal integration. To run E2E tests, either:\n" +
					"  • Use a Personal Access Token from https://notion.so/developers/tokens, OR\n" +
					"  • Set E2E_PARENT_PAGE_ID to a page in your workspace that you've shared\n" +
					"    with the integration (via Connections → Add).",
				);
			}

			// Create a workspace-root parent. It can't be trashed via API —
			// recommend the user save its ID in .env for future runs.
			const created = await notion.request<any>({
				path: "pages", method: "post",
				body: {
					parent: { type: "workspace", workspace: true },
					properties: { title: { title: [{ text: { content: "[E2E] sandboxes" } }] } },
				},
			});
			console.warn(
				`\n  Created workspace-root parent page for sandbox DBs: ${created.id}\n` +
				`  Set E2E_PARENT_PAGE_ID=${created.id} in .env to reuse it next time\n` +
				`  (workspace-root pages can't be trashed via the API).\n`,
			);
			return { type: "page_id", page_id: created.id };
		})();
		return parentParamPromise;
	}

	const createdDatabaseIds: string[] = [];

	async function trashDatabase(id: string) {
		// Databases use the /v1/databases/{id} PATCH endpoint to trash;
		// /v1/pages/{id} only finds page records, not databases.
		try {
			await notion.request({ path: `databases/${id}`, method: "patch", body: { in_trash: true } });
		} catch {
			/* swallow — best-effort cleanup */
		}
	}

	after(async () => {
		for (const id of createdDatabaseIds) await trashDatabase(id);
	});

	async function createSandboxDatabase(title: string, schema: Record<string, any>): Promise<{ databaseId: string; dataSourceId: string }> {
		const parent = await getParentParam();
		const db = await notion.request<any>({
			path: "databases",
			method: "post",
			body: {
				parent,
				title:  [{ type: "text", text: { content: title } }],
				initial_data_source: { properties: schema },
			},
		});
		createdDatabaseIds.push(db.id);
		const dsId = db.data_sources?.[0]?.id;
		if (!dsId) throw new Error("Notion didn't return a data source ID");
		return { databaseId: db.id, dataSourceId: dsId };
	}

	test("creates a database with every property in our schema", async () => {
		const { dataSourceId } = await createSandboxDatabase(
			`[E2E] Films schema ${new Date().toISOString()}`,
			SCHEMA,
		);

		const ds = await notion.request<any>({
			path: `data_sources/${dataSourceId}`,
			method: "get",
		});

		// Each property in SCHEMA must exist on the data source with the
		// type we asked for.
		for (const [name, declared] of Object.entries(SCHEMA)) {
			const live = ds.properties?.[name];
			assert.ok(live, `missing property "${name}"`);
			const expectedType = Object.keys(declared)[0];
			assert.equal(live.type, expectedType, `"${name}" type ${live.type} ≠ expected ${expectedType}`);
		}
	});

	test("the Runtime formula renders correctly for 162, 120, 45, and null", async () => {
		const { databaseId, dataSourceId } = await createSandboxDatabase(
			`[E2E] Runtime formula ${new Date().toISOString()}`,
			SCHEMA,
		);

		const cases: { mins: number | null; expected: string }[] = [
			{ mins: 162,  expected: "2h 42m" },
			{ mins: 120,  expected: "2h"     },
			{ mins: 45,   expected: "45m"    },
			{ mins: null, expected: ""       },
		];

		// Create one page per case and remember its id.
		const pageIds: string[] = [];
		for (const c of cases) {
			const page = await notion.request<any>({
				path: "pages",
				method: "post",
				body: {
					parent:     { type: "data_source_id", data_source_id: dataSourceId },
					properties: {
						Title: { title: [{ text: { content: `mins=${c.mins ?? "null"}` } }] },
						...(c.mins !== null ? { "Runtime minutes": { number: c.mins } } : {}),
					},
				},
			});
			pageIds.push(page.id);
		}

		// Read each page back and assert the formula's string output.
		for (let i = 0; i < cases.length; i++) {
			const p = await notion.request<any>({ path: `pages/${pageIds[i]}`, method: "get" });
			const rendered = p.properties?.Runtime?.formula?.string ?? "";
			assert.equal(rendered, cases[i].expected, `mins=${cases[i].mins} → ${JSON.stringify(rendered)}, expected ${cases[i].expected}`);
		}

		// Sanity check: Runtime is still a formula property. Notion rewrites
		// the expression to use internal block_property references (rather
		// than the prop("Runtime minutes") syntax we sent), so we can't
		// compare strings — the rendered values above are what matters.
		const ds = await notion.request<any>({ path: `data_sources/${dataSourceId}`, method: "get" });
		assert.equal(ds.properties?.Runtime?.type, "formula");
		assert.ok(RUNTIME_FORMULA.includes("Runtime minutes"));  // smoke
	});

	test("views: create, list, delete one", async () => {
		const { databaseId, dataSourceId } = await createSandboxDatabase(
			`[E2E] Views ${new Date().toISOString()}`,
			SCHEMA,
		);

		const ourViewIds: string[] = [];
		for (const v of viewPayloads(databaseId, dataSourceId)) {
			const created = await notion.request<any>({ path: "views", method: "post", body: v });
			ourViewIds.push(created.id);
		}
		assert.equal(ourViewIds.length, 3);

		// List should include ours plus Notion's auto-default view.
		const listed = await notion.request<any>({
			path: `views?database_id=${databaseId}`,
			method: "get",
		});
		const allIds = new Set(listed.results.map((v: any) => v.id));
		for (const id of ourViewIds) assert.ok(allIds.has(id), `missing view ${id}`);
		assert.ok(listed.results.length >= 4, `expected >=4 views, got ${listed.results.length}`);

		// Delete the auto-default and confirm it's gone.
		const defaultViewId = listed.results.find((v: any) => !ourViewIds.includes(v.id))?.id;
		assert.ok(defaultViewId, "couldn't find an auto-created default view to delete");
		await notion.request({ path: `views/${defaultViewId}`, method: "delete" });

		const after = await notion.request<any>({
			path: `views?database_id=${databaseId}`,
			method: "get",
		});
		const afterIds = new Set(after.results.map((v: any) => v.id));
		assert.ok(!afterIds.has(defaultViewId), "default view still present after delete");
		assert.equal(after.results.length, 3);
	});

	// ─── Live Letterboxd parsers (catch HTML format drift) ────────────────────

	const LBX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
	const LBX_USER = process.env.LETTERBOXD_USER ?? "brianlovin";

	test("parseFilmPage works against a live Letterboxd film page", async () => {
		const r = await fetch("https://letterboxd.com/film/one-battle-after-another/", {
			headers: { "User-Agent": LBX_UA, "Accept": "text/html" },
		});
		assert.equal(r.status, 200);
		const meta = parseFilmPage(await r.text());
		assert.deepEqual(meta.directors, ["Paul Thomas Anderson"]);
		assert.ok(meta.cast.length >= 5, `expected 5+ cast members, got ${meta.cast.length}`);
		assert.ok(meta.runtimeMins && meta.runtimeMins > 100, `runtimeMins=${meta.runtimeMins}`);
		assert.ok(meta.imdbUrl?.startsWith("https://www.imdb.com/title/"), `imdbUrl=${meta.imdbUrl}`);
		assert.ok(meta.tmdbUrl?.startsWith("https://www.themoviedb.org/movie/"), `tmdbUrl=${meta.tmdbUrl}`);
		assert.match(meta.filmId ?? "", /^film:\d+$/);
	});

	test("parseDiaryRss works against the live diary RSS feed", async () => {
		const r = await fetch(`https://letterboxd.com/${LBX_USER}/rss/`, {
			headers: { "User-Agent": "LetterboxdNotionSync/1.0", "Accept": "application/rss+xml" },
		});
		assert.equal(r.status, 200, `RSS status ${r.status}`);
		const entries = parseDiaryRss(await r.text());
		assert.ok(entries.length > 0, `expected at least one diary entry, got 0`);
		for (const e of entries.slice(0, 3)) {
			assert.ok(e.title,  `entry without title`);
			assert.ok(e.url,    `entry without url`);
		}
	});

	test("parseWatchlistHtml works against the live watchlist HTML page", async () => {
		const r = await fetch(`https://letterboxd.com/${LBX_USER}/watchlist/`, {
			headers: { "User-Agent": LBX_UA, "Accept": "text/html" },
		});
		assert.equal(r.status, 200, `watchlist status ${r.status}`);
		const html = await r.text();
		const entries = parseWatchlistHtml(html);
		// Even if the user's watchlist is small, the page should still parse.
		// Allow 0 here so this passes for users with empty watchlists.
		for (const e of entries.slice(0, 3)) {
			assert.ok(e.title, `entry without title`);
			assert.ok(e.slug,  `entry without slug`);
			assert.match(e.url, /^https:\/\/letterboxd\.com\/film\//);
		}
		// And pagination either works or returns null cleanly.
		const next = nextWatchlistPagePath(html);
		if (next !== null) assert.match(next, /\/watchlist\/page\/\d+\//);
	});

	test("add-properties migration: renames legacy Runtime → Runtime minutes and adds the formula", async () => {
		// Build a legacy schema: has "Runtime" as a number, no "Runtime
		// minutes", no formula. Simulates a DB created before the split.
		const legacy: Record<string, any> = {
			Title:   { title: {} },
			Runtime: { number: { format: "number" } },
		};
		const { dataSourceId } = await createSandboxDatabase(
			`[E2E] Legacy migration ${new Date().toISOString()}`,
			legacy,
		);

		// Run the same two-step migration the script does: rename, then add
		// the new property.
		await notion.request({
			path: `data_sources/${dataSourceId}`,
			method: "patch",
			body: { properties: { Runtime: { name: "Runtime minutes" } } },
		});
		await notion.request({
			path: `data_sources/${dataSourceId}`,
			method: "patch",
			body: { properties: { Runtime: { formula: { expression: RUNTIME_FORMULA } } } },
		});

		const ds = await notion.request<any>({ path: `data_sources/${dataSourceId}`, method: "get" });
		assert.equal(ds.properties["Runtime minutes"]?.type, "number");
		assert.equal(ds.properties.Runtime?.type, "formula");
	});
}
