import process from "node:process"

import {
	Array,
	Cause,
	Effect,
	Fiber,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import * as Journal from "../src/Journal"

const budget = {
	total: 10000,
	startup: 2000,
	probe: 250,
	drain: 250,
	stop: 250,
	terminate: 500,
}
const recording = { recorder: "release", instance: "release", scope: ["a"] }
/** Captures the built release recorder and the business fixture into this package's cache. */
const fixture = Effect.fn(function* (
	recorderEntry: "release" | "withholding",
	durable: boolean = false,
	businessEntry: "business.mjs" | "blocked.mjs" = "business.mjs",
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const cache = new URL("../.cache/recorder-tests/", import.meta.url).pathname
	yield* fs.makeDirectory(cache, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: cache })
	const store = path.join(directory, "artifacts")
	const recorderArtifact =
		recorderEntry === "release"
			? yield* Artifact.capture({
					directory: new URL("../", import.meta.url).pathname,
					module: "dist/Recorder.js",
					exclude: ["node_modules", ".cache", "src", "test"],
					store,
				})
			: yield* Artifact.capture({
					directory: new URL("./fixtures/recorded/", import.meta.url).pathname,
					module: "withholding.mjs",
					store,
				})
	const business = yield* Artifact.capture({
		directory: new URL("./fixtures/recorded/", import.meta.url).pathname,
		module: businessEntry,
		store,
	})
	const recorder = Units.target({
		artifact: recorderArtifact,
		input: durable
			? {
					recorder: "release",
					directory: path.join(directory, "journal"),
					diagnosticRetention: "2 hours",
				}
			: { recorder: "release" },
		placement: "Worker",
	})
	const version = (n: number) =>
		Units.target({
			artifact: business,
			input: { version: n },
			placement: "Worker",
		})
	const layer = Kernel.layer({
		authority: "recorder-unit",
		maxUnits: 6,
		recording,
		instances: [
			{ id: "release", target: recorder },
			{ id: "a", target: version(1) },
		],
	}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
	return {
		recorder,
		version,
		layer,
		directory,
		journal: path.join(directory, "journal"),
	}
})
const granted = Effect.gen(function* () {
	const kernel = yield* Kernel.Kernel
	return yield* kernel.recording.pipe(
		Effect.repeat({
			schedule: Schedule.spaced("10 millis"),
			until: (r) => Option.isSome(r.grant),
		}),
		Effect.timeout("10 seconds"),
	)
})

it.live(
	"records each stage of a scoped Change through the ordinary release unit before reporting Accepted (I8, F16)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture("release")
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				const unrecorded = yield* Change.run({
					operations: [
						{ _tag: "Deploy", instance: "release", target: f.recorder },
					],
					budget,
				})
				assert.equal(
					unrecorded.outcome,
					"Accepted",
					Cause.pretty(unrecorded.cause),
				)
				yield* granted
				const first = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "a", target: f.version(1) }],
					budget,
				})
				assert.equal(first.outcome, "Accepted", Cause.pretty(first.cause))
				const upgrade = yield* Change.submit({
					operations: [{ _tag: "Deploy", instance: "a", target: f.version(2) }],
					strategy: "Restart",
					budget,
				})
				const upgraded = yield* upgrade.await
				assert.equal(upgraded.outcome, "Accepted", Cause.pretty(upgraded.cause))
				const current = yield* Change.get(upgrade.id)
				const status = Option.getOrThrow(current)
				assert.isTrue(status.recording.required)
				assert.equal(status.recording.outstanding.length, 0)
				const residual = yield* kernel.recording
				assert.equal(residual.outstanding.length, 0)
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

it.live(
	"rejects replacing the recorder together with recorded work before any Change exists (I9, F19)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture("release")
			yield* Effect.gen(function* () {
				yield* Change.run({
					operations: [
						{ _tag: "Deploy", instance: "release", target: f.recorder },
					],
					budget,
				})
				yield* granted
				const rejected = yield* Change.submit({
					operations: [
						{ _tag: "Deploy", instance: "a", target: f.version(1) },
						{ _tag: "Deploy", instance: "release", target: f.recorder },
					],
					budget,
				}).pipe(Effect.flip)
				assert.equal(rejected.reason, "SelfReplacement")
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

it.live(
	"never reports success when a third-party recorder on the same protocol withholds acknowledgement (I8, F16)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture("withholding")
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				yield* Change.run({
					operations: [
						{ _tag: "Deploy", instance: "release", target: f.recorder },
					],
					budget,
				})
				yield* granted
				const result = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "a", target: f.version(1) }],
					budget,
				})
				assert.notEqual(result.outcome, "Accepted")
				const residual = yield* kernel.recording
				assert.isTrue(
					Array.some(
						residual.outstanding,
						(duty) => duty.payload.stage === "Intent",
					),
				)
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

it.live(
	"journals every stage of a recorded Change on disk before acknowledging it, readable by Change id (C4)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture("release", true)
			const id = yield* Effect.gen(function* () {
				yield* Change.run({
					operations: [
						{ _tag: "Deploy", instance: "release", target: f.recorder },
					],
					budget,
				})
				yield* granted
				const handle = yield* Change.submit({
					operations: [{ _tag: "Deploy", instance: "a", target: f.version(1) }],
					budget,
				})
				const result = yield* handle.await
				assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
				return handle.id
			}).pipe(Effect.provide(f.layer))
			const history = yield* Journal.history(f.journal)
			const recorded = Option.getOrThrow(
				Array.findFirst(history, (s) => s.change === id),
			)
			assert.deepStrictEqual(recorded.stages, [
				"Intent",
				"Commit",
				"Conclusion",
			])
			assert.isTrue(Option.contains(recorded.outcome, "Accepted"))
			assert.isTrue(recorded.concluded)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

/** A separate process permits an abrupt kernel loss without running its shutdown finalizers. */
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
		authority: "recorder-restart",
		maxUnits: 6,
		recording,
		instances: [
			{ id: "release", target: f.recorder },
			{ id: "a", target: f.version(1) },
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
			Effect.logError("Restart fixture stdout failed", cause),
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
const startRecorder = Effect.fnUntraced(function* (
	client: Control.Client,
	target: Kernel.Target,
) {
	const handle = yield* client.submit({
		operations: [{ _tag: "Deploy", instance: "release", target }],
		budget,
	})
	const result = yield* handle.await
	assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
	yield* client.recording.pipe(
		Effect.repeat({
			schedule: Schedule.spaced("10 millis"),
			until: (r) => Option.isSome(r.grant),
		}),
		Effect.timeout("10 seconds"),
	)
})

for (const difference of ["strategy", "configuration"] as const)
	it.live(
		`recovers a journaled request key and concludes an interrupted native Change after a kernel crash (${difference}, K6)`,
		() =>
			Effect.gen(function* () {
				const f = yield* fixture("release", true, "blocked.mjs")
				const request: Kernel.Request = {
					operations: [{ _tag: "Deploy", instance: "a", target: f.version(1) }],
					key: "deploy-a-once",
					budget: { ...budget, total: 180000, startup: 60000 },
				}
				const first = yield* startKernel(f, "first")
				yield* startRecorder(first.client, f.recorder)
				const change = yield* first.client.submit(request)
				yield* first.client.get(change.id).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (status) =>
							Option.exists(status, (s) => s.phase === "Readiness"),
					}),
					Effect.timeout("10 seconds"),
				)
				const recorded = yield* Journal.history(f.journal)
				const original = Option.getOrThrow(
					Array.findFirst(recorded, (s) => s.change === change.id),
				)
				assert.isFalse(original.concluded)
				assert.deepStrictEqual(original.stages, ["Intent"])
				yield* first.client.close
				yield* first.child.kill({ killSignal: "SIGKILL" })
				const firstExit = yield* first.child.exitCode.pipe(Effect.flip)
				assert.include(Cause.pretty(Cause.fail(firstExit)), "SIGKILL")
				const lost = yield* Journal.history(f.journal)
				assert.deepStrictEqual(lost, [original])

				const second = yield* startKernel(f, "second")
				yield* startRecorder(second.client, f.recorder)
				const history = yield* Journal.history(f.journal).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("10 millis"),
						until: (rows) =>
							Array.some(
								rows,
								(s) =>
									s.run === original.run &&
									s.change === original.change &&
									s.concluded,
							),
					}),
					Effect.timeout("10 seconds"),
				)
				const recovered = Option.getOrThrow(
					Array.findFirst(
						history,
						(s) => s.run === original.run && s.change === original.change,
					),
				)
				assert.deepStrictEqual(recovered.stages, ["Intent", "Conclusion"])
				assert.equal(recovered.phase, "Interrupted")
				assert.isTrue(Option.isNone(recovered.outcome))
				assert.deepStrictEqual(recovered.facts, [
					{
						instance: "a",
						desired: null,
						actual: null,
						healthy: false,
						attempt: "NotStarted",
					},
				])
				const units = yield* second.client.units
				assert.isFalse(
					Array.some(units, (unit) => HashMap.has(unit.members, "a")),
				)
				assert.equal(
					recovered.diagnostic,
					"The kernel restarted before this Change concluded",
				)
				const same = yield* second.client.submit(request).pipe(Effect.flip)
				assert.equal(same.reason, "AlreadyRecorded")
				assert.deepStrictEqual(same.conflicts, [
					`${original.run}/${original.change}`,
				])
				const different = yield* second.client
					.submit(
						difference === "strategy"
							? { ...request, strategy: "Overlap" }
							: {
									...request,
									operations: [
										{ _tag: "Deploy", instance: "a", target: f.version(2) },
									],
								},
					)
					.pipe(Effect.flip)
				assert.equal(different.reason, "KeyConflict")
				const final = yield* Journal.history(f.journal)
				assert.deepStrictEqual(final, history)
				yield* second.client.close
				yield* second.child.kill({ killSignal: "SIGKILL" })
				const secondExit = yield* second.child.exitCode.pipe(Effect.flip)
				assert.include(Cause.pretty(Cause.fail(secondExit)), "SIGKILL")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30000,
	)
