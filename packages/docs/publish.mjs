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

// The Cloudflare Pages branch that serves the commit list and the select.
const versionsBranch = "versions"

// A GitHub Actions matrix holds at most 256 jobs.
const matrixLimit = 256

/**
 * The Cloudflare Pages branch that keeps one commit's deployment. Its alias is
 * `<branch>.<project>.pages.dev`; Cloudflare cuts aliases at 28 characters, so a
 * 12-character prefix of the hash stays whole.
 */
export const commitBranch = (commit) => {
	if (!/^[0-9a-f]{40}$/.test(commit))
		throw new Error(`Expected a full commit hash, got: ${commit}`)
	return commit.slice(0, 12)
}

const branchUrl = (branch, project, site) =>
	new URL(site.pathname, `https://${branch}.${project}.pages.dev`).href

/** The address of the deployment that keeps one commit, under the site's base path. */
export const commitUrl = (commit, project, site) =>
	branchUrl(commitBranch(commit), project, site)

/** Where every build loads the select from, and where the list lives. */
export const versionsUrl = (project) =>
	new URL(`https://${versionsBranch}.${project}.pages.dev/`)

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
export async function readVersions(project, site, fetchUrl = fetch) {
	const url = new URL("versions.json", versionsUrl(project))
	const response = await fetchUrl(url, { cache: "no-store" })
	if (response.status === 404)
		return { site: site.href, production: "", versions: [] }
	if (!response.ok)
		throw new Error(`Could not read ${url.href}: HTTP ${response.status}`)
	return parseVersions(await response.json())
}

/**
 * The commits to build, oldest first, leaving out the ones already deployed.
 * The commit that was pushed is always built, so a run started again deploys
 * it again.
 */
export function planCommits({ wanted, deployed, pushed }) {
	const seen = new Set(deployed)
	const commits = [...new Set(wanted)].filter(
		(commit) => commit === pushed || !seen.has(commit),
	)
	return {
		commits: commits.slice(0, matrixLimit),
		remaining: Math.max(0, commits.length - matrixLimit),
	}
}

/**
 * The new list: every deployed commit, newest first, with the tags and
 * details git has for it. Production moves only forward along history.
 */
export function updateVersions({ live, added, details, site, production }) {
	const commits = new Set([
		...live.versions.map(({ commit }) => commit),
		...added,
	])
	return {
		site: site.href,
		production,
		versions: [...commits]
			.map((commit) => ({ commit, ...details(commit) }))
			.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
	}
}

const script = (project) =>
	`<script src="${new URL("select.js", versionsUrl(project)).href}" defer></script>`

/**
 * Add the select's script to a built page. Builds made before the select
 * existed get it the same way, so they are never built again.
 */
export function injectScript(html, project) {
	const tag = script(project)
	if (html.includes(tag)) return html
	if (!html.includes("</head>")) return html
	return html.replace("</head>", `${tag}</head>`)
}

/**
 * A page for the old GitHub Pages address that sends every path to the same
 * path on the new site.
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

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()

const lines = (text) => text.split("\n").filter(Boolean)

const isAncestor = (older, newer) => {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", older, newer])
		return true
	} catch {
		return false
	}
}

/** Release tags by the commit they point to, newest version first. */
function tagsByCommit() {
	const tags = new Map()
	for (const line of lines(
		git(
			"for-each-ref",
			"--sort=-v:refname",
			"--format=%(refname:short) %(*objectname) %(objectname)",
			"refs/tags/v*",
		),
	)) {
		const [name, ...objects] = line.split(" ").filter(Boolean)
		// An annotated tag names its commit in the second field.
		const target = objects[0]
		tags.set(target, [...(tags.get(target) ?? []), name])
	}
	return tags
}

function deploy(directory, branch, commit) {
	const args = [
		"--yes",
		wrangler,
		"pages",
		"deploy",
		directory,
		`--project-name=${required("DOCS_PROJECT")}`,
		`--branch=${branch}`,
		...(commit ? [`--commit-hash=${commit}`] : []),
	]
	console.log(`$ npx ${args.join(" ")}`)
	execFileSync("npx", args, { stdio: "inherit" })
}

function output(name, value) {
	console.log(`${name}=${value}`)
	if (process.env["GITHUB_OUTPUT"])
		appendFileSync(process.env["GITHUB_OUTPUT"], `${name}=${value}\n`)
}

/** Choose the commits a run builds, from the event that started it. */
async function plan() {
	const project = required("DOCS_PROJECT")
	const site = new URL(required("DOCS_URL"))
	const mode = required("DOCS_MODE")
	const pushed = git("rev-parse", "HEAD")
	const live = await readVersions(project, site)
	let wanted = [pushed]
	if (mode === "backfill") {
		// Every commit on main since the docs site existed, and every tag.
		const first = lines(
			git(
				"rev-list",
				"--reverse",
				"HEAD",
				"--",
				"packages/docs/astro.config.ts",
			),
		)[0]
		wanted = [
			...lines(
				git("rev-list", "--reverse", "--first-parent", `${first}^..HEAD`),
			),
			...tagsByCommit().keys(),
		]
	}
	// A tag on a deployed commit needs no build: the list job labels it.
	const { commits, remaining } = planCommits({
		wanted,
		deployed: live.versions.map(({ commit }) => commit),
		pushed: mode === "main" ? pushed : undefined,
	})
	if (remaining)
		console.log(`${remaining} more commits remain; run the backfill again.`)
	output("commits", JSON.stringify(commits))
	output("production", mode === "main" ? pushed : "")
}

/** Add the select to a build and deploy it as its commit's own deployment. */
function commit(directory, hash) {
	const project = required("DOCS_PROJECT")
	for (const file of readdirSync(directory, { recursive: true }))
		if (file.endsWith(".html")) {
			const path = join(directory, file)
			const html = readFileSync(path, "utf8")
			const injected = injectScript(html, project)
			if (injected !== html) writeFileSync(path, injected)
		}
	deploy(directory, commitBranch(hash), hash)
}

/**
 * Publish the list with every deployed commit, and move production to the
 * pushed commit if it is newer than the one there.
 */
async function list(deployedDirectory, productionDirectory) {
	const project = required("DOCS_PROJECT")
	const site = new URL(required("DOCS_URL"))
	const candidate = process.env["DOCS_PRODUCTION"] ?? ""
	const live = await readVersions(project, site)
	// Each successful build leaves an empty file named after its commit.
	const added = existsSync(deployedDirectory)
		? readdirSync(deployedDirectory)
		: []
	let production = live.production
	if (
		candidate &&
		added.includes(candidate) &&
		(!production || isAncestor(production, candidate))
	) {
		deploy(productionDirectory, "main", candidate)
		production = candidate
	}
	const tags = tagsByCommit()
	const versions = updateVersions({
		live,
		added,
		site,
		production,
		details: (hash) => {
			const [date, subject] = git("log", "-1", "--format=%cI%n%s", hash).split(
				"\n",
			)
			return {
				date,
				subject,
				tags: tags.get(hash) ?? [],
				url: commitUrl(hash, project, site),
			}
		},
	})
	const directory = mkdtempSync(join(tmpdir(), "graft-versions-"))
	cpSync(fileURLToPath(new URL("./versions/", import.meta.url)), directory, {
		recursive: true,
	})
	writeFileSync(join(directory, "versions.json"), JSON.stringify(versions))
	deploy(directory, versionsBranch)
}

/** Write the redirect site for the old address into a directory. */
function redirect(directory) {
	const from = new URL(required("DOCS_OLD_URL"))
	const to = new URL(required("DOCS_URL"))
	mkdirSync(directory, { recursive: true })
	for (const file of ["index.html", "404.html"])
		writeFileSync(join(directory, file), redirectPage(from, to))
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const [command, ...args] = process.argv.slice(2)
	const commands = {
		plan: () => plan(),
		commit: () => commit(args[0], args[1]),
		list: () => list(args[0], args[1]),
		redirect: () => redirect(args[0]),
	}
	if (Object.hasOwn(commands, command)) await commands[command]()
	else {
		console.error(
			"Usage: node publish.mjs plan | commit <dist> <hash> | list <deployed> <production dist> | redirect <directory>",
		)
		process.exitCode = 2
	}
}
