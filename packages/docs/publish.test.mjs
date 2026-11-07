import { strict as assert } from "node:assert"
import { test } from "node:test"

import {
	commitBranch,
	commitUrl,
	injectScript,
	latestRelease,
	parseVersions,
	planCommits,
	productionWorker,
	readVersions,
	redirectPage,
	updateVersions,
	versionsUrl,
} from "./publish.mjs"

const a = "a".repeat(40)
const b = "b".repeat(40)
const c = "c".repeat(40)
const site = new URL("https://docs.example/")
const empty = { site: site.href, production: "", versions: [] }

const details = {
	[a]: { date: "2026-11-01T00:00:00Z", subject: "First", tags: ["v0.1.0"] },
	[b]: { date: "2026-11-02T00:00:00Z", subject: "Second", tags: [] },
	[c]: { date: "2026-11-03T00:00:00Z", subject: "Third", tags: ["v0.2.0"] },
}
const detail = (commit) => ({
	...details[commit],
	url: commitUrl(commit, "graft-docs.pages.dev", site),
})

test("names a commit's branch and address by its hash", () => {
	assert.equal(commitBranch(a), "aaaaaaaaaaaa")
	assert.equal(
		commitUrl(
			a,
			"graft-docs-x1.pages.dev",
			new URL("https://docs.example/graft/"),
		),
		"https://aaaaaaaaaaaa.graft-docs-x1.pages.dev/graft/",
	)
	assert.equal(
		versionsUrl("graft-docs-x1.pages.dev").href,
		"https://versions.graft-docs-x1.pages.dev/",
	)
	assert.throws(() => commitBranch("main"), /full commit hash/)
})

test("plans only commits that are not deployed, except forced ones", () => {
	assert.deepEqual(planCommits({ wanted: [a, b, c, a], deployed: [a, b] }), {
		commits: [c],
		remaining: 0,
	})
	assert.deepEqual(
		planCommits({ wanted: [c], deployed: [a, b], forced: [b] }),
		{
			commits: [c, b],
			remaining: 0,
		},
	)
	const many = Array.from({ length: 300 }, (_, index) =>
		index.toString(16).padStart(40, "0"),
	)
	const planned = planCommits({ wanted: many, deployed: [] })
	assert.equal(planned.commits.length, 256)
	assert.equal(planned.remaining, 44)
})

test("lists every deployed commit with its tags, newest first", () => {
	const first = updateVersions({
		live: empty,
		added: [a, c],
		details: detail,
		site,
		production: c,
	})
	const second = updateVersions({
		live: first,
		added: [b],
		details: detail,
		site,
		production: c,
	})
	assert.equal(second.production, c)
	assert.deepEqual(
		second.versions.map(({ commit, tags }) => [commit, tags]),
		[
			[c, ["v0.2.0"]],
			[b, []],
			[a, ["v0.1.0"]],
		],
	)
	assert.deepEqual(parseVersions(second), second)
})

test("starts a new list only when the live one is missing", async () => {
	const respond = (status, body) => async () =>
		new Response(body === undefined ? null : JSON.stringify(body), { status })
	assert.deepEqual(
		await readVersions("graft-docs.pages.dev", site, respond(404)),
		empty,
	)
	await assert.rejects(
		readVersions("graft-docs.pages.dev", site, respond(503)),
		/HTTP 503/,
	)
	await assert.rejects(
		readVersions(
			"graft-docs.pages.dev",
			site,
			respond(200, { versions: "none" }),
		),
		/unexpected shape/,
	)
})

test("adds the select's script to a page once", () => {
	const page = "<html><head><title>Graft</title></head><body></body></html>"
	const once = injectScript(page, "graft-docs.pages.dev")
	assert.match(
		once,
		/<script src="https:\/\/versions\.graft-docs\.pages\.dev\/select\.js" defer><\/script><\/head>/,
	)
	assert.equal(injectScript(once, "graft-docs.pages.dev"), once)
	assert.equal(injectScript("plain text", "graft-docs.pages.dev"), "plain text")
})

test("redirects the old address to the same path on the new site", () => {
	const html = redirectPage(new URL("https://graftland.github.io/graft/"), site)
	assert.match(html, /const base = "\/graft\/"/)
	assert.match(html, /url=https:\/\/docs\.example\//)
})

test("makes the newest deployed stable release the default", () => {
	const tags = new Map([
		[a, ["v0.9.0"]],
		[b, ["v0.10.0"]],
		[c, ["v1.0.0-beta.0"]],
	])
	assert.equal(latestRelease(tags, new Set([a, b, c])), b)
	assert.equal(latestRelease(tags, new Set([a, c])), a)
	assert.equal(latestRelease(tags, new Set([c])), "")
})

test("serves production from the release's deployment", async () => {
	const source = productionWorker("aaaaaaaaaaaa.graft-docs.pages.dev")
	const module = await import(
		`data:text/javascript,${encodeURIComponent(source)}`
	)
	const seen = []
	const original = globalThis.fetch
	globalThis.fetch = async (request) => {
		seen.push(request.url)
		return new Response(null, {
			status: 308,
			headers: {
				location: "https://aaaaaaaaaaaa.graft-docs.pages.dev/plugins/",
			},
		})
	}
	try {
		const response = await module.onRequest({
			request: new Request("https://docs.example/plugins?x=1"),
		})
		assert.deepEqual(seen, [
			"https://aaaaaaaaaaaa.graft-docs.pages.dev/plugins?x=1",
		])
		assert.equal(
			response.headers.get("location"),
			"https://docs.example/plugins/",
		)
	} finally {
		globalThis.fetch = original
	}
})
