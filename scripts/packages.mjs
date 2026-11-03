// Packs every public workspace package with one shared version, and publishes
// the packed files to GitHub Packages or to npm. See the "Releases" page in
// the docs for how CI uses this script.
import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const registries = {
	github: { url: "https://npm.pkg.github.com", snapshots: true },
	npm: { url: "https://registry.npmjs.org", snapshots: false },
}

/** A commit gets an exact snapshot version; a tag like v1.2.3 is a release. */
export function releaseVersion(ref, sha) {
	if (!/^[a-f0-9]{40}$/.test(sha))
		throw new Error("A full commit hash is required")
	if (!ref) return { version: `0.0.0-commit-${sha}`, tag: `sha-${sha}` }
	const match =
		/^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(ref)
	if (!match) throw new Error("Use a version tag such as v0.1.0")
	return { version: match[1], tag: "latest" }
}

/**
 * Whether a release may take the `latest` tag. It never moves back to an
 * older version, such as when a fix for an older line is released, or an old
 * release job runs again.
 */
export function becomesLatest(version, latest) {
	if (!latest) return true
	const parts = (value) => value.split(/[.-]/).slice(0, 3).map(Number)
	const [next, current] = [parts(version), parts(latest)]
	for (let i = 0; i < 3; i++)
		if (next[i] !== current[i]) return next[i] > current[i]
	return true
}

/** Gives the package the release version, and pins its workspace dependencies to it. */
export function releaseManifest(manifest, version, names) {
	const result = { ...manifest, version }
	for (const field of [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		if (!manifest[field]) continue
		result[field] = Object.fromEntries(
			Object.entries(manifest[field]).map(([name, value]) => {
				if (names.has(name)) return [name, version]
				if (value.startsWith("workspace:"))
					throw new Error(`Package is not in the release: ${name}`)
				return [name, value]
			}),
		)
	}
	return result
}

function pack(root, output, ref, sha) {
	const release = releaseVersion(ref, sha)
	const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, "packages", entry.name, "package.json"))
		.map((file) => ({ file, original: readFileSync(file, "utf8") }))
		.map((entry) => ({ ...entry, manifest: JSON.parse(entry.original) }))
		.filter((entry) => !entry.manifest.private)
	const names = new Set(packages.map((entry) => entry.manifest.name))
	mkdirSync(output, { recursive: true })
	try {
		for (const entry of packages) {
			const manifest = releaseManifest(entry.manifest, release.version, names)
			writeFileSync(entry.file, JSON.stringify(manifest, null, "\t") + "\n")
		}
		for (const entry of packages)
			execFileSync(
				"pnpm",
				[
					"--dir",
					resolve(entry.file, ".."),
					"pack",
					"--pack-destination",
					output,
				],
				{ stdio: "inherit" },
			)
		const artifacts = packages.map(({ manifest }) => {
			const file = `${manifest.name.replace("@", "").replace("/", "-")}-${release.version}.tgz`
			const integrity = `sha512-${createHash("sha512")
				.update(readFileSync(join(output, file)))
				.digest("base64")}`
			return { name: manifest.name, file, integrity }
		})
		writeFileSync(
			join(output, "release.json"),
			JSON.stringify({ ...release, sha, artifacts }, null, "\t") + "\n",
		)
	} finally {
		for (const entry of packages) writeFileSync(entry.file, entry.original)
	}
}

function publish(output, name) {
	const registry = registries[name]
	if (!registry) throw new Error("Use github or npm as the registry")
	const release = JSON.parse(readFileSync(join(output, "release.json"), "utf8"))
	if (release.tag !== "latest" && !registry.snapshots) {
		console.log(`Snapshots are not published to ${name}`)
		return
	}
	const host = new URL(registry.url).host
	// npm reads the token from the environment, so it is never written to disk.
	const config = mkdtempSync(join(tmpdir(), "graft-publish-"))
	writeFileSync(
		join(config, "npmrc"),
		`//${host}/:_authToken=\${NODE_AUTH_TOKEN}\n`,
	)
	const env = { ...process.env, NPM_CONFIG_USERCONFIG: join(config, "npmrc") }
	const npm = (args) =>
		execFileSync("npm", [...args, "--registry", registry.url], {
			stdio: "inherit",
			env,
		})
	/** Reads a field of a published package, or `undefined` if it does not exist. */
	const view = (spec, field) => {
		const result = spawnSync(
			"npm",
			["view", spec, field, "--json", "--registry", registry.url],
			{ encoding: "utf8", env },
		)
		if (result.error) throw result.error
		if (result.status === 0)
			return result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout)
		let error
		try {
			error = JSON.parse(result.stdout).error
		} catch {
			throw new Error(result.stderr)
		}
		if (error?.code !== "E404") throw new Error(result.stderr || error?.summary)
		return undefined
	}
	try {
		for (const artifact of release.artifacts) {
			const spec = `${artifact.name}@${release.version}`
			// An older release goes under `backport`, so `latest` stays on the newest one.
			const tag =
				release.tag !== "latest" ||
				becomesLatest(release.version, view(artifact.name, "dist-tags.latest"))
					? release.tag
					: "backport"
			const integrity = view(spec, "dist.integrity")
			if (integrity === undefined)
				npm([
					"publish",
					join(output, artifact.file),
					"--ignore-scripts",
					"--tag",
					tag,
					...(name === "npm" ? ["--access", "public", "--provenance"] : []),
				])
			else if (integrity !== artifact.integrity)
				throw new Error(`Package already has other contents: ${spec}`)
			// Set the tag on a retry too, if a prior run stopped after upload.
			npm(["dist-tag", "add", spec, tag])
		}
	} finally {
		rmSync(config, { recursive: true, force: true })
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [command, registry, directory] = process.argv.slice(2)
	if (command === "pack")
		pack(
			process.cwd(),
			resolve(registry ?? ".release"),
			process.env.RELEASE_REF ?? "",
			process.env.RELEASE_SHA ??
				execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		)
	else if (command === "publish")
		publish(resolve(directory ?? ".release"), registry)
	else
		throw new Error("Use pack [directory] or publish <github|npm> [directory]")
}
