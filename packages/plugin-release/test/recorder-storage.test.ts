import {
	Deferred,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	PlatformError,
	Ref,
	Schema,
	Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import type { RecordDuty } from "@graftland/graft/Kernel"
import { Recorder } from "@graftland/plugin-remote/Recording"

import * as Journal from "../src/Journal"
import { Config, plugin } from "../src/Recorder"

it.effect("rejects invalid diagnostic retention durations", () =>
	Effect.gen(function* () {
		for (const diagnosticRetention of [
			"forever",
			"-1 day",
			"Infinity millis",
		]) {
			const decoded = yield* Schema.decodeEffect(Config)({
				recorder: "release",
				diagnosticRetention,
			}).pipe(Effect.result)
			assert.equal(decoded._tag, "Failure")
		}
	}),
)

it.effect(
	"withholds recorder acknowledgement after a partial diagnostic write until a synced retry succeeds",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const directory = yield* fs.makeTempDirectoryScoped()
			const attempted = yield* Deferred.make<void>()
			const acknowledged = yield* Deferred.make<void>()
			const failing = yield* Ref.make(true)
			const record: RecordDuty = {
				id: "change-1/Conclusion",
				recorder: "release",
				unit: "unit-1",
				incarnation: "incarnation-1",
				content: "Sensitive cause",
				deliveries: 1,
				acknowledged: false,
				payload: {
					run: "run-1",
					change: "change-1",
					stage: "Conclusion",
					members: ["a"],
					targets: [],
					outcome: Option.some("Aborted"),
					facts: [],
					phase: "Concluded",
					diagnostic: "Sensitive cause",
				},
			}
			const failingFiles = Layer.effect(
				FileSystem.FileSystem,
				Effect.map(FileSystem.FileSystem, (fs) => ({
					...fs,
					open: (
						file: string,
						options?: Parameters<FileSystem.FileSystem["open"]>[1],
					) =>
						Effect.map(fs.open(file, options), (handle) => ({
							...handle,
							sync: handle.sync,
							writeAll: (bytes: Uint8Array) =>
								Effect.gen(function* () {
									if (
										path.dirname(file) ===
											path.join(directory, "diagnostics") &&
										(yield* Ref.get(failing))
									) {
										yield* handle.writeAll(bytes.slice(0, 12))
										yield* Deferred.succeed(attempted, undefined)
										return yield* PlatformError.systemError({
											_tag: "Unknown",
											module: "FileSystem",
											method: "write",
											description: "Injected partial diagnostic write",
										})
									}
									yield* handle.writeAll(bytes)
								}),
						})),
				})),
			).pipe(Layer.provideMerge(NodeServices.layer))
			const dependencies = Layer.mergeAll(
				failingFiles,
				Digest.layerWebCrypto,
				SecureRandom.layerWebCrypto,
				Layer.succeed(
					Recorder,
					Recorder.of({
						register: () => Effect.void,
						records: Stream.make(record),
						acknowledge: () =>
							Deferred.succeed(acknowledged, undefined).pipe(Effect.asVoid),
					}),
				),
			)
			yield* Effect.gen(function* () {
				const fork = yield* Graft.plugin(plugin, {
					recorder: "release",
					directory,
					diagnosticRetention: "1 hour",
				})
				yield* fork.await
				yield* Deferred.await(attempted)
				const premature = yield* Deferred.isDone(acknowledged)
				assert.isFalse(premature)
				const absent = yield* Journal.history(directory)
				assert.deepStrictEqual(absent, [])
				yield* Ref.set(failing, false)
				yield* TestClock.adjust("1 second")
				yield* Deferred.await(acknowledged)
				const history = yield* Journal.history(directory)
				assert.equal(history[0]!.diagnostic, "Sensitive cause")
				assert.equal(history[0]!.diagnosticStatus, "Available")
			}).pipe(
				Effect.scoped,
				Effect.provide(Graft.layer.pipe(Layer.provideMerge(dependencies))),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
