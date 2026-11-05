import { strict as assert } from "node:assert"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { Application, ReflectionKind } from "typedoc"

import { publicEntries } from "../../scripts/public-api.mjs"

// Exercise real Effect Schema classes and overloaded APIs, where flattening or
// filtering reflections can silently lose fields or leave stale navigation.
test("preserves core exports, re-exports, overloads, and local Schema fields", async () => {
	const root = fileURLToPath(new URL("../../", import.meta.url))
	const entries = publicEntries(root).filter(
		(entry) => entry.packageName === "@graftland/graft",
	)
	const app = await Application.bootstrapWithPlugins({
		name: "@graftland/graft",
		entryPoints: entries.map((entry) =>
			fileURLToPath(
				new URL(entry.source, new URL("../core/", import.meta.url)),
			),
		),
		basePath: fileURLToPath(new URL("../core/src/", import.meta.url)),
		tsconfig: fileURLToPath(
			new URL("./tsconfig.reference.json", import.meta.url),
		),
		plugin: [fileURLToPath(new URL("./typedoc-plugin.mjs", import.meta.url))],
		alwaysCreateEntryPointModule: true,
		excludeInternal: true,
	})
	const project = await app.convert()
	assert.equal(project.children.length, 6)
	const release = project.children.find((entry) => entry.name === "Release")
	assert.deepEqual(release.children.map((child) => child.name).sort(), [
		"ReleaseInterrupted",
		"close",
		"scoped",
	])
	const plugin = project.children.find((entry) => entry.name === "Plugin")
	const make = plugin.children.find((child) => child.name === "make")
	assert.equal(make.type.declaration.signatures.length, 2)
	const conflict = Object.values(project.reflections).find(
		(reflection) =>
			reflection.name === "ServiceConflict" &&
			reflection.kindOf(ReflectionKind.Class),
	)
	for (const name of [
		"constructor",
		"_tag",
		"service",
		"reason",
		"realm",
		"fork",
		"message",
	])
		assert.ok(
			conflict.children.some((child) => child.name === name),
			name,
		)
	assert.ok(
		conflict.children.find((child) => child.name === "reason").hasComment(),
	)
	assert.ok(
		!conflict.groups.some((group) =>
			group.children.some((child) => child.name === "pipe"),
		),
	)
	const index = project.children.find((entry) => entry.name === "index")
	assert.deepEqual(index.children.map((child) => child.name).sort(), [
		"Event",
		"Fork",
		"Graft",
		"Plugin",
		"Release",
	])
	assert.ok(
		index.children.every((child) => child.kindOf(ReflectionKind.Reference)),
	)
})
