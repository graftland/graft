import {
	Array,
	Cause,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schedule,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"
import * as Artifact from "@graftland/plugin-remote/Artifact"
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
		module: "business.mjs",
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
	return { recorder, version, layer, journal: path.join(directory, "journal") }
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
