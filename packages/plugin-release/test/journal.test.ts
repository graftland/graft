import {
	Array,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	PlatformError,
	Ref,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Journal from "../src/Journal"

const line = (
	change: string,
	stage: Journal.Line["stage"],
	outcome: string | null = null,
	run = "run-1",
): Journal.Line => ({
	id: `${run}/${change}/${stage}`,
	run,
	change,
	stage,
	content: `${change}|${stage}|${outcome ?? ""}`,
	members: ["a"],
	targets: ["a=next"],
	outcome,
	facts: [
		{
			instance: "a",
			desired: "next",
			actual: stage === "Intent" ? "old" : "next",
			healthy: true,
			attempt: stage === "Intent" ? "NotStarted" : "Ready",
		},
	],
	phase: stage === "Conclusion" ? "Concluded" : "Resolving",
	diagnostic: "",
})
const scratch = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = yield* fs.makeTempDirectoryScoped()
	return { fs, path, directory: path.join(root, "journal") }
})

it.effect(
	"interleaves concurrent Changes, survives reopening and summarizes each Change by id (C4)",
	() =>
		Effect.gen(function* () {
			const { directory } = yield* scratch
			yield* Effect.scoped(
				Effect.gen(function* () {
					const journal = yield* Journal.open(directory)
					for (const next of [
						line("change-1", "Intent"),
						line("change-2", "Intent"),
						line("change-1", "Commit"),
						line("change-1", "Conclusion", "Accepted"),
					]) {
						const appended = yield* journal.append(next)
						assert.equal(appended, "Appended")
					}
				}),
			)
			const history = yield* Journal.history(directory)
			assert.deepStrictEqual(
				Array.map(history, (s) => [s.change, s.stages, s.concluded]),
				[
					["change-1", ["Intent", "Commit", "Conclusion"], true],
					["change-2", ["Intent"], false],
				],
			)
			assert.isTrue(Option.contains(history[0]!.outcome, "Accepted"))
			assert.deepStrictEqual(
				Array.map(history[0]!.facts, (f) => [f.instance, f.actual, f.attempt]),
				[["a", "next", "Ready"]],
			)
			assert.equal(history[1]!.facts[0]!.attempt, "NotStarted")
			const reopened = yield* Effect.scoped(
				Effect.flatMap(Journal.open(directory), (journal) => journal.lines),
			)
			assert.lengthOf(reopened, 4)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"acknowledges a repeat without a second line and refuses the same id with other content",
	() =>
		Effect.gen(function* () {
			const { directory } = yield* scratch
			yield* Effect.scoped(
				Effect.gen(function* () {
					const journal = yield* Journal.open(directory)
					yield* journal.append(line("change-1", "Intent"))
					const repeated = yield* journal.append(line("change-1", "Intent"))
					assert.equal(repeated, "Present")
					const conflict = yield* Effect.flip(
						journal.append({ ...line("change-1", "Intent"), content: "other" }),
					)
					assert.equal(conflict.reason, "Conflict")
					const observed2 = yield* journal.lines
					assert.lengthOf(observed2, 1)
				}),
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"truncates a torn final line on open and refuses corruption before the tail",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* scratch
			yield* Effect.scoped(
				Effect.flatMap(Journal.open(directory), (journal) =>
					journal.append(line("change-1", "Intent")),
				),
			)
			const segment = path.join(directory, "segment-000001.jsonl")
			const intact = yield* fs.readFileString(segment)
			yield* fs.writeFileString(segment, intact + '{"id":"change-1/Com')
			const observed3 = yield* Journal.history(directory)
			assert.lengthOf(observed3, 1)
			const recovered = yield* Effect.scoped(
				Effect.map(Journal.open(directory), (journal) => journal.recovered),
			)
			assert.isAbove(recovered.truncated, 0)
			const observed4 = yield* fs.readFileString(segment)
			assert.equal(observed4, intact)
			yield* fs.writeFileString(segment, "not json\n" + intact)
			const corrupt = yield* Effect.flip(Journal.history(directory))
			assert.equal(corrupt.reason, "Corrupt")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect(
	"starts a new segment at the size limit and keeps the order across segments",
	() =>
		Effect.gen(function* () {
			const { fs, directory } = yield* scratch
			yield* Effect.scoped(
				Effect.gen(function* () {
					const journal = yield* Journal.open(directory, { segmentBytes: 200 })
					for (const stage of ["Intent", "Commit", "Conclusion"] as const)
						yield* journal.append(
							line(
								"change-1",
								stage,
								stage === "Conclusion" ? "Accepted" : null,
							),
						)
				}),
			)
			assert.isAbove((yield* fs.readDirectory(directory)).length, 1)
			const history = yield* Journal.history(directory)
			assert.deepStrictEqual(history[0]!.stages, [
				"Intent",
				"Commit",
				"Conclusion",
			])
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

/** A file system whose handle sync fails while `failing` is true. */
const flakySync = (failing: Ref.Ref<boolean>) =>
	Layer.effect(
		FileSystem.FileSystem,
		Effect.map(FileSystem.FileSystem, (fs) => ({
			...fs,
			open: (
				file: string,
				options?: Parameters<FileSystem.FileSystem["open"]>[1],
			) =>
				Effect.map(fs.open(file, options), (handle) => ({
					...handle,
					// Handle methods live on its prototype, so forward the one the journal writes with.
					writeAll: (bytes: Uint8Array) => handle.writeAll(bytes),
					sync: Effect.flatMap(Ref.get(failing), (fail) =>
						fail
							? Effect.fail(
									PlatformError.systemError({
										_tag: "Unknown",
										module: "FileSystem",
										method: "sync",
										description: "Injected fsync failure",
									}),
								)
							: handle.sync,
					),
				})),
		})),
	).pipe(Layer.provideMerge(NodeServices.layer))

it.effect(
	"reports a failed fsync as a storage failure and acknowledges the retried record once (C4)",
	() =>
		Effect.gen(function* () {
			const failing = yield* Ref.make(false)
			yield* Effect.gen(function* () {
				const { directory } = yield* scratch
				const journal = yield* Journal.open(directory)
				yield* Ref.set(failing, true)
				const failed = yield* Effect.flip(
					journal.append(line("change-1", "Intent")),
				)
				assert.equal(failed.reason, "Storage")
				const observed5 = yield* journal.lines
				assert.lengthOf(observed5, 0)
				yield* Ref.set(failing, false)
				yield* journal.append(line("change-1", "Intent"))
				const reopened = yield* Effect.scoped(
					Effect.flatMap(Journal.open(directory), (j) => j.lines),
				)
				assert.isAtLeast(reopened.length, 1)
			}).pipe(Effect.provide(flakySync(failing)))
		}).pipe(Effect.scoped),
)

/** A file system whose next append writes only the first 12 bytes, then fails. */
const tornWrite = (tearing: Ref.Ref<boolean>) =>
	Layer.effect(
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
						Effect.flatMap(Ref.getAndSet(tearing, false), (tear) =>
							tear
								? handle.writeAll(bytes.slice(0, 12)).pipe(
										Effect.andThen(
											Effect.fail(
												PlatformError.systemError({
													_tag: "Unknown",
													module: "FileSystem",
													method: "write",
													description: "Injected partial write",
												}),
											),
										),
									)
								: handle.writeAll(bytes),
						),
				})),
		})),
	).pipe(Layer.provideMerge(NodeServices.layer))

it.effect(
	"cuts a partial write back to the last acknowledged line before retrying (C4)",
	() =>
		Effect.gen(function* () {
			const tearing = yield* Ref.make(false)
			yield* Effect.gen(function* () {
				const { directory } = yield* scratch
				yield* Effect.scoped(
					Effect.gen(function* () {
						const journal = yield* Journal.open(directory)
						yield* journal.append(line("change-1", "Intent"))
						yield* Ref.set(tearing, true)
						const failed = yield* Effect.flip(
							journal.append(line("change-1", "Commit")),
						)
						assert.equal(failed.reason, "Storage")
						const retried = yield* journal.append(line("change-1", "Commit"))
						assert.equal(retried, "Appended")
					}),
				)
				const history = yield* Journal.history(directory)
				assert.deepStrictEqual(history[0]!.stages, ["Intent", "Commit"])
			}).pipe(Effect.provide(tornWrite(tearing)))
		}).pipe(Effect.scoped),
)

it.effect(
	"keeps a Change id reused by a later kernel run apart from the earlier one (C4)",
	() =>
		Effect.gen(function* () {
			const { directory } = yield* scratch
			for (const run of ["run-1", "run-2"])
				yield* Effect.scoped(
					Effect.flatMap(Journal.open(directory), (journal) =>
						journal.append({
							...line("change-1", "Intent", null, run),
							content: `${run} plans other work`,
						}),
					),
				)
			const history = yield* Journal.history(directory)
			assert.deepStrictEqual(
				Array.map(history, (s) => [s.run, s.change]),
				[
					["run-1", "change-1"],
					["run-2", "change-1"],
				],
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
