import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { packageManifests } from "./workspace.mjs"

/** Read only the requested Changesets version, retaining multiline list entries. */
export function changelogEntries(markdown, version) {
	const entries = []
	let active = false
	let found = false
	let category
	let lines = []
	const finish = () => {
		if (lines.length > 0) {
			entries.push({ category, text: lines.join("\n").trimEnd() })
			lines = []
		}
	}
	for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
		if (/^#{1,2} /.test(line)) {
			if (active) break
			active = line === `## ${version}`
			found ||= active
			continue
		}
		if (!active) continue
		const heading = /^### (Major|Minor|Patch) Changes$/.exec(line)
		if (heading) {
			finish()
			category = heading[1]
		} else if (/^[-*] /.test(line)) {
			finish()
			if (!category) throw new Error(`Missing change category in ${version}`)
			lines.push(`- ${line.slice(2)}`)
		} else if (lines.length > 0) {
			lines.push(line)
		} else if (line.trim() !== "") {
			throw new Error(`Unexpected changelog content in ${version}: ${line}`)
		}
	}
	finish()
	if (!found) throw new Error(`Missing changelog section for ${version}`)
	if (entries.length === 0)
		throw new Error(`Empty changelog section for ${version}`)
	return entries
}

/** Combine the public packages' changelogs; identical entries appear only once. */
export function releaseNotes(root, version) {
	const packages = packageManifests(root)
		.map((file) => ({
			file,
			manifest: JSON.parse(readFileSync(file, "utf8")),
		}))
		.filter(({ manifest }) => !manifest.private)
		.sort((left, right) =>
			left.manifest.name.localeCompare(right.manifest.name),
		)
	if (packages.length === 0) throw new Error("No public packages found")
	const changes = []
	for (const { file, manifest } of packages) {
		if (manifest.version !== version)
			throw new Error(
				`${manifest.name} has version ${manifest.version}, expected ${version}`,
			)
		const changelog = join(dirname(file), "CHANGELOG.md")
		for (const entry of changelogEntries(
			readFileSync(changelog, "utf8"),
			version,
		)) {
			const existing = changes.find(
				(change) =>
					change.category === entry.category && change.text === entry.text,
			)
			if (existing) {
				if (!existing.packages.includes(manifest.name))
					existing.packages.push(manifest.name)
			} else changes.push({ ...entry, packages: [manifest.name] })
		}
	}
	const notes = [
		`## Packages`,
		"",
		...packages.map(({ manifest }) => `- \`${manifest.name}@${version}\``),
	]
	for (const category of ["Major", "Minor", "Patch"]) {
		const entries = changes.filter((entry) => entry.category === category)
		if (entries.length === 0) continue
		notes.push("", `## ${category} Changes`)
		for (const entry of entries)
			notes.push(
				"",
				entry.text,
				"",
				`  Packages: ${entry.packages.map((name) => `\`${name}\``).join(", ")}.`,
			)
	}
	return notes.join("\n") + "\n"
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [version, root = process.cwd()] = process.argv.slice(2)
	if (!version)
		throw new Error("Use release-notes.mjs <version> [workspace root]")
	process.stdout.write(releaseNotes(resolve(root), version))
}
