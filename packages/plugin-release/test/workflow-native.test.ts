import process from "node:process"

import {
	Array,
	Cause,
	ConfigProvider,
	Effect,
	Fiber,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
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

const fixture = Effect.fnUntraced(function* (
	options: {
		readonly secret?: boolean
		readonly versions?: ReadonlyArray<number>
	} = {},
) {
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
export const Config = Schema.Struct({ output: Schema.String, credentials: Schema.optionalKey(Schema.Struct({ token: Schema.String, repeated: Schema.Array(Schema.String) })) });
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
				config: {
					output: serving,
					...(options.secret === true
						? {
								credentials: {
									token: { $env: "RELEASE_TOKEN" },
									repeated: [{ $env: "RELEASE_TOKEN" }],
								},
							}
						: {}),
				},
				probes: [],
			},
		},
	])
	const releases = yield* Effect.forEach(
		options.versions ?? [1, 2, 3],
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
if (config.credentials !== undefined) yield* fs.writeFileString(config.output + ".resolved", String(config.credentials.token.length) + ":" + String(config.credentials.repeated[0] === config.credentials.token));
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
	return { directory, store, releases, recorder, layer, serving }
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
				const rollbackKey = Option.getOrThrow(Array.last(recorded)).key
				yield* fs.remove(
					path.join(
						f.store.releases,
						".applications",
						`${rollbackKey}.receipt.json`,
					),
				)
				const recoveredHistory = yield* history(f.store)
				assert.deepEqual(recoveredHistory, recorded)
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

const startRecorder = Effect.fnUntraced(function* (
	client: Control.Client,
	target: Kernel.Target,
) {
	const handle = yield* client.submit({
		operations: [{ _tag: "Deploy", instance: "recorder", target }],
		budget,
	})
	const result = yield* handle.await
	assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
	yield* client.recording.pipe(
		Effect.repeat({
			schedule: Schedule.spaced("10 millis"),
			until: (value) => Option.isSome(value.grant),
		}),
		Effect.timeout("10 seconds"),
	)
})

it.live(
	"keeps environment secrets out of release requests, Change status and every journal file without undoing revocation",
	() =>
		Effect.gen(function* () {
			// Loading and planning must work without the secret's environment provider.
			const f = yield* fixture({ secret: true, versions: [1, 2] })
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const first = f.releases[0]!
			const second = f.releases[1]!
			const secret = "release-fixture-secret-do-not-record"
			const input = first.entries[0]!.target.deployment?.input
			assert.deepEqual(input, {
				output: f.serving,
				credentials: {
					token: { $reference: "RELEASE_TOKEN" },
					repeated: [{ $reference: "RELEASE_TOKEN" }],
				},
			})
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				yield* client.setPolicy({
					instance: "business",
					allowed: [
						first.entries[0]!.target.identity,
						second.entries[0]!.target.identity,
					],
					values: {},
				})
				yield* startRecorder(client, f.recorder)
				const updates = yield* Ref.make<ReadonlyArray<Control.Policy>>([])
				const requests = yield* Ref.make<ReadonlyArray<Kernel.Request>>([])
				const tracked: Control.Client = {
					...client,
					setPolicy: (policy) =>
						Ref.update(updates, Array.append(policy)).pipe(
							Effect.andThen(client.setPolicy(policy)),
						),
					submit: (request) =>
						Ref.update(requests, Array.append(request)).pipe(
							Effect.andThen(client.submit(request)),
						),
				}
				const values = ConfigProvider.layer(
					ConfigProvider.fromUnknown({ RELEASE_TOKEN: secret }),
				)
				const result = yield* apply(tracked, f.store, first.id, [], {
					budget,
				}).pipe(Effect.provide(values))
				assert.equal(result.outcome, "Accepted", result.diagnostic)
				const resolved = yield* fs.readFileString(f.serving + ".resolved")
				assert.equal(resolved, `${secret.length}:true`)
				const policies = yield* Ref.get(updates)
				assert.deepEqual(policies, [
					{ instance: "business", values: { RELEASE_TOKEN: secret } },
				])
				const submitted = yield* Ref.get(requests)
				const submittedText = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(submitted)
				assert.notInclude(submittedText, secret)
				assert.include(submittedText, "$reference")
				const observed = yield* observe(client, result.change)
				const status = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(Option.getOrThrow(observed))
				assert.include(status, "RELEASE_TOKEN")
				assert.notInclude(status, secret)
				const names = yield* fs.readDirectory(f.store.journal, {
					recursive: true,
				})
				for (const name of names) {
					const file = path.join(f.store.journal, name)
					if ((yield* fs.stat(file)).type === "File") {
						const text = yield* fs.readFileString(file)
						assert.notInclude(text, secret, `The secret leaked into ${name}`)
					}
				}
				yield* client.setPolicy({
					instance: "business",
					allowed: [],
					values: {},
				})
				const denied = yield* apply(
					tracked,
					f.store,
					second.id,
					first.entries,
					{ budget },
				).pipe(Effect.provide(values), Effect.flip)
				assert.equal(denied.code, "Unauthorized")
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)

/** An external kernel can be killed without running its shutdown finalizers. */
const startKernel = Effect.fnUntraced(function* (
	f: Effect.Success<ReturnType<typeof fixture>>,
	name: string,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const deployment = path.join(f.directory, `${name}-deployment.json`)
	const ready = path.join(f.directory, `${name}-ready.json`)
	const text = yield* Schema.encodeEffect(
		Schema.fromJsonString(Control.Deployment),
	)({
		authority: "release-workflow-restart",
		maxUnits: 8,
		recording: {
			recorder: "release",
			instance: "recorder",
			scope: ["business"],
		},
		instances: [
			{ id: "recorder", target: f.recorder },
			...Array.map(f.releases[0]!.entries, ({ id, target }) => ({
				id,
				target,
			})),
		],
	})
	yield* fs.writeFileString(deployment, text)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const child = yield* spawner.spawn(
		ChildProcess.make(
			process.execPath,
			[
				new URL(
					"../../plugin-remote/dist/internal/kernelMain.js",
					import.meta.url,
				).pathname,
				deployment,
				ready,
			],
			{ stdout: "pipe", stderr: "pipe", killSignal: "SIGKILL" },
		),
	)
	const stderr = yield* Stream.mkString(Stream.decodeText(child.stderr)).pipe(
		Effect.forkScoped,
	)
	yield* Stream.runDrain(child.stdout).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("Release restart fixture stdout failed", cause),
		),
		Effect.forkScoped,
	)
	yield* Effect.raceFirst(
		fs.exists(ready).pipe(
			Effect.repeat({
				schedule: Schedule.spaced("10 millis"),
				until: (exists) => exists,
			}),
		),
		child.exitCode.pipe(
			Effect.flatMap((code) =>
				Fiber.join(stderr).pipe(
					Effect.flatMap((output) =>
						Effect.die(`Kernel exited before readiness: ${code}: ${output}`),
					),
				),
			),
		),
	).pipe(Effect.timeout("10 seconds"))
	const address = yield* fs
		.readFileString(ready)
		.pipe(
			Effect.flatMap(
				Schema.decodeEffect(Schema.fromJsonString(Control.Address)),
			),
		)
	return { child, client: yield* Control.connect(address) }
})

it.live(
	"recovers a journaled release after a kernel crash before its receipt was saved, without executing it again",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture({ secret: true, versions: [1] })
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const release = f.releases[0]!
			const first = yield* startKernel(f, "first")
			yield* startRecorder(first.client, f.recorder)
			const original = yield* apply(first.client, f.store, release.id, [], {
				budget,
			}).pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							RELEASE_TOKEN: "first-release-credential",
						}),
					),
				),
			)
			assert.equal(original.outcome, "Accepted", original.diagnostic)
			const receipt = path.join(
				f.store.releases,
				".applications",
				`release-${release.id}.receipt.json`,
			)
			// Reproduce the durable state left when the operator dies before saving any receipt.
			yield* fs.remove(receipt)
			yield* first.client.close
			yield* first.child.kill({ killSignal: "SIGKILL" })
			const firstExit = yield* first.child.exitCode.pipe(Effect.flip)
			assert.include(Cause.pretty(Cause.fail(firstExit)), "SIGKILL")
			const second = yield* startKernel(f, "second")
			yield* startRecorder(second.client, f.recorder)
			const before = yield* history(f.store)
			assert.lengthOf(before, 1)
			assert.equal(before[0]!.release, release.id)
			assert.equal(before[0]!.change, original.change)
			assert.isTrue(Option.contains(before[0]!.run, original.run!))
			assert.isTrue(Option.contains(before[0]!.outcome, "Accepted"))
			const absent = yield* fs.exists(receipt)
			assert.isFalse(absent)
			const rejections = yield* Ref.make<ReadonlyArray<string>>([])
			const tracked: Control.Client = {
				...second.client,
				submit: (request) =>
					second.client
						.submit(request)
						.pipe(
							Effect.tapError((error) =>
								Ref.update(rejections, Array.append(error.reason)),
							),
						),
			}
			const recovered = yield* apply(tracked, f.store, release.id, [], {
				budget,
			}).pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							RELEASE_TOKEN: "rotated-release-credential",
						}),
					),
				),
			)
			assert.deepEqual(recovered, original)
			const rejected = yield* Ref.get(rejections)
			assert.deepEqual(rejected, ["AlreadyRecorded"])
			const saved = yield* fs.exists(receipt)
			assert.isTrue(saved)
			const units = yield* second.client.units
			assert.isFalse(
				Array.some(units, (unit) => HashMap.has(unit.members, "business")),
			)
			const after = yield* history(f.store)
			assert.deepEqual(after, before)
			yield* second.client.close
			yield* second.child.kill({ killSignal: "SIGKILL" })
			const secondExit = yield* second.child.exitCode.pipe(Effect.flip)
			assert.include(Cause.pretty(Cause.fail(secondExit)), "SIGKILL")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	60000,
)
