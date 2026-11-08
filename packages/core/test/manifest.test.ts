import { Array, Context, Effect, Schema, String } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Manifest, Plugin } from "../src/index"
import { reach, run } from "./utils"

const operation: Manifest.Operation = {
	identity: "@example/read@1",
	package: { name: "@example/contract", version: "1.0.0" },
	artifact: { version: 1, algorithm: "sha256", digest: String.repeat(64)("a") },
}
const service: Manifest.Service = {
	key: "example/Reader",
	operations: [operation.identity],
}
const host: Manifest.HostProfile = {
	node: "22.22.0",
	effect: "4.1.2",
	graft: "0.0.0",
	placement: "Worker",
	filesystem: false,
	nativeModules: false,
	services: [],
	operations: [],
}
const entry: Manifest.EntryMetadata = {
	implementation: "dist/index.js",
	contracts: ["@example/contract"],
	requirements: {
		placements: ["Worker", "Local"],
		filesystem: false,
		nativeModules: false,
	},
	probes: [],
	services: { required: [], optional: [], implements: [service] },
	operations: [operation],
}
const pkg: Manifest.Package = {
	name: "@example/provider",
	version: "1.0.0",
	engines: { node: ">=22.19.0" },
	peerDependencies: { effect: "4.1.*", "@graftland/graft": "0.0.0" },
	graft: { version: 1, entries: { ".": entry } },
}
const selection = (id: string, manifest = entry): Manifest.Selection => ({
	id,
	entry: ".",
	package: { ...pkg, graft: { version: 1, entries: { ".": manifest } } },
})

it("accepts exact operation inclusion from host and other entries", () => {
	const consumer = selection("consumer", {
		...entry,
		services: { required: [service], optional: [], implements: [] },
	})
	assert.deepEqual(Manifest.check(host, [consumer, selection("provider")]), [])
	assert.deepEqual(
		Manifest.check({ ...host, services: [service], operations: [operation] }, [
			consumer,
		]),
		[],
	)
})
it("reports the needing entry and candidate provider without enabling the catalog", () => {
	const consumer = selection("consumer", {
		...entry,
		services: { required: [service], optional: [], implements: [] },
	})
	const result = Manifest.check(host, [consumer], [selection("provider")])
	assert.equal(result[0]?.code, "MissingOperation")
	assert.equal(result[0]?.entry, "consumer")
	assert.deepEqual(result[0]?.providers, [pkg.name])
	assert.include(result[0]!.message, operation.identity)
})
it("does not satisfy an entry's injected requirement with its own provision", () => {
	const result = Manifest.check(host, [
		selection("self", {
			...entry,
			services: { ...entry.services, required: [service] },
		}),
	])
	assert.equal(result[0]?.code, "MissingOperation")
})
it("does not require optional operations and does not substitute another operation version", () => {
	assert.deepEqual(
		Manifest.check(host, [
			selection("optional", {
				...entry,
				services: {
					required: [],
					optional: [service],
					implements: [],
				},
			}),
		]),
		[],
	)
	const changed = { ...operation, identity: "@example/read@2" }
	const missing = Manifest.check({ ...host, operations: [changed] }, [
		selection("required", {
			...entry,
			services: {
				required: [service],
				optional: [],
				implements: [],
			},
		}),
	])
	assert.equal(missing[0]?.code, "MissingOperation")
})
it("reports both sources when another package claims the same operation even at the same digest", () => {
	const other = {
		...operation,
		package: { name: "other-contract", version: "2.0.0" },
	}
	const diagnostics = Manifest.check({ ...host, operations: [other] }, [
		selection("provider"),
	])
	assert.equal(diagnostics[0]?.code, "ProvenanceConflict")
	assert.include(diagnostics[0]!.message, "other-contract@2.0.0")
	assert.include(diagnostics[0]!.message, "@example/contract@1.0.0")
	assert.include(diagnostics[0]!.message, operation.artifact.digest)
})
it("reports differing digests of the same package across entries and within one entry", () => {
	const changed: Manifest.Operation = {
		...operation,
		artifact: { ...operation.artifact, digest: String.repeat(64)("b") },
	}
	for (const diagnostics of [
		Manifest.check({ ...host, operations: [changed] }, [selection("provider")]),
		Manifest.check(host, [
			selection("provider", { ...entry, operations: [operation, changed] }),
		]),
	]) {
		assert.equal(diagnostics[0]?.code, "ProvenanceConflict")
		assert.include(diagnostics[0]!.message, operation.artifact.digest)
		assert.include(diagnostics[0]!.message, changed.artifact.digest)
	}
})
it("never conflicts for one contract package at one digest", () => {
	assert.deepEqual(
		Manifest.check({ ...host, services: [service], operations: [operation] }, [
			selection("first", { ...entry, operations: [operation, operation] }),
			selection("second"),
		]),
		[],
	)
	assert.deepEqual(
		Manifest.conflicts([
			{ id: "first", operations: [operation] },
			{
				id: "second",
				operations: [
					{ ...operation, package: { ...operation.package, version: "2.0.0" } },
				],
			},
		]),
		[],
	)
})
it("checks all runtime ranges and placement requirements with actionable diagnostics", () => {
	const result = Manifest.check(
		{
			...host,
			node: "20.0.0",
			effect: "4.2.0",
			graft: "1.0.0",
			placement: "Host",
		},
		[
			selection("native", {
				...entry,
				requirements: {
					placements: ["Local"],
					filesystem: true,
					nativeModules: true,
				},
			}),
		],
	)
	assert.deepEqual(
		Array.map(result, (item) => item.code),
		["Runtime", "Runtime", "Runtime", "Placement", "Placement", "Placement"],
	)
	assert.isTrue(Array.every(result, (item) => item.entry === "native"))
})
it("rejects invalid ranges, missing entry points and missing operation provenance", () => {
	assert.equal(
		Manifest.check({ ...host, node: "invalid" }, [selection("provider")])[0]
			?.code,
		"Runtime",
	)
	assert.equal(
		Manifest.check(host, [{ ...selection("provider"), entry: "./absent" }])[0]
			?.code,
		"MissingEntry",
	)
	assert.equal(
		Manifest.check(host, [
			selection("provider", { ...entry, operations: [] }),
		])[0]?.code,
		"InvalidManifest",
	)
})
class Required extends Context.Service<Required, {}>()(
	"@graftland/graft/test/manifest.test/Required",
) {}
class Optional extends Context.Service<Optional, {}>()(
	"@graftland/graft/test/manifest.test/Optional",
) {}
class Provided extends Context.Service<Provided, {}>()(
	"@graftland/graft/test/manifest.test/Provided",
) {}
const declaration = (
	key: Context.Key<unknown, unknown>,
	name: string,
): Manifest.Declaration => ({
	service: { key, operations: [{ name, version: 1 }] },
	operations: [{ ...operation, identity: name + "@1" }],
})
it.effect(
	"derives all three service sets from inject and provides without running apply",
	() =>
		Effect.gen(function* () {
			const provided = declaration(Provided, "provided")
			const plugin = Plugin.make({
				name: "author",
				inject: [Required, Plugin.optional(Optional)],
				provides: [provided.service],
				apply: () => Effect.die("Apply must not run"),
			})
			const result = yield* Manifest.derive(plugin, [
				declaration(Required, "required"),
				declaration(Optional, "optional"),
				provided,
			])
			assert.deepEqual(result.services, {
				required: [{ key: Required.key, operations: ["required@1"] }],
				optional: [{ key: Optional.key, operations: ["optional@1"] }],
				implements: [{ key: Provided.key, operations: ["provided@1"] }],
			})
		}),
)
it.effect(
	"rejects an undeclared ordinary service instead of silently omitting it",
	() =>
		Effect.gen(function* () {
			const plugin = Plugin.make({
				name: "author",
				inject: [Required],
				apply: () => Effect.void,
			})
			const failure = yield* Effect.flip(Manifest.derive(plugin, []))
			assert.include(failure.message, Required.key)
		}),
)

it.effect(
	"does not confuse different service keys with identical operations and provenance",
	() =>
		Effect.gen(function* () {
			const required = declaration(Required, "read")
			const provided = declaration(Provided, "read")
			const consumer = Plugin.make({
				name: "consumer",
				inject: [Required],
				apply: () => Effect.void,
			})
			const provider = Plugin.make({
				name: "provider",
				provides: [provided.service],
				apply: () => Graft.provide(Provided, {}),
			})
			const consumerMetadata = yield* Manifest.derive(consumer, [required])
			const providerMetadata = yield* Manifest.derive(provider, [provided])
			const consumerEntry = selection("consumer", {
				...entry,
				...consumerMetadata,
			})
			const providerEntry = selection("provider", {
				...entry,
				...providerMetadata,
			})
			const diagnostics = Manifest.check(
				host,
				[consumerEntry, providerEntry],
				[providerEntry],
			)
			assert.equal(diagnostics[0]?.code, "MissingOperation")
			assert.include(diagnostics[0]!.message, Required.key)
			assert.include(diagnostics[0]!.message, "read@1")
			assert.deepEqual(diagnostics[0]!.providers, [])
			assert.equal(
				Manifest.check(
					{
						...host,
						services: providerMetadata.services.implements,
						operations: providerMetadata.operations,
					},
					[consumerEntry],
				)[0]?.code,
				"MissingOperation",
			)
			const providerFork = yield* Graft.plugin(provider)
			yield* providerFork.await
			const consumerFork = yield* Graft.plugin(consumer)
			yield* reach(consumerFork, "Pending")
			const matching = Plugin.make({
				name: "matching",
				provides: [required.service],
				apply: () => Graft.provide(Required, {}),
			})
			const metadata = yield* Manifest.derive(matching, [required])
			assert.deepEqual(
				Manifest.check(host, [
					consumerEntry,
					selection("matching", { ...entry, ...metadata }),
				]),
				[],
			)
			const matchingFork = yield* Graft.plugin(matching)
			yield* matchingFork.await
			yield* consumerFork.await
		}).pipe(run),
)

it("does not assemble one required service from partial providers", () => {
	const write = { ...operation, identity: "write@1" }
	const required = {
		...service,
		operations: [operation.identity, write.identity],
	}
	const consumer = selection("consumer", {
		...entry,
		operations: [operation, write],
		services: { required: [required], optional: [], implements: [] },
	})
	const partial = selection("partial", {
		...entry,
		operations: [write],
		services: {
			required: [],
			optional: [],
			implements: [{ ...service, operations: [write.identity] }],
		},
	})
	assert.equal(
		Manifest.check(host, [consumer, selection("provider"), partial])[0]?.code,
		"MissingOperation",
	)
})

it.effect(
	"compares provenance operation sets without delimiter collisions",
	() =>
		Effect.gen(function* () {
			const combined = declaration(Provided, "read@1,write")
			const plugin = Plugin.make({
				name: "collision",
				provides: [combined.service],
				apply: () => Effect.void,
			})
			const failure = yield* Effect.flip(
				Manifest.derive(plugin, [
					{
						...combined,
						operations: [
							{ ...operation, identity: "read@1" },
							{ ...operation, identity: "write@1" },
						],
					},
				]),
			)
			assert.include(failure.message, "Operation provenance disagrees")
		}),
)

it.effect(
	"compares implementation operation sets without delimiter collisions",
	() =>
		Effect.gen(function* () {
			const combined = declaration(Provided, "read@1,write")
			const separate: Manifest.Declaration = {
				service: {
					key: Provided,
					operations: [
						{ name: "read", version: 1 },
						{ name: "write", version: 1 },
					],
				},
				operations: [
					{ ...operation, identity: "read@1" },
					{ ...operation, identity: "write@1" },
				],
			}
			const plugin = Plugin.make({
				name: "collision",
				provides: [combined.service],
				apply: () => Effect.void,
			})
			const failure = yield* Effect.flip(Manifest.derive(plugin, [separate]))
			assert.include(failure.message, "Provided operations disagree")
		}),
)

it.effect(
	"treats inherited entry names as missing in selected entries and catalog suggestions",
	() =>
		Effect.gen(function* () {
			const decoded = yield* Schema.decodeEffect(Manifest.Package)(pkg)
			const consumer = selection("consumer", {
				...entry,
				services: { required: [service], optional: [], implements: [] },
			})
			for (const name of ["constructor", "toString", "__proto__"]) {
				const absent = { id: "absent", package: decoded, entry: name }
				const diagnostics = Manifest.check(host, [absent])
				assert.equal(diagnostics[0]?.code, "MissingEntry")
				const missing = Manifest.check(host, [consumer], [absent])
				assert.equal(missing[0]?.code, "MissingOperation")
				assert.deepEqual(missing[0]?.providers, [])
			}
		}),
)

it.effect(
	"rejects host bindings without package provenance even when they satisfy a consumer",
	() =>
		Effect.gen(function* () {
			const incomplete = yield* Schema.decodeEffect(Manifest.HostProfile)({
				...host,
				services: [service],
				operations: [],
			})
			const consumer = selection("consumer", {
				...entry,
				services: { required: [service], optional: [], implements: [] },
			})
			for (const selected of [[], [consumer]]) {
				const diagnostics = Manifest.check(incomplete, selected)
				assert.equal(diagnostics.length, 1)
				assert.equal(diagnostics[0]?.code, "InvalidManifest")
				assert.equal(diagnostics[0]?.entry, "host")
				assert.include(diagnostics[0]!.message, service.key)
				assert.include(diagnostics[0]!.message, operation.identity)
				assert.include(diagnostics[0]!.message, "host.operations")
				assert.include(
					diagnostics[0]!.message,
					"package name, version and Artifact directory digest",
				)
			}
		}),
)
it("accepts complete matching host provenance", () => {
	const consumer = selection("consumer", {
		...entry,
		services: { required: [service], optional: [], implements: [] },
	})
	assert.deepEqual(
		Manifest.check({ ...host, services: [service], operations: [operation] }, [
			consumer,
		]),
		[],
	)
})
it("rejects conflicting host provenance and names both package sources", () => {
	const consumer = selection("consumer", {
		...entry,
		services: { required: [service], optional: [], implements: [] },
	})
	const changed = {
		...operation,
		artifact: { ...operation.artifact, digest: String.repeat(64)("b") },
	}
	const diagnostics = Manifest.check(
		{ ...host, services: [service], operations: [changed] },
		[consumer],
	)
	assert.equal(diagnostics[0]?.code, "ProvenanceConflict")
	assert.include(diagnostics[0]!.message, "host:")
	assert.include(diagnostics[0]!.message, "consumer:")
	assert.include(diagnostics[0]!.message, changed.artifact.digest)
	assert.include(diagnostics[0]!.message, operation.artifact.digest)
})
