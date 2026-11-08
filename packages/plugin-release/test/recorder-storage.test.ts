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
import type { RecordDuty, RecoveredRecords } from "@graftland/graft/Kernel"
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
				id: "prior/run-1/change-1/Conclusion",
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
					key: Option.none(),
					request: "A normalized request",
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
				assert.equal(Journal.fromDuty(record).id, "run-1/change-1/Conclusion")
			}).pipe(
				Effect.scoped,
				Effect.provide(Graft.layer.pipe(Layer.provideMerge(dependencies))),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"registers journaled keys and unfinished Intents from every run, including compacted segments",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const entry = (
				run: string,
				change: string,
				stage: Journal.Line["stage"],
				key: string | null,
			): Journal.Line => ({
				id: `${run}/${change}/${stage}`,
				run,
				change,
				stage,
				key,
				request: `Normalized request for ${change}`,
				content: `${run}/${change}/${stage}`,
				members: [change],
				targets: [],
				outcome: null,
				facts: [],
				phase: stage === "Conclusion" ? "Interrupted" : "Starting",
				diagnostic: "",
			})
			yield* Effect.scoped(
				Effect.gen(function* () {
					const journal = yield* Journal.open(directory, { segmentBytes: 1 })
					for (const line of [
						entry("earlier", "finished", "Intent", "finished-key"),
						entry("earlier", "finished", "Conclusion", null),
						entry("another", "working", "Intent", "working-key"),
						entry("another", "working", "Commit", "working-key"),
						entry("third", "unkeyed", "Intent", null),
						entry("third", "orphan", "Commit", "orphan-key"),
					])
						yield* journal.append(line)
					const compacted = yield* journal.compact
					assert.equal(compacted, 2)
				}),
			)
			const registered = yield* Deferred.make<RecoveredRecords | undefined>()
			const recording = Layer.succeed(
				Recorder,
				Recorder.of({
					register: (_name, recovered) =>
						Deferred.succeed(registered, recovered).pipe(Effect.asVoid),
					records: Stream.empty,
					acknowledge: () => Effect.void,
				}),
			)
			yield* Effect.gen(function* () {
				const fork = yield* Graft.plugin(plugin, {
					recorder: "release",
					directory,
				})
				yield* fork.await
				const recovered = yield* Deferred.await(registered)
				assert.deepStrictEqual(recovered, {
					keys: [
						{
							key: "finished-key",
							request: "Normalized request for finished",
							run: "earlier",
							change: "finished",
						},
						{
							key: "working-key",
							request: "Normalized request for working",
							run: "another",
							change: "working",
						},
					],
					unfinished: [
						{ run: "another", change: "working", members: ["working"] },
						{ run: "third", change: "unkeyed", members: ["unkeyed"] },
					],
				})
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Graft.layer.pipe(
						Layer.provideMerge(
							Layer.mergeAll(
								NodeServices.layer,
								Digest.layerWebCrypto,
								SecureRandom.layerWebCrypto,
								recording,
							),
						),
					),
				),
			)
		}).pipe(
			Effect.scoped,
			Effect.provide([
				NodeServices.layer,
				Digest.layerWebCrypto,
				SecureRandom.layerWebCrypto,
			]),
		),
)

it.effect("registers an in-memory recorder without recovered records", () =>
	Effect.gen(function* () {
		const registered = yield* Deferred.make<RecoveredRecords | undefined>()
		const recording = Layer.succeed(
			Recorder,
			Recorder.of({
				register: (_name, recovered) =>
					Deferred.succeed(registered, recovered).pipe(Effect.asVoid),
				records: Stream.empty,
				acknowledge: () => Effect.void,
			}),
		)
		yield* Effect.gen(function* () {
			const fork = yield* Graft.plugin(plugin, { recorder: "release" })
			yield* fork.await
			const recovered = yield* Deferred.await(registered)
			assert.isUndefined(recovered)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Graft.layer.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							NodeServices.layer,
							Digest.layerWebCrypto,
							SecureRandom.layerWebCrypto,
							recording,
						),
					),
				),
			),
		)
	}),
)
