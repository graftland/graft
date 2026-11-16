import { strict as assert } from "node:assert"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { Application, LogLevel, ReflectionKind } from "typedoc"

import { publicEntries } from "../../scripts/public-api.mjs"

// Exercise real Effect Schema classes and re-exported namespaces, where
// flattening or filtering reflections can silently lose fields or leave stale
// navigation.
test("preserves package entries, re-exports, dual exports, and local Schema fields", async () => {
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
		// Every type a public signature mentions must be exported and documented.
		validation: {
			notExported: true,
			invalidLink: true,
			rewrittenLink: true,
		},
		excludeInternal: true,
	})
	const project = await app.convert()
	// Run the same validation the docs build records, so a public signature
	// that mentions a type no entry exports fails here too.
	const warnings = []
	const log = app.logger.log
	app.logger.log = (message, level) => {
		if (level >= LogLevel.Warn) warnings.push(String(message))
		log.call(app.logger, message, level)
	}
	try {
		app.validate(project)
	} finally {
		app.logger.log = log
	}
	assert.deepEqual(warnings, [])
	// The package exports the root, rpc, node and testing entries, and nothing else.
	assert.equal(entries.length, 4)
	assert.equal(project.children.length, entries.length)
	assert.deepEqual(project.children.map((entry) => entry.name).sort(), [
		"index",
		"node",
		"rpc",
		"testing",
	])
	const index = project.children.find((entry) => entry.name === "index")
	const release = index.children.find((entry) => entry.name === "Release")
	assert.deepEqual(release.children.map((child) => child.name).sort(), [
		"ReleaseInterrupted",
		"close",
		"scoped",
	])
	const graft = index.children.find((entry) => entry.name === "Graft")
	// A public API without overloads still has one signature per function; two
	// would mean a reflection was duplicated rather than merged.
	assert.equal(
		graft.children.find((child) => child.name === "mount").signatures.length,
		1,
	)
	// `await` is the reserved-word alias of `await_`, so the API keeps both views.
	const reserved = graft.children.find((child) => child.name === "await")
	assert.ok(reserved.kindOf(ReflectionKind.Reference))
	assert.ok(graft.children.some((child) => child.name === "await_"))
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
		"mount",
		"message",
	])
		assert.ok(
			conflict.children.some((child) => child.name === name),
			name,
		)
	assert.ok(
		!conflict.children.some((child) => child.name === "fork"),
		"a mount is named mount, not fork",
	)
	assert.ok(
		conflict.children.find((child) => child.name === "reason").hasComment(),
	)
	assert.ok(
		!conflict.groups.some((group) =>
			group.children.some((child) => child.name === "pipe"),
		),
	)
	assert.deepEqual(index.children.map((child) => child.name).sort(), [
		"Graft",
		"Mount",
		"Release",
	])
	// TypeDoc expands `export * as Graft` into a namespace when the module is not
	// a separate entry point; the export is still the same module, and the names
	// are the contract this test protects.
	assert.ok(
		index.children.every((child) => child.kindOf(ReflectionKind.Namespace)),
	)
	const entry = (name) => project.children.find((child) => child.name === name)
	const remote = entry("rpc").children.find((child) => child.name === "Remote")
	for (const name of ["connect", "serve", "service", "RemoteUnavailable"])
		assert.ok(
			remote.children.some((child) => child.name === name),
			`rpc.Remote.${name}`,
		)
	for (const name of [
		"SubprocessOptions",
		"WorkerOptions",
		"layerProtocolStdio",
		"layerProtocolWorker",
		"subprocessProtocol",
		"workerProtocol",
	])
		assert.ok(
			entry("node").children.some((child) => child.name === name),
			`node.${name}`,
		)
	for (const name of ["InMemoryProtocol", "make"])
		assert.ok(
			entry("testing").children.some((child) => child.name === name),
			`testing.${name}`,
		)
})
