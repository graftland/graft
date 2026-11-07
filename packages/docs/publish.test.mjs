import { strict as assert } from "node:assert"
import { test } from "node:test"

import {
	commitBranch,
	commitUrl,
	injectScript,
	parseVersions,
	planCommits,
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
	url: commitUrl(commit, "graft-docs", site),
})

test("names a commit's branch and address by its hash", () => {
	assert.equal(commitBranch(a), "aaaaaaaaaaaa")
	assert.equal(
		commitUrl(a, "graft-docs", new URL("https://docs.example/graft/")),
		"https://aaaaaaaaaaaa.graft-docs.pages.dev/graft/",
	)
	assert.equal(
		versionsUrl("graft-docs").href,
		"https://versions.graft-docs.pages.dev/",
	)
	assert.throws(() => commitBranch("main"), /full commit hash/)
})

test("plans only commits that are not deployed, except the pushed one", () => {
	assert.deepEqual(planCommits({ wanted: [a, b, c, a], deployed: [a, b] }), {
		commits: [c],
		remaining: 0,
	})
	assert.deepEqual(planCommits({ wanted: [b], deployed: [a, b], pushed: b }), {
		commits: [b],
		remaining: 0,
	})
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
	assert.deepEqual(await readVersions("graft-docs", site, respond(404)), empty)
	await assert.rejects(
		readVersions("graft-docs", site, respond(503)),
		/HTTP 503/,
	)
	await assert.rejects(
		readVersions("graft-docs", site, respond(200, { versions: "none" })),
		/unexpected shape/,
	)
})

test("adds the select's script to a page once", () => {
	const page = "<html><head><title>Graft</title></head><body></body></html>"
	const once = injectScript(page, "graft-docs")
	assert.match(
		once,
		/<script src="https:\/\/versions\.graft-docs\.pages\.dev\/select\.js" defer><\/script><\/head>/,
	)
	assert.equal(injectScript(once, "graft-docs"), once)
	assert.equal(injectScript("plain text", "graft-docs"), "plain text")
})

test("redirects the old address to the same path on the new site", () => {
	const html = redirectPage(new URL("https://graftland.github.io/graft/"), site)
	assert.match(html, /const base = "\/graft\/"/)
	assert.match(html, /url=https:\/\/docs\.example\//)
})
