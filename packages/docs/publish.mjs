import { execFileSync } from "node:child_process"
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

// Pinned so that every deploy uploads with the same client.
const wrangler = "wrangler@4.152.0"

// The Preview that serves the commit list and the select.
const versionsPreview = "versions"

// How many versions keep their docs: the newest release tags, and the newest
// commits on main. A commit can be both. Together they stay well under the 100
// Previews a Worker has on the Free plan, past which Cloudflare deletes the
// least recently deployed one on its own.
export const keptReleases = 15
export const keptCommits = 30

// A GitHub Actions matrix holds at most 256 jobs.
const matrixLimit = 256

/**
 * The Worker Preview that keeps one commit's docs, named after the first 12
 * characters of its hash. Its address is `<name>.<site host>`.
 */
export const previewName = (commit) => {
	if (!/^[0-9a-f]{40}$/.test(commit))
		throw new Error(`Expected a full commit hash, got: ${commit}`)
	return commit.slice(0, 12)
}

const previewUrl = (name, site) =>
	new URL(site.pathname, `https://${name}.${site.host}`).href

/** The address of one commit's docs, under the site's base path. */
export const commitUrl = (commit, site) => previewUrl(previewName(commit), site)

/** Where every build loads the select from, and where the list lives. */
export const versionsUrl = (site) =>
	new URL(`https://${versionsPreview}.${site.host}/`)

const isVersion = (value) =>
	typeof value === "object" &&
	value !== null &&
	["commit", "date", "subject", "url"].every(
		(key) => typeof value[key] === "string",
	) &&
	Array.isArray(value.tags)

/** Check the shape of a `versions.json` read from the live site. */
export function parseVersions(value) {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof value.site !== "string" ||
		typeof value.production !== "string" ||
		!Array.isArray(value.versions) ||
		!value.versions.every(isVersion)
	)
		throw new Error("versions.json on the live site has an unexpected shape")
	return value
}

/**
 * Read the live list. Only a missing file starts a new one: any other failure
 * stops, so a deploy never drops the history.
 */
export async function readVersions(
	site,
	{ fetchUrl = fetch, beforeFirstDeploy = false } = {},
) {
	const url = new URL("versions.json", versionsUrl(site))
	let response
	try {
		response = await fetchUrl(url, { cache: "no-store" })
	} catch (cause) {
		// Before the first deploy, the domain has no records yet. Only planning
		// accepts that: at worst it builds commits again, while publishing a
		// new list would drop the history.
		if (beforeFirstDeploy && cause?.cause?.code === "ENOTFOUND")
			return { site: site.href, production: "", versions: [] }
		throw new Error(`Could not read ${url.href}`, { cause })
	}
	if (response.status === 404)
		return { site: site.href, production: "", versions: [] }
	if (!response.ok)
		throw new Error(`Could not read ${url.href}: HTTP ${response.status}`)
	return parseVersions(await response.json())
}

const releasePattern = /^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/

/**
 * Order release tags, newest first. A prerelease comes before its release,
 * as in semver; tags that are not versions are dropped.
 */
export function sortTags(tags) {
	const parsed = tags
		.map((tag) => ({ ...tag, match: releasePattern.exec(tag.name) }))
		.filter(({ match }) => match)
	const compare = (a, b) => {
		for (const index of [1, 2, 3]) {
			const order = Number(a.match[index]) - Number(b.match[index])
			if (order) return order
		}
		const [left, right] = [a.match[4], b.match[4]]
		if (left === right) return 0
		if (left === undefined) return 1
		if (right === undefined) return -1
		return left.localeCompare(right, "en", { numeric: true })
	}
	return parsed
		.sort((a, b) => compare(b, a))
		.map(({ name, commit }) => ({ name, commit }))
}

/**
 * The commits whose docs are kept: those of the newest release tags and the
 * newest commits on main, plus the production commit, which is never removed.
 */
export function keptCommitsOf({ tags, main, production = "" }) {
	const kept = new Set()
	for (const { commit } of sortTags(tags)) {
		if (kept.size >= keptReleases) break
		kept.add(commit)
	}
	for (const commit of main.slice(0, keptCommits)) kept.add(commit)
	if (production) kept.add(production)
	return kept
}

/** The commit of the newest stable release, or "" if there is none. */
export const latestRelease = (tags) =>
	sortTags(tags).find(({ name }) => !releasePattern.exec(name)[4])?.commit ?? ""

/**
 * The commits to build, leaving out the ones already deployed. Forced
 * commits are built even if they are deployed: the pushed commit, so a run
 * started again deploys it again, and any commit named to be rebuilt.
 */
export function planCommits({ wanted, deployed, forced = [] }) {
	const seen = new Set(deployed)
	const commits = [...new Set([...wanted, ...forced])].filter(
		(commit) => forced.includes(commit) || !seen.has(commit),
	)
	return {
		commits: commits.slice(0, matrixLimit),
		remaining: Math.max(0, commits.length - matrixLimit),
	}
}

/**
 * The new list: every commit that has docs, newest first, with the tags and
 * details git has for it.
 */
export function updateVersions({
	live,
	added,
	removed,
	details,
	site,
	production,
}) {
	const gone = new Set(removed)
	const commits = new Set(
		[...live.versions.map(({ commit }) => commit), ...added].filter(
			(commit) => !gone.has(commit),
		),
	)
	return {
		site: site.href,
		production,
		versions: [...commits]
			.map((commit) => ({ commit, ...details(commit) }))
			.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
	}
}

/**
 * The Wrangler configuration of the docs Worker. It only serves static
 * assets: production on the site's host, and every Preview on a subdomain of
 * it.
 */
export const workerConfig = ({ name, directory, site }) => ({
	name,
	compatibility_date: "2026-11-01",
	assets: {
		directory,
		html_handling: "auto-trailing-slash",
		not_found_handling: "404-page",
	},
	workers_dev: false,
	preview_urls: false,
	routes: [{ pattern: site.host, custom_domain: true, previews_enabled: true }],
	previews: {},
})

// Previews on a custom domain are indexed unless they say otherwise; only
// production should show up in search results.
export const noindexHeaders = `
/*
  X-Robots-Tag: noindex
`

const script = (site) =>
	`<script src="${new URL("select.js", versionsUrl(site)).href}" defer></script>`

/**
 * Add the select's script to a built page. Builds made before the select
 * existed get it the same way, so they are never changed at the source.
 */
export function injectScript(html, site) {
	const tag = script(site)
	if (html.includes(tag)) return html
	if (!html.includes("</head>")) return html
	return html.replace("</head>", `${tag}</head>`)
}

/**
 * A page for an old address that sends every path to the same path on the
 * new site.
 */
export function redirectPage(from, to) {
	const target = JSON.stringify(to.href)
	const base = JSON.stringify(from.pathname)
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Graft docs have moved</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${to.href}">
<script>
const base = ${base}
const path = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : ""
location.replace(new URL(path + location.search + location.hash, ${target}))
</script>
<meta http-equiv="refresh" content="0; url=${to.href}">
</head>
<body>
<p>The Graft docs have moved to <a href="${to.href}">${to.href}</a>.</p>
</body>
</html>
`
}

function required(name) {
	const value = process.env[name]
	if (!value) throw new Error(`Set ${name}`)
	return value
}

const site = () => new URL(required("DOCS_URL"))

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()

const lines = (text) => text.split("\n").filter(Boolean)

/** Every release tag and the commit it points to. */
function releaseTags() {
	return lines(
		git(
			"for-each-ref",
			"--format=%(refname:short) %(*objectname) %(objectname)",
			"refs/tags/v*",
		),
	).map((line) => {
		// An annotated tag names its commit in the second field.
		const [name, commit] = line.split(" ").filter(Boolean)
		return { name, commit }
	})
}

/** The newest commits on main, newest first. */
const mainCommits = () =>
	lines(
		git(
			"rev-list",
			"--first-parent",
			`--max-count=${keptCommits}`,
			process.env["DOCS_MAIN_REF"] ?? "origin/main",
		),
	)

function npx(args) {
	console.log(`$ npx ${wrangler} ${args.join(" ")}`)
	execFileSync("npx", ["--yes", wrangler, ...args], { stdio: "inherit" })
}

/** Write the Worker's configuration for a directory of assets. */
function configFor(directory) {
	const folder = mkdtempSync(join(tmpdir(), "graft-worker-"))
	const path = join(folder, "wrangler.json")
	writeFileSync(
		path,
		JSON.stringify(
			workerConfig({
				name: required("DOCS_WORKER"),
				directory: resolve(directory),
				site: site(),
			}),
			null,
			"\t",
		),
	)
	return path
}

/** Upload a directory as one Preview of the Worker. */
function preview(directory, name, message) {
	const headers = join(directory, "_headers")
	const existing = existsSync(headers) ? readFileSync(headers, "utf8") : ""
	writeFileSync(headers, existing + noindexHeaders)
	npx([
		"preview",
		`--config=${configFor(directory)}`,
		`--name=${name}`,
		`--message=${message}`,
	])
}

function output(name, value) {
	console.log(`${name}=${value}`)
	if (process.env["GITHUB_OUTPUT"])
		appendFileSync(process.env["GITHUB_OUTPUT"], `${name}=${value}\n`)
}

/**
 * Choose what a run builds: every kept commit that has no docs yet, and the
 * newest stable release when production does not serve it.
 */
async function plan() {
	const live = await readVersions(site(), { beforeFirstDeploy: true })
	const tags = releaseTags()
	const release = latestRelease(tags)
	const production = release && release !== live.production ? release : ""
	const kept = keptCommitsOf({
		tags,
		main: mainCommits(),
		production: release || live.production,
	})
	// Commits named by hand, such as one whose deployment is broken.
	const rebuild = (process.env["DOCS_REBUILD"] ?? "")
		.split(/[\s,]+/)
		.filter(Boolean)
		.map((name) => git("rev-parse", "--verify", `${name}^{commit}`))
	const pushed =
		process.env["DOCS_MODE"] === "main" ? [git("rev-parse", "HEAD")] : []
	const { commits, remaining } = planCommits({
		wanted: [...kept],
		deployed: live.versions.map(({ commit }) => commit),
		forced: [...pushed, ...rebuild],
	})
	if (remaining)
		console.log(`${remaining} more commits remain; run the workflow again.`)
	output("production", production)
	// The production job deploys its commit's Preview too.
	output("commits", JSON.stringify(commits.filter((c) => c !== production)))
}

/**
 * Add the select to a build and upload it as its commit's Preview, and as
 * production first when asked.
 */
function commit(directory, hash, target) {
	for (const file of readdirSync(directory, { recursive: true }))
		if (file.endsWith(".html")) {
			const path = join(directory, file)
			const html = readFileSync(path, "utf8")
			const injected = injectScript(html, site())
			if (injected !== html) writeFileSync(path, injected)
		}
	// Production also creates the Worker and its domain on the first run, so
	// it goes before the Preview, which adds the noindex header.
	if (target === "production")
		npx(["deploy", `--config=${configFor(directory)}`])
	preview(directory, previewName(hash), hash)
}

/**
 * Publish the list of commits that have docs, and delete the Previews of
 * commits that are no longer kept.
 */
async function list(deployedDirectory) {
	const live = await readVersions(site())
	// Each successful build leaves an empty file named after its commit.
	const added = existsSync(deployedDirectory)
		? readdirSync(deployedDirectory)
		: []
	const production = process.env["DOCS_PRODUCTION"] || live.production
	const tags = releaseTags()
	const kept = keptCommitsOf({ tags, main: mainCommits(), production })
	const removed = []
	for (const hash of new Set([
		...live.versions.map(({ commit }) => commit),
		...added,
	])) {
		if (kept.has(hash)) continue
		try {
			npx([
				"preview",
				"delete",
				`--worker-name=${required("DOCS_WORKER")}`,
				`--name=${previewName(hash)}`,
				"--skip-confirmation",
			])
			removed.push(hash)
		} catch (cause) {
			// It stays in the list, and the next run tries again.
			console.error(`Could not delete the docs of ${hash}`, cause)
		}
	}
	const names = new Map()
	for (const { name, commit } of sortTags(tags))
		names.set(commit, [...(names.get(commit) ?? []), name])
	const versions = updateVersions({
		live,
		added,
		removed,
		site: site(),
		production,
		details: (hash) => {
			const [date, subject] = git("log", "-1", "--format=%cI%n%s", hash).split(
				"\n",
			)
			return {
				date,
				subject,
				tags: names.get(hash) ?? [],
				url: commitUrl(hash, site()),
			}
		},
	})
	const directory = mkdtempSync(join(tmpdir(), "graft-versions-"))
	cpSync(fileURLToPath(new URL("./versions/", import.meta.url)), directory, {
		recursive: true,
	})
	writeFileSync(join(directory, "versions.json"), JSON.stringify(versions))
	preview(directory, versionsPreview, "The commit list and the select")
}

/** Write a redirect site from an old address into a directory. */
function redirect(directory, from) {
	mkdirSync(directory, { recursive: true })
	for (const file of ["index.html", "404.html"])
		writeFileSync(join(directory, file), redirectPage(new URL(from), site()))
}

/** Replace the old Cloudflare Pages site with a redirect to the new one. */
function retirePages(directory) {
	redirect(directory, required("DOCS_PAGES_URL"))
	npx([
		"pages",
		"deploy",
		resolve(directory),
		`--project-name=${required("DOCS_PAGES_PROJECT")}`,
		"--branch=main",
		"--commit-dirty=true",
	])
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const [command, ...args] = process.argv.slice(2)
	const commands = {
		plan: () => plan(),
		commit: () => commit(args[0], args[1], args[2]),
		list: () => list(args[0]),
		redirect: () => redirect(args[0], required("DOCS_OLD_URL")),
		"retire-pages": () => retirePages(args[0]),
	}
	if (Object.hasOwn(commands, command)) await commands[command]()
	else {
		console.error(
			"Usage: node publish.mjs plan | commit <dist> <hash> [production] | list <deployed> | redirect <directory> | retire-pages <directory>",
		)
		process.exitCode = 2
	}
}
