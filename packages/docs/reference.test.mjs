import { strict as assert } from "node:assert"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { Application, ReflectionKind } from "typedoc"

import { publicEntries } from "../../scripts/public-api.mjs"

// Exercise real Effect Schema classes and overloaded APIs, where flattening or
// filtering reflections can silently lose fields or leave stale navigation.
test("preserves core exports, re-exports, overloads, and local Schema fields", async (t) => {
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
	assert.equal(project.children.length, entries.length)
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
		"Change",
		"Event",
		"Fork",
		"Graft",
		"Kernel",
		"Manifest",
		"Plugin",
		"Release",
		"Transition",
		"Trust",
	])
	assert.ok(
		index.children.every((child) => child.kindOf(ReflectionKind.Reference)),
	)
	await t.test(
		"preserves Change requests, handles, current status, and rejection reference fields",
		() => {
			const change = project.children.find((entry) => entry.name === "Change")
			assert.ok(change)
			for (const name of [
				"submit",
				"run",
				"get",
				"changes",
				"Outcome",
				"Conclusion",
				"Target",
			])
				assert.ok(
					change.children.some((child) => child.name === name),
					`Change.${name}`,
				)
			const fields = (name, expected) => {
				const reference = change.children.find((child) => child.name === name)
				const declaration = reference?.kindOf(ReflectionKind.Reference)
					? reference.getTargetReflection()
					: reference
				assert.ok(declaration, `Change.${name}`)
				for (const field of expected)
					assert.ok(
						declaration.children.some((child) => child.name === field),
						`Change.${name}.${field}`,
					)
				return declaration
			}
			const request = fields("Request", [
				"operations",
				"realms",
				"key",
				"strategy",
				"budget",
				"requirements",
			])
			assert.ok(
				request.children.find((child) => child.name === "key").flags.isOptional,
			)
			fields("Handle", ["id", "await", "cancel"])
			fields("Status", [
				"id",
				"sequence",
				"members",
				"plan",
				"remaining",
				"leaseHolders",
				"unconfirmedUnits",
				"conclusion",
			])
			const rejected = fields("ChangeRejected", [
				"constructor",
				"_tag",
				"reason",
				"conflicts",
			])
			assert.ok(rejected.kindOf(ReflectionKind.Class))
		},
	)
})
