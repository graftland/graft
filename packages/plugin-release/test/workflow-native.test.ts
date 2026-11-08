import {
	Array,
	Cause,
	Effect,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Schedule,
	Schema,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import { apply, build, history, load, observe, rollback } from "../src/index"
import { write } from "../src/internal/storage"

const budget = {
	total: 15000,
	startup: 4000,
	probe: 500,
	drain: 500,
	stop: 500,
	terminate: 1000,
}

const fixture = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const cache = new URL("../.cache/workflow-tests/", import.meta.url).pathname
	yield* fs.makeDirectory(cache, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: cache })
	const store = {
		releases: path.join(directory, "releases"),
		journal: path.join(directory, "journal"),
	}
	const source = path.join(directory, "source.json")
	const business = path.join(directory, "business")
	const serving = path.join(directory, "serving.txt")
	const contracts = path.join(directory, "contracts")
	yield* fs.makeDirectory(contracts)
	yield* write(path.join(contracts, "package.json"), {
		name: "@example/release-contract",
		version: "1.0.0",
		type: "module",
	})
	const contractUrl = (yield* path.toFileUrl(
		path.join(contracts, "contract.js"),
	)).href
	const contractImport = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.String),
	)(contractUrl)
	yield* fs.makeDirectory(business)
	yield* fs.writeFileString(
		path.join(contracts, "contract.js"),
		`import { Schema } from "effect"; import { Contract } from "@graftland/plugin-remote";
export const Config = Schema.Struct({ output: Schema.String });
export default Contract.make({ name: "release-business", config: Config });`,
	)
	yield* write(source, [
		{
			id: "business",
			name: "@graftland/plugin-remote",
			config: {
				package: "./business",
				entry: ".",
				contract: contractUrl,
				target: { _tag: "Worker" },
				config: { output: serving },
				probes: [],
			},
		},
	])
	const releases = yield* Effect.forEach(
		[1, 2, 3],
		Effect.fnUntraced(function* (version) {
			yield* write(path.join(business, "package.json"), {
				name: "@example/release-business",
				version: `${version}.0.0`,
				type: "module",
				exports: { ".": "./plugin.js" },
				engines: { node: ">=22.19.0" },
				peerDependencies: { effect: "4.1.*", "@graftland/graft": "0.0.0" },
				graft: {
					version: 1,
					entries: {
						".": {
							implementation: "plugin.js",
							contracts: [contractUrl],
							probes: [],
							requirements: {
								placements: ["Worker"],
								filesystem: true,
								nativeModules: false,
							},
						},
					},
				},
			})
			yield* fs.writeFileString(
				path.join(business, "plugin.js"),
				`import { Effect, FileSystem } from "effect"; import { Plugin } from "@graftland/graft"; import { Config } from ${contractImport}; import { NodeFileSystem } from "@effect/platform-node";
export default Plugin.make({ name: "release-business", config: Config, overlap: true, apply: config => Effect.gen(function* () {
if (${version} === 3) return yield* Effect.die("Deliberately failing release");
const fs = yield* FileSystem.FileSystem;
yield* fs.writeFileString(config.output, "${version}");
}).pipe(Effect.provide(NodeFileSystem.layer)) });`,
			)
			const id = yield* build(store.releases, {
				file: source,
				references: [],
				revocations: [],
			})
			return yield* load(store.releases, id)
		}),
	)
	const recorderArtifact = yield* Artifact.capture({
		directory: new URL("../", import.meta.url).pathname,
		module: "dist/Recorder.js",
		exclude: ["node_modules", ".cache", "src", "test"],
		store: path.join(directory, "artifacts"),
	})
	const recorder = Units.target({
		artifact: recorderArtifact,
		input: { recorder: "release", directory: store.journal },
		placement: "Worker",
	})
	const layer = Kernel.layer({
		authority: "release-workflow",
		maxUnits: 8,
		recording: {
			recorder: "release",
			instance: "recorder",
			scope: ["business"],
		},
		instances: [{ id: "recorder", target: recorder }],
	}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
	return { store, releases, recorder, layer, serving }
})

it.live(
	"applies immutable releases, reports a failed candidate, rolls back and rejects a revoked rollback through public control",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const first = f.releases[0]!
			const second = f.releases[1]!
			const third = f.releases[2]!
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				yield* client.setPolicy({
					instance: "business",
					values: {},
					allowed: [
						f.recorder.identity,
						...Array.flatMap(f.releases, (release) =>
							Array.map(release.entries, (entry) => entry.target.identity),
						),
					],
				})
				const started = yield* client.submit({
					operations: [
						{ _tag: "Deploy", instance: "recorder", target: f.recorder },
					],
					budget,
				})
				assert.equal((yield* started.await).outcome, "Accepted")
				yield* client.recording.pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (value) => Option.isSome(value.grant),
					}),
					Effect.timeout("10 seconds"),
				)
				const options = { strategy: "Overlap" as const, budget }
				const one = yield* apply(client, f.store, first.id, [], options)
				assert.equal(one.outcome, "Accepted", one.diagnostic)
				const serving1 = yield* fs.readFileString(f.serving)
				assert.equal(serving1, "1")
				// Losing the local receipt still reuses the kernel's stable request key.
				yield* fs.remove(
					path.join(
						f.store.releases,
						".applications",
						`release-${first.id}.receipt.json`,
					),
				)
				const same = yield* apply(
					client,
					f.store,
					first.id,
					first.entries,
					options,
				)
				assert.deepEqual(same, one)
				const two = yield* apply(
					client,
					f.store,
					second.id,
					first.entries,
					options,
				)
				assert.equal(two.outcome, "Accepted", two.diagnostic)
				const receiptFile = path.join(
					f.store.releases,
					".applications",
					`release-${second.id}.receipt.json`,
				)
				const saved = yield* fs
					.readFileString(receiptFile)
					.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.fromJsonString(
									Schema.Record(Schema.String, Schema.Json),
								),
							),
						),
					)
				// Simulate a waiter that left after recording, before saving its result.
				yield* write(receiptFile, { ...saved, result: null })
				const recovered = yield* apply(
					client,
					f.store,
					second.id,
					second.entries,
					options,
				)
				assert.equal(recovered.change, two.change)
				assert.equal(recovered.run, two.run)
				assert.equal(recovered.outcome, "Accepted")
				const serving2 = yield* fs.readFileString(f.serving)
				assert.equal(serving2, "2")
				const failed = yield* apply(
					client,
					f.store,
					third.id,
					second.entries,
					options,
				)
				assert.equal(failed.outcome, "Aborted", failed.diagnostic)
				assert.include(failed.diagnostic, "Deliberately failing release")
				const serving3 = yield* fs.readFileString(f.serving)
				assert.equal(serving3, "2")
				const observed = yield* observe(client, failed.change)
				const status = Option.getOrThrow(observed)
				const member = Option.getOrThrow(
					HashMap.get(status.members, "business"),
				)
				assert.isTrue(member.healthy)
				assert.equal(
					Option.getOrThrow(member.actual).identity,
					second.entries[0]!.target.identity,
				)
				const reverted = yield* rollback(
					client,
					f.store,
					second.entries,
					options,
				)
				assert.equal(reverted.release, first.id)
				assert.equal(reverted.outcome, "Accepted", reverted.diagnostic)
				assert.notEqual(reverted.change, one.change)
				const serving4 = yield* fs.readFileString(f.serving)
				assert.equal(serving4, "1")
				const recorded = yield* history(f.store)
				assert.deepEqual(
					Array.map(recorded, (entry) => [
						entry.release,
						Option.getOrThrow(entry.outcome),
					]),
					[
						[first.id, "Accepted"],
						[second.id, "Accepted"],
						[third.id, "Aborted"],
						[first.id, "Accepted"],
					],
				)
				assert.isTrue(
					Array.every(
						recorded,
						(entry) => entry.recorded && Option.isSome(entry.run),
					),
				)
				// The next rollback would select the second release. Revocation must be checked again.
				yield* client.setPolicy({
					instance: "business",
					values: {},
					allowed: [
						f.recorder.identity,
						first.entries[0]!.target.identity,
						third.entries[0]!.target.identity,
					],
				})
				const revoked = yield* rollback(
					client,
					f.store,
					first.entries,
					options,
				).pipe(Effect.flip)
				assert.equal(
					revoked.code,
					"Unauthorized",
					Cause.pretty(
						Option.getOrThrow(Option.fromUndefinedOr(revoked.cause)),
					),
				)
				const serving5 = yield* fs.readFileString(f.serving)
				assert.equal(serving5, "1")
			}).pipe(Effect.provide(f.layer))
			const offline = yield* history(f.store)
			assert.equal(offline.length, 4)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	90000,
)
