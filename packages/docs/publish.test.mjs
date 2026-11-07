import { strict as assert } from "node:assert"
import { test } from "node:test"

import {
	commitUrl,
	injectScript,
	keptCommits,
	keptCommitsOf,
	keptReleases,
	latestRelease,
	parseVersions,
	planCommits,
	previewName,
	readVersions,
	redirectPage,
	sortTags,
	updateVersions,
	versionsUrl,
	workerConfig,
} from "./publish.mjs"

const a = "a".repeat(40)
const b = "b".repeat(40)
const c = "c".repeat(40)
const hash = (index) => index.toString(16).padStart(40, "0")
const site = new URL("https://docs.example/")
const empty = { site: site.href, production: "", versions: [] }

const details = {
	[a]: { date: "2026-11-01T00:00:00Z", subject: "First", tags: ["v0.1.0"] },
	[b]: { date: "2026-11-02T00:00:00Z", subject: "Second", tags: [] },
	[c]: { date: "2026-11-03T00:00:00Z", subject: "Third", tags: ["v0.2.0"] },
}
const detail = (commit) => ({
	...details[commit],
	url: commitUrl(commit, site),
})

test("names a commit's Preview and address by its hash", () => {
	assert.equal(previewName(a), "aaaaaaaaaaaa")
	assert.equal(
		commitUrl(a, new URL("https://docs.example/graft/")),
		"https://aaaaaaaaaaaa.docs.example/graft/",
	)
	assert.equal(versionsUrl(site).href, "https://versions.docs.example/")
	assert.throws(() => previewName("main"), /full commit hash/)
})

test("orders release tags by version, prereleases before their release", () => {
	const names = [
		"v0.10.0",
		"v0.9.0",
		"v1.0.0-beta.2",
		"v1.0.0",
		"v1.0.0-beta.10",
		"latest",
	]
	assert.deepEqual(
		sortTags(names.map((name) => ({ name, commit: a }))).map(
			({ name }) => name,
		),
		["v1.0.0", "v1.0.0-beta.10", "v1.0.0-beta.2", "v0.10.0", "v0.9.0"],
	)
})

test("makes the newest stable release the default", () => {
	assert.equal(
		latestRelease([
			{ name: "v0.9.0", commit: a },
			{ name: "v0.10.0", commit: b },
			{ name: "v1.0.0-beta.0", commit: c },
		]),
		b,
	)
	assert.equal(latestRelease([{ name: "v1.0.0-beta.0", commit: c }]), "")
})

test("keeps the newest releases, the newest commits and production", () => {
	const tags = Array.from({ length: 20 }, (_, index) => ({
		name: `v0.${index}.0`,
		commit: hash(1000 + index),
	}))
	const main = Array.from({ length: 40 }, (_, index) => hash(index))
	const kept = keptCommitsOf({ tags, main, production: hash(1000) })
	assert.equal(kept.size, keptReleases + keptCommits + 1)
	assert.ok(kept.has(hash(1019)) && kept.has(hash(1005)))
	assert.ok(!kept.has(hash(1004)))
	assert.ok(kept.has(hash(29)) && !kept.has(hash(30)))
	assert.ok(kept.has(hash(1000)))
	// A tagged commit on main counts once.
	assert.equal(
		keptCommitsOf({ tags: [{ name: "v1.0.0", commit: a }], main: [a, b] }).size,
		2,
	)
})

test("plans only commits that are not deployed, except forced ones", () => {
	assert.deepEqual(planCommits({ wanted: [a, b, c, a], deployed: [a, b] }), {
		commits: [c],
		remaining: 0,
	})
	assert.deepEqual(
		planCommits({ wanted: [c], deployed: [a, b], forced: [b] }),
		{ commits: [c, b], remaining: 0 },
	)
	const many = Array.from({ length: 300 }, (_, index) => hash(index))
	const planned = planCommits({ wanted: many, deployed: [] })
	assert.equal(planned.commits.length, 256)
	assert.equal(planned.remaining, 44)
})

test("lists the commits that have docs, newest first", () => {
	const first = updateVersions({
		live: empty,
		added: [a, c],
		removed: [],
		details: detail,
		site,
		production: c,
	})
	const second = updateVersions({
		live: first,
		added: [b],
		removed: [a],
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
		],
	)
	assert.deepEqual(parseVersions(second), second)
})

test("starts a new list only when the live one is missing", async () => {
	const respond = (status, body) => async () =>
		new Response(body === undefined ? null : JSON.stringify(body), { status })
	assert.deepEqual(await readVersions(site, { fetchUrl: respond(404) }), empty)
	await assert.rejects(
		readVersions(site, { fetchUrl: respond(503) }),
		/HTTP 503/,
	)
	await assert.rejects(
		readVersions(site, { fetchUrl: respond(200, { versions: "none" }) }),
		/unexpected shape/,
	)
	const unknownHost = async () => {
		throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })
	}
	await assert.rejects(readVersions(site, { fetchUrl: unknownHost }))
	assert.deepEqual(
		await readVersions(site, {
			fetchUrl: unknownHost,
			beforeFirstDeploy: true,
		}),
		empty,
	)
})

test("serves production and every Preview from the site's domain", () => {
	const config = workerConfig({ name: "docs", directory: "/dist", site })
	assert.deepEqual(config.routes, [
		{ pattern: "docs.example", custom_domain: true, previews_enabled: true },
	])
	assert.deepEqual(config.previews, {})
	assert.equal(config.assets.directory, "/dist")
	assert.equal(config.workers_dev, false)
})

test("adds the select's script to a page once", () => {
	const page = "<html><head><title>Graft</title></head><body></body></html>"
	const once = injectScript(page, site)
	assert.match(
		once,
		/<script src="https:\/\/versions\.docs\.example\/select\.js" defer><\/script><\/head>/,
	)
	assert.equal(injectScript(once, site), once)
	assert.equal(injectScript("plain text", site), "plain text")
})

test("redirects an old address to the same path on the new site", () => {
	const html = redirectPage(new URL("https://graftland.github.io/graft/"), site)
	assert.match(html, /const base = "\/graft\/"/)
	assert.match(html, /url=https:\/\/docs\.example\//)
})
