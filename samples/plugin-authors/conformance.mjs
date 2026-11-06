import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { Cause, Effect, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { NodeServices } from "@effect/platform-node"

import { Manifest } from "@graftland/graft"
import { Artifact, Conformance, Publication } from "@graftland/plugin-remote"

const platform = Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto)
const packages = [
	"@alice/conformance-echo",
	"@bob/conformance-counter",
	"@graftland/conformance-echo",
]
const host = {
	node: process.versions.node,
	effect: "4.1.2",
	graft: "0.0.0",
	placement: "Worker",
	filesystem: true,
	nativeModules: true,
	services: [],
	operations: [],
}
const installed = packages.map((name) => {
	const file = fileURLToPath(import.meta.resolve(`${name}/package.json`))
	return {
		id: name,
		entry: ".",
		directory: realpathSync(join(file, "..")),
		package: JSON.parse(readFileSync(file, "utf8")),
	}
})
test("all authors pass the same metadata-only compatibility check", () => {
	assert.deepEqual(Manifest.check(host, installed), [])
	writeFileSync(
		"graft.check.json",
		JSON.stringify({
			host,
			entries: installed.map(({ id, entry, directory }) => ({
				id,
				entry,
				directory,
			})),
			catalog: [],
		}),
	)
	const result = execFileSync(
		"pnpm",
		["exec", "graft", "--no-plugins", "check"],
		{ encoding: "utf8" },
	)
	assert.match(result, /Compatible/)
})
test("manifest verification rejects drift without rewriting the published package", async () => {
	const entry = installed[0]
	const file = join(entry.directory, "package.json")
	const original = readFileSync(file, "utf8")
	const changed = JSON.parse(original)
	changed.graft.entries["."].services.implements = []
	const text = JSON.stringify(changed)
	writeFileSync(file, text)
	try {
		const failure = await Effect.runPromise(
			Conformance.agreement(entry.directory).pipe(
				Effect.flip,
				Effect.provide(platform),
			),
		)
		assert.match(
			Cause.pretty(Cause.fail(failure)),
			/Manifest\/code disagreement/,
		)
		assert.equal(readFileSync(file, "utf8"), text)
	} finally {
		writeFileSync(file, original)
	}
})
for (const changedModule of ["entry", "dependency"]) {
	test(`repeated publication reloads changed ${changedModule} declarations`, async () => {
		const entry = installed[0]
		const file = join(entry.directory, "dist/index.js")
		const dependency = join(entry.directory, "dist/publication-dependency.js")
		const original = readFileSync(file, "utf8")
		const changed = `import { Context, Effect } from "effect"
import { Plugin } from "@graftland/graft"
const Missing = Context.Service("missing")
export default Plugin.make({ name: "changed", inject: [Missing], apply: () => Effect.void })
`
		try {
			if (changedModule === "dependency") {
				writeFileSync(dependency, original)
				writeFileSync(
					file,
					'export { default } from "./publication-dependency.js"\n',
				)
			}
			const baseline = await Effect.runPromise(
				Publication.generate(entry.directory).pipe(Effect.provide(platform)),
			)
			assert.deepEqual(baseline.graft, entry.package.graft)
			writeFileSync(changedModule === "entry" ? file : dependency, changed)
			for (const inspect of [Publication.generate, Publication.verify]) {
				const failure = await Effect.runPromise(
					inspect(entry.directory).pipe(Effect.flip, Effect.provide(platform)),
				)
				assert.match(
					Cause.pretty(Cause.fail(failure)),
					/Service missing needs exactly one contract declaration/,
				)
			}
			writeFileSync(changedModule === "entry" ? file : dependency, original)
			const restored = await Effect.runPromise(
				Publication.verify(entry.directory).pipe(Effect.provide(platform)),
			)
			assert.deepEqual(restored.graft, entry.package.graft)
		} finally {
			writeFileSync(file, original)
			if (changedModule === "dependency") unlinkSync(dependency)
		}
	})
}
test("changed contract package bytes produce a provenance conflict and fail manifest agreement", async () => {
	const entry = installed[0]
	const file = fileURLToPath(import.meta.resolve(`${entry.id}-contract`))
	const original = readFileSync(file, "utf8")
	writeFileSync(
		file,
		original +
			"\n// Changed package bytes without changing the operation declarations.\n",
	)
	try {
		const generated = await Effect.runPromise(
			Publication.generate(entry.directory).pipe(Effect.provide(platform)),
		)
		const before = entry.package.graft.entries["."].operations[0]
		const after = generated.graft.entries["."].operations[0]
		assert.deepEqual(after.package, before.package)
		assert.notEqual(after.artifact.digest, before.artifact.digest)
		const diagnostics = Manifest.check(host, [
			entry,
			{ ...entry, id: "changed", package: generated },
		])
		assert.equal(diagnostics[0].code, "ProvenanceConflict")
		assert.match(
			diagnostics[0].message,
			/@alice\/conformance-echo-contract@1\.0\.0/,
		)
		assert(diagnostics[0].message.includes(before.artifact.digest))
		assert(diagnostics[0].message.includes(after.artifact.digest))
		const failure = await Effect.runPromise(
			Conformance.agreement(entry.directory).pipe(
				Effect.flip,
				Effect.provide(platform),
			),
		)
		assert.match(failure.message, /Manifest\/code disagreement/)
	} finally {
		writeFileSync(file, original)
	}
})
test("manifest generation rejects a self-referential package digest without rewriting metadata", async () => {
	const entry = installed[0]
	const file = join(entry.directory, "package.json")
	const original = readFileSync(file, "utf8")
	const changed = JSON.parse(original)
	changed.graft.entries["."].contracts = [entry.id]
	const text = JSON.stringify(changed)
	writeFileSync(file, text)
	try {
		const failure = await Effect.runPromise(
			Publication.write(entry.directory).pipe(
				Effect.flip,
				Effect.provide(platform),
			),
		)
		assert.match(failure.message, /Publish contracts in a separate package/)
		assert.equal(readFileSync(file, "utf8"), text)
	} finally {
		writeFileSync(file, original)
	}
})
test("an incompatible plugin names the missing operation, entry and provider", () => {
	const provider = installed[0]
	const operation =
		provider.package.graft.entries["."].services.implements[0].operations[0]
	const file = fileURLToPath(
		import.meta.resolve("@incompatible/plugin/package.json"),
	)
	const incompatible = {
		id: "incompatible",
		entry: ".",
		package: JSON.parse(readFileSync(file, "utf8")),
	}

	const diagnostics = Manifest.check(host, [incompatible], [provider])
	assert.equal(diagnostics[0].code, "MissingOperation")
	assert.equal(diagnostics[0].entry, "incompatible")
	assert.match(diagnostics[0].message, /@alice\/conformance-echo\/Execute@1/)
	assert.deepEqual(diagnostics[0].providers, [provider.package.name])
	assert(
		diagnostics.some(
			(item) => item.code === "Runtime" && item.message.includes("99.0.0"),
		),
	)
	writeFileSync(
		"incompatible.check.json",
		JSON.stringify({
			host,
			entries: [
				{
					id: "incompatible",
					entry: ".",
					directory: realpathSync(join(file, "..")),
				},
			],
			catalog: [
				{
					id: provider.id,
					entry: provider.entry,
					directory: provider.directory,
				},
			],
		}),
	)
	assert.throws(
		() =>
			execFileSync(
				"pnpm",
				["exec", "graft", "--no-plugins", "check", "incompatible.check.json"],
				{ stdio: "pipe" },
			),
		(cause) => {
			assert.match(
				cause.stderr.toString() + cause.stdout.toString(),
				/MissingOperation.*incompatible/,
			)
			return true
		},
	)
})
for (const entry of installed) {
	for (const placement of ["Worker", "Local"]) {
		test(`${entry.id}: public conformance on ${placement}`, async () => {
			const { contract, Rejected } = await import(`${entry.id}-contract`)
			const operation =
				entry.package.graft.entries["."].services.implements[0].operations[0]
			const isCounter = entry.id.includes("counter")
			const input = (mode) =>
				isCounter ? { mode, value: 4 } : { mode, text: "hello" }
			const author = entry.id.startsWith("@alice")
				? "alice"
				: isCounter
					? "bob"
					: "first-party"
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* Conformance.agreement(entry.directory)
					const artifact = yield* Artifact.capture({
						directory: entry.directory,
						entry: "dist/index.js",
						store: join(process.cwd(), "artifacts"),
					})
					const provenance = yield* Publication.provenance(
						artifact.directory,
						".",
					)
					assert.equal(provenance.artifact.digest, artifact.identity.digest)
					assert.equal(provenance.package.name, entry.id)
					assert.equal(
						provenance.operations[0].package.name,
						`${entry.id}-contract`,
					)
					const contractDirectory = realpathSync(
						join(
							fileURLToPath(
								import.meta.resolve(`${entry.id}-contract/package.json`),
							),
							"..",
						),
					)
					const contractArtifact =
						yield* Artifact.directoryIdentity(contractDirectory)
					assert.deepEqual(provenance.operations[0].artifact, contractArtifact)
					assert.deepEqual(Object.keys(provenance.operations[0]).sort(), [
						"artifact",
						"identity",
						"package",
					])
					assert.deepEqual(
						Manifest.check(host, [entry, { ...entry, id: "second-instance" }]),
						[],
					)
					const session = yield* Conformance.direct(contract, {
						artifact,
						contractModule: import.meta.resolve(`${entry.id}-contract`),
						target: { _tag: placement },
						input: {},
					})
					yield* Conformance.run(session, {
						entry: entry.package.graft.entries["."],
						examples: [
							{
								operation,
								payload: input("ok"),
								expected: {
									_tag: "Success",
									value: isCounter ? "Count: 4" : "Echo: hello",
								},
							},
							{
								operation,
								payload: input("reject"),
								expected: {
									_tag: "BusinessError",
									value: Rejected.make({ message: `Rejected by ${author}` }),
								},
							},
							{
								operation,
								payload: input("defect"),
								expected: { _tag: "Defect" },
							},
						],
						cancellation: {
							request: { operation, payload: input("wait") },
							started: { operation, payload: input("started") },
							released: { operation, payload: input("released") },
						},
					})
				}).pipe(
					Effect.scoped,
					Effect.provide(platform),
					Effect.tapCause(Effect.logError),
				),
			)
		})
	}
}
