import {
	Array,
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Path,
	Ref,
	Schema,
	String,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import { Artifact } from "@graftland/plugin-remote"
import * as Policy from "@graftland/plugin-remote/Policy"

import { validate } from "../src/internal/journal"
import { make } from "../src/internal/service"
import {
	build,
	durable,
	load,
	read,
	references,
	resolveInput,
	write,
} from "../src/internal/storage"
import { Journal, type Release } from "../src/Model"

const runtime = Graft.layer.pipe(Layer.provideMerge(NodeServices.layer))
const host = {
	node: "22.22.0",
	effect: "4.1.2",
	graft: "0.0.0",
	placement: "Worker" as const,
	filesystem: true,
	nativeModules: true,
	services: [],
	operations: [],
}
const release: Release = {
	version: 1,
	entries: [],
	references: [],
	revocations: [],
}
const setup = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const store = yield* fs.makeTempDirectoryScoped()
	const stage = path.join(store, "stage")
	yield* fs.makeDirectory(stage)
	yield* write(path.join(stage, "package.json"), {
		name: "test-release",
		version: "1.0.0",
	})
	yield* write(path.join(stage, "release.json"), release)
	const id = (yield* Artifact.directoryIdentity(stage)).digest
	yield* fs.rename(stage, path.join(store, id))
	const resolver = yield* ModuleResolver.make({
		base: store,
		importer: (specifier) => import(specifier),
	})
	return { fs, path, store, id, resolver }
})

it.effect(
	"fences memory after journal failure even when recording degradation also fails",
	() =>
		Effect.gen(function* () {
			const { fs, path, store, id, resolver } = yield* setup()
			const file = path.join(store, "source.yml")
			yield* fs.writeFileString(file, "[]")
			const target = yield* build(store, {
				file,
				references: [],
				revocations: [],
			})
			const writes = yield* Ref.make(0)
			const broken = FileSystem.FileSystem.of({
				...fs,
				rename: (from, to) =>
					to === path.join(store, "journal.json")
						? Ref.updateAndGet(writes, (count) => count + 1).pipe(
								Effect.flatMap((count) =>
									count < 3
										? fs.rename(from, to)
										: Effect.die("Journal write " + count + " failed"),
								),
							)
						: fs.rename(from, to),
			})
			const service = yield* make({ store, initial: id, host }).pipe(
				Effect.provideService(ModuleResolver.ModuleResolver, resolver),
				Effect.provideService(FileSystem.FileSystem, broken),
			)
			const result = yield* Effect.exit(service.apply({ target, expected: id }))
			if (result._tag === "Failure")
				assert.equal(result.cause.reasons.length, 2)
			else assert.fail("A journal failure must not report success")
			assert.equal((yield* service.observe).state, "Degraded")
			assert.equal((yield* service.observe).current, id)
			assert.equal(
				(yield* Effect.flip(service.apply({ target, expected: id }))).code,
				"Degraded",
			)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.effect("checks expected release ids atomically for concurrent applies", () =>
	Effect.gen(function* () {
		const { fs, path, store, id, resolver } = yield* setup()
		const targets = yield* Effect.forEach(
			["2.0.0", "3.0.0"],
			Effect.fnUntraced(function* (version) {
				const stage = path.join(store, version)
				yield* fs.makeDirectory(stage)
				yield* write(path.join(stage, "package.json"), {
					name: "test-release",
					version,
				})
				yield* write(path.join(stage, "release.json"), release)
				const next = (yield* Artifact.directoryIdentity(stage)).digest
				yield* fs.rename(stage, path.join(store, next))
				return next
			}),
		)
		const service = yield* make({ store, initial: id, host }).pipe(
			Effect.provideService(ModuleResolver.ModuleResolver, resolver),
		)
		const results = yield* Effect.forEach(
			targets,
			(target) => service.apply({ target, expected: id }).pipe(Effect.exit),
			{ concurrency: 2 },
		)
		assert.equal(
			Array.filter(results, (result) => result._tag === "Success").length,
			1,
		)
		assert.equal(
			Array.filter(results, (result) => result._tag === "Failure").length,
			1,
		)
		const history = yield* service.history
		assert.equal(
			Array.filter(history, (event) => event.kind === "Commit").length,
			1,
		)
	}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.effect(
	"keeps environment values out of encoded configuration and reference inventories",
	() =>
		Effect.gen(function* () {
			const encoded = {
				credential: { $env: "TOKEN" },
				nested: [{ $env: "OTHER" }],
			}
			assert.deepEqual(references(encoded), ["env:TOKEN", "env:OTHER"])
			const resolved = yield* resolveInput(encoded)
			assert.deepEqual(resolved, { credential: "secret", nested: ["second"] })
			assert.deepEqual(encoded.credential, { $env: "TOKEN" })
			const error = yield* Effect.flip(
				resolveInput({ $env: "TOKEN", fallback: "forbidden" }),
			)
			assert.equal(error.code, "Reference")
		}).pipe(
			Effect.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({ TOKEN: "secret", OTHER: "second" }),
				),
			),
		),
)

it.effect(
	"verifies all immutable release bytes and rejects path traversal",
	() =>
		Effect.gen(function* () {
			const { fs, path, store, id } = yield* setup()
			const loaded = yield* load(store, id)
			assert.deepEqual(loaded, release)
			yield* fs.writeFileString(path.join(store, id, "extra"), "changed")
			assert.equal((yield* Effect.flip(load(store, id))).code, "Integrity")
			assert.equal(
				(yield* Effect.flip(load(store, "../journal.json"))).code,
				"Storage",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"selects the last accepted release after an incomplete durable intent",
	() =>
		Effect.gen(function* () {
			const { path, store, id, resolver } = yield* setup()
			const target = String.repeat(64)("a")
			const journal: Journal = {
				version: 1,
				status: {
					current: id,
					previous: null,
					state: "Applying",
					revocations: [],
				},
				events: [
					{ kind: "Bootstrap", current: id, target: id },
					{ kind: "Intent", current: id, target, entries: [] },
				],
			}
			yield* durable(path.join(store, "journal.json"), journal)
			const service = yield* make({ store, initial: target, host }).pipe(
				Effect.provideService(ModuleResolver.ModuleResolver, resolver),
			)
			assert.equal((yield* service.observe).current, id)
			assert.equal((yield* service.observe).state, "Ready")
			assert.deepEqual((yield* service.history).at(-1), {
				kind: "Startup",
				current: id,
				target: id,
			})
			assert.equal(
				(yield* read(path.join(store, "journal.json"), Journal)).status.current,
				id,
			)
			assert.equal(
				(yield* Effect.flip(service.apply({ target: id, expected: target })))
					.code,
				"Conflict",
			)
			assert.deepEqual(
				(yield* service.apply({ target: id, expected: id })).outcomes,
				[],
			)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.effect("rejects unmanaged release sources before creating a release", () =>
	Effect.gen(function* () {
		const { fs, path, store } = yield* setup()
		const file = path.join(store, "source.yml")
		yield* fs.writeFileString(file, "- id: host\n  name: ordinary-plugin\n")
		assert.equal(
			(yield* Effect.flip(
				build(path.join(store, "output"), {
					file,
					references: [],
					revocations: [],
				}),
			)).code,
			"Configuration",
		)
		const exists = yield* fs.exists(path.join(store, "output"))
		assert.equal(exists, false)
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"refuses a corrupt journal instead of silently bootstrapping another release",
	() =>
		Effect.gen(function* () {
			const { fs, path, store, id, resolver } = yield* setup()
			yield* fs.writeFileString(path.join(store, "journal.json"), "{broken")
			const result = yield* Effect.flip(
				make({ store, initial: id, host }).pipe(
					Effect.provideService(ModuleResolver.ModuleResolver, resolver),
				),
			)
			assert.equal(result.code, "Storage")
			assert.equal(Schema.is(Journal)({}), false)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.effect(
	"rejects semantic corruption before selecting an accepted checkpoint",
	() =>
		Effect.gen(function* () {
			const { fs, path, store, id, resolver } = yield* setup()
			const file = path.join(store, "source.yml")
			yield* fs.writeFileString(file, "[]")
			const target = yield* build(store, {
				file,
				references: [],
				revocations: ["credential:old"],
			})
			const accepted: Journal = {
				version: 1,
				status: {
					current: target,
					previous: id,
					state: "Ready",
					revocations: ["credential:old"],
				},
				events: [
					{ kind: "Bootstrap", current: id, target: id },
					{ kind: "Intent", current: id, target, entries: [] },
					{ kind: "Commit", current: target, target },
				],
			}
			const corruptions: ReadonlyArray<Journal> = [
				{
					...accepted,
					status: { ...accepted.status, state: "Applying" },
					events: Array.take(accepted.events, 2),
				},
				{ ...accepted, status: { ...accepted.status, previous: null } },
				{ ...accepted, status: { ...accepted.status, revocations: [] } },
				{
					...accepted,
					status: {
						...accepted.status,
						revocations: ["credential:old", "credential:unknown"],
					},
				},
				{
					...accepted,
					status: {
						current: id,
						previous: null,
						state: "Ready",
						revocations: [],
					},
					events: Array.take(accepted.events, 2),
				},
				{
					...accepted,
					events: Array.map(accepted.events, (event) =>
						event.kind === "Intent"
							? { ...event, entries: ["unfinished"] }
							: event,
					),
				},
			]
			for (const journal of corruptions) {
				yield* durable(path.join(store, "journal.json"), journal)
				const error = yield* Effect.flip(
					make({ store, initial: id, host }).pipe(
						Effect.provideService(ModuleResolver.ModuleResolver, resolver),
					),
				)
				assert.equal(error.code, "Journal")
				const persisted = yield* read(path.join(store, "journal.json"), Journal)
				assert.deepEqual(persisted, journal)
			}
			yield* durable(path.join(store, "journal.json"), accepted)
			const service = yield* make({ store, initial: id, host }).pipe(
				Effect.provideService(ModuleResolver.ModuleResolver, resolver),
			)
			const observed = yield* service.observe
			assert.deepEqual(observed, accepted.status)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.effect(
	"does not promote an unfinished target when a schema-valid journal changes current",
	() =>
		Effect.gen(function* () {
			const { fs, path, store, id, resolver } = yield* setup()
			const file = path.join(store, "source.yml")
			yield* fs.writeFileString(file, "[]")
			const target = yield* build(store, {
				file,
				references: [],
				revocations: [],
			})
			yield* make({ store, initial: id, host }).pipe(
				Effect.provideService(ModuleResolver.ModuleResolver, resolver),
				Effect.scoped,
			)
			const accepted = yield* read(path.join(store, "journal.json"), Journal)
			const corrupted: Journal = {
				...accepted,
				status: { ...accepted.status, current: target, state: "Applying" },
				events: [
					...accepted.events,
					{ kind: "Intent", current: id, target, entries: [] },
				],
			}
			assert.isTrue(Schema.is(Journal)(corrupted))
			yield* durable(path.join(store, "journal.json"), corrupted)
			const error = yield* Effect.flip(
				make({ store, initial: id, host }).pipe(
					Effect.provideService(ModuleResolver.ModuleResolver, resolver),
				),
			)
			assert.equal(error.code, "Journal")
			const persisted = yield* read(path.join(store, "journal.json"), Journal)
			assert.deepEqual(persisted, corrupted)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.effect(
	"journals exact approvals and replays revocations before granting access",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			const artifact = {
				package: "@example/plugin",
				digest: String.repeat(64)("a"),
			}
			const policy: Policy.Policy = {
				version: "1",
				entries: [
					{
						entry: "test",
						artifact,
						tier: "trusted",
						grants: [{ _tag: "Files", id: "data", directory: "/data" }],
					},
				],
			}
			const file = h.path.join(h.store, "trust.json")
			yield* write(file, policy)
			const service = yield* make({
				store: h.store,
				initial: h.id,
				host,
				trust: file,
			}).pipe(Effect.provideService(ModuleResolver.ModuleResolver, h.resolver))
			yield* Policy.bind("test", "candidate", artifact, ["test"])
			const expected = yield* Policy.statement("test", artifact)
			const approval = yield* service.approve({
				expected,
				who: "operator@example",
			})
			assert.equal(approval.who, "operator@example")
			yield* Policy.check("test", "candidate")
			yield* service.revoke(["data"], "operator@example")
			const error = yield* Policy.check("test", "candidate").pipe(Effect.flip)
			assert.equal(error.reason, "Revoked")
			const journal = yield* read(h.path.join(h.store, "journal.json"), Journal)
			const replay = yield* validate(h.store, journal)
			assert.deepEqual(replay.approvals, [])
			assert.deepEqual(replay.status.revocations, ["data"])
			const override = yield* service.approve({
				expected,
				who: "emergency operator",
				overrideRevocations: true,
			})
			assert.isTrue(override.overrideRevocations)
			yield* Policy.check("test", "candidate")
			const source = h.path.join(h.store, "carried-forward.yml")
			yield* h.fs.writeFileString(source, "[]")
			const target = yield* build(h.store, {
				file: source,
				references: [],
				revocations: ["data"],
			})
			yield* service.apply({ expected: h.id, target })
			yield* Policy.check("test", "candidate")
			const updated = yield* read(h.path.join(h.store, "journal.json"), Journal)
			const accepted = yield* validate(h.store, updated)
			assert.equal(accepted.approvals.length, 1)
			assert.isTrue(accepted.approvals[0]!.overrideRevocations)
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)

it.effect(
	"reuses a metadata-only release without importing package code on either build",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			const directory = h.path.join(h.store, "untrusted")
			yield* h.fs.makeDirectory(directory)
			const marker = h.path.join(h.store, "imported.txt")
			const secret = h.path.join(h.store, "host-secret.txt")
			yield* h.fs.writeFileString(secret, "Host-only data")
			yield* h.fs.writeFileString(
				h.path.join(directory, "index.js"),
				`import { copyFileSync } from "node:fs"; copyFileSync(${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(secret)}, ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(marker)}); throw new Error("Untrusted import executed")`,
			)
			yield* h.fs.writeFileString(
				h.path.join(h.store, "contract.js"),
				"export default null",
			)
			yield* write(h.path.join(directory, "package.json"), {
				name: "@example/untrusted",
				version: "1.0.0",
				type: "module",
				engines: { node: ">=22.19.0" },
				peerDependencies: { effect: "4.1.*", "@graftland/graft": "0.0.0" },
				graft: {
					version: 1,
					entries: {
						".": {
							implementation: "index.js",
							contracts: [],
							probes: [],
							requirements: {
								placements: ["Local"],
								filesystem: false,
								nativeModules: false,
							},
							services: { required: [], optional: [], implements: [] },
							operations: [],
						},
					},
				},
			})
			const source = h.path.join(h.store, "untrusted.yml")
			yield* write(source, [
				{
					id: "untrusted",
					name: "@graftland/plugin-remote",
					config: {
						package: "./untrusted",
						entry: ".",
						contract: "./contract.js",
						target: { _tag: "Local" },
						config: {},
						probes: [],
					},
				},
			])
			const id = yield* build(h.store, {
				file: source,
				references: [],
				revocations: [],
				metadataOnly: true,
			})
			const firstImport = yield* h.fs.exists(marker)
			assert.isFalse(firstImport)
			const repeated = yield* build(h.store, {
				file: source,
				references: [],
				revocations: [],
				metadataOnly: true,
			})
			assert.equal(repeated, id)
			const secondImport = yield* h.fs.exists(marker)
			assert.isFalse(secondImport)
			const result = yield* load(h.store, id, true)
			assert.equal(result.entries[0]?.package.name, "@example/untrusted")
		}).pipe(Effect.scoped, Effect.provide(runtime)),
)
