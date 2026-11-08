import {
	Array,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	PlatformError,
	Ref,
	String,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Journal from "../src/Journal"

const services = Layer.mergeAll(
	NodeServices.layer,
	Digest.layerWebCrypto,
	SecureRandom.layerWebCrypto,
)

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
		}).pipe(Effect.scoped, Effect.provide(services)),
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
		}).pipe(Effect.scoped, Effect.provide(services)),
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
		}).pipe(Effect.scoped, Effect.provide(services)),
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
		}).pipe(Effect.scoped, Effect.provide(services)),
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
	).pipe(Layer.provideMerge(services))

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
	).pipe(Layer.provideMerge(services))

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
		}).pipe(Effect.scoped, Effect.provide(services)),
)

it.effect(
	"retains the full cause separately and expires it without losing the durable outcome",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* scratch
			const journal = yield* Journal.open(directory, {
				diagnosticRetention: "2 hours",
			})
			const cause = String.repeat(400)("Sensitive failure details. ")
			const record = {
				...line("failed", "Conclusion", "Failed"),
				content: cause,
				diagnostic: cause,
			}
			yield* journal.append(record)
			const stored = yield* fs.readFileString(
				path.join(directory, "segment-000001.jsonl"),
			)
			assert.notInclude(stored, "Sensitive failure details")
			const before = (yield* Journal.history(directory))[0]!
			assert.equal(before.diagnostic, cause)
			assert.equal(before.diagnosticStatus, "Available")
			const reference = Option.getOrThrow(before.diagnosticReference)
			const file = path.join(directory, "diagnostics", `${reference.id}.json`)
			const observed11 = yield* fs.exists(file)
			assert.isTrue(observed11)
			yield* TestClock.adjust("2 hours")
			const expired = (yield* Journal.history(directory))[0]!
			assert.equal(expired.diagnosticStatus, "Expired")
			assert.equal(expired.diagnostic, "Diagnostic expired")
			assert.deepStrictEqual(
				expired.diagnosticReference,
				before.diagnosticReference,
			)
			assert.deepStrictEqual(expired.facts, before.facts)
			yield* journal.prune
			const observed12 = yield* fs.exists(file)
			assert.isFalse(observed12)
			const observed13 = yield* journal.append(record)
			assert.equal(observed13, "Present")
			const reopened = yield* Journal.open(directory)
			const observed14 = yield* reopened.append(record)
			assert.equal(observed14, "Present")
		}).pipe(Effect.scoped, Effect.provide(services)),
)

it.effect(
	"defaults diagnostic retention to thirty days and removes expired files when reopened",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* scratch
			const record = {
				...line("failed", "Conclusion", "Failed"),
				diagnostic: "A complete cause",
			}
			const journal = yield* Journal.open(directory)
			yield* journal.append(record)
			yield* TestClock.adjust("29 days")
			assert.equal(
				(yield* Journal.history(directory))[0]!.diagnosticStatus,
				"Available",
			)
			yield* TestClock.adjust("1 day")
			yield* Journal.open(directory)
			const observed15 = yield* fs.readDirectory(
				path.join(directory, "diagnostics"),
			)
			assert.deepStrictEqual(observed15, [])
			assert.equal(
				(yield* Journal.history(directory))[0]!.diagnosticStatus,
				"Expired",
			)
		}).pipe(Effect.scoped, Effect.provide(services)),
)

it.effect(
	"compacts concluded closed segments while preserving interleaved history and the open segment",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* scratch
			const journal = yield* Journal.open(directory, { segmentBytes: 1 })
			const records = [
				line("a", "Intent"),
				line("b", "Intent"),
				line("a", "Commit"),
				{
					...line("b", "Conclusion", "Failed"),
					diagnostic: "A retained cause",
				},
				line("a", "Conclusion", "Accepted"),
				line("unfinished", "Intent"),
				line("open", "Intent"),
			]
			for (const record of records) yield* journal.append(record)
			const open = path.join(directory, "segment-000007.jsonl")
			const untouched = yield* fs.readFileString(open)
			const before = yield* Journal.history(directory)
			const observed16 = yield* journal.compact
			assert.equal(observed16, 5)
			const observed17 = yield* Journal.history(directory)
			assert.deepStrictEqual(observed17, before)
			const observed18 = yield* fs.readFileString(open)
			assert.equal(observed18, untouched)
			const observed19 = yield* fs.exists(
				path.join(directory, "segment-000006.jsonl"),
			)
			assert.isTrue(observed19)
			const observed20 = yield* journal.compact
			assert.equal(observed20, 0)
			const reopened = yield* Journal.open(directory, { segmentBytes: 1 })
			for (const record of records) {
				const observed21 = yield* reopened.append(record)
				assert.equal(observed21, "Present")
			}
			yield* reopened.append(line("unfinished", "Conclusion", "Accepted"))
			const extended = yield* Journal.history(directory)
			const observed22 = yield* reopened.compact
			assert.equal(observed22, 2)
			const observed23 = yield* Journal.history(directory)
			assert.deepStrictEqual(observed23, extended)
		}).pipe(Effect.scoped, Effect.provide(services)),
)

interface Fault {
	readonly enabled: boolean
	readonly at: number
	readonly after: boolean
	readonly steps: ReadonlyArray<string>
}
const injected = (method: string) =>
	PlatformError.systemError({
		_tag: "Unknown",
		module: "FileSystem",
		method,
		description: "Injected crash boundary",
	})
/** Real files with a failure before or after each write, sync, rename and source removal. */
const crashFileSystem = (fault: Ref.Ref<Fault>) =>
	Layer.effect(
		FileSystem.FileSystem,
		Effect.map(FileSystem.FileSystem, (fs) => {
			const step = Effect.fnUntraced(function* <A, R>(
				name: string,
				effect: Effect.Effect<A, PlatformError.PlatformError, R>,
			) {
				const state = yield* Ref.get(fault)
				if (!state.enabled) return yield* effect
				const next = yield* Ref.updateAndGet(fault, (s) => ({
					...s,
					steps: Array.append(s.steps, name),
				}))
				const fail = next.steps.length === next.at
				if (fail && !next.after) return yield* injected(name)
				const result = yield* effect
				if (fail && next.after) return yield* injected(name)
				return result
			})
			return {
				...fs,
				open: (
					file: string,
					options?: Parameters<FileSystem.FileSystem["open"]>[1],
				) =>
					step(`open ${file}`, fs.open(file, options)).pipe(
						Effect.map((handle) => ({
							...handle,
							writeAll: (bytes: Uint8Array) =>
								step(`write ${file}`, handle.writeAll(bytes)),
							sync: step(`sync ${file}`, handle.sync),
						})),
					),
				rename: (from: string, to: string) =>
					step(`rename ${from}`, fs.rename(from, to)),
				remove: (
					file: string,
					options?: Parameters<FileSystem.FileSystem["remove"]>[1],
				) => step(`remove ${file}`, fs.remove(file, options)),
			}
		}),
	).pipe(Layer.provideMerge(services))

const compactionFixture = Effect.fnUntraced(function* () {
	const f = yield* scratch
	const journal = yield* Journal.open(f.directory, { segmentBytes: 1 })
	for (const record of [
		line("a", "Intent"),
		line("a", "Commit"),
		line("a", "Conclusion", "Accepted"),
		line("open", "Intent"),
	])
		yield* journal.append(record)
	return { ...f, journal, before: yield* Journal.history(f.directory) }
})

it.effect(
	"recovers the complete old or new history at every compaction crash boundary",
	() =>
		Effect.gen(function* () {
			const fault = yield* Ref.make<Fault>({
				enabled: false,
				at: -1,
				after: false,
				steps: [],
			})
			yield* Effect.gen(function* () {
				const baseline = yield* compactionFixture()
				yield* Ref.set(fault, {
					enabled: true,
					at: -1,
					after: false,
					steps: [],
				})
				const observed24 = yield* baseline.journal.compact
				assert.equal(observed24, 3)
				const steps = (yield* Ref.get(fault)).steps
				const operations = Array.map(steps, (s) => String.split(" ")(s)[0])
				assert.deepStrictEqual(operations, [
					"open",
					"write",
					"sync",
					"rename",
					"open",
					"sync",
					"remove",
					"remove",
					"remove",
					"open",
					"sync",
				])
				for (const after of [false, true]) {
					for (const at of Array.range(1, steps.length)) {
						yield* Ref.set(fault, { enabled: false, at, after, steps: [] })
						const f = yield* compactionFixture()
						const open = f.path.join(f.directory, "segment-000004.jsonl")
						const untouched = yield* f.fs.readFileString(open)
						yield* Ref.set(fault, { enabled: true, at, after, steps: [] })
						const failure = yield* Effect.flip(f.journal.compact)
						assert.equal(
							failure.reason,
							"Storage",
							`Boundary ${at}, after=${after}`,
						)
						yield* Ref.update(fault, (s) => ({ ...s, enabled: false }))
						const observed25 = yield* Journal.history(f.directory)
						assert.deepStrictEqual(observed25, f.before)
						const observed26 = yield* f.fs.readFileString(open)
						assert.equal(observed26, untouched)
						const reopened = yield* Journal.open(f.directory, {
							segmentBytes: 1,
						})
						yield* reopened.compact
						const observed27 = yield* Journal.history(f.directory)
						assert.deepStrictEqual(observed27, f.before)
						const observed28 = yield* reopened.append(line("a", "Intent"))
						assert.equal(observed28, "Present")
						yield* reopened.append(line("open", "Conclusion", "Accepted"))
						assert.isTrue((yield* Journal.history(f.directory))[1]!.concluded)
					}
				}
			}).pipe(Effect.provide(crashFileSystem(fault)))
		}).pipe(Effect.scoped),
)

it.effect(
	"leaves a diagnostic write or sync failure unacknowledged and retries without a corrupt diagnostic",
	() =>
		Effect.gen(function* () {
			const fault = yield* Ref.make<Fault>({
				enabled: false,
				at: -1,
				after: false,
				steps: [],
			})
			yield* Effect.gen(function* () {
				for (const at of Array.range(1, 7)) {
					const { fs, path, directory } = yield* scratch
					const journal = yield* Journal.open(directory, {
						diagnosticRetention: "1 hour",
					})
					const record = {
						...line("a", "Conclusion", "Failed"),
						diagnostic: "Sensitive cause",
					}
					yield* Ref.set(fault, { enabled: true, at, after: false, steps: [] })
					const failed = yield* Effect.flip(journal.append(record))
					assert.equal(failed.reason, "Storage")
					const observed29 = yield* journal.lines
					assert.deepStrictEqual(observed29, [])
					const observed30 = yield* fs.exists(
						path.join(directory, "segment-000001.jsonl"),
					)
					assert.isFalse(observed30)
					yield* Ref.update(fault, (s) => ({ ...s, enabled: false }))
					const observed31 = yield* journal.append(record)
					assert.equal(observed31, "Appended")
					assert.equal(
						(yield* Journal.history(directory))[0]!.diagnostic,
						"Sensitive cause",
					)
					yield* TestClock.adjust("1 hour")
					yield* journal.prune
					const observed32 = yield* fs.readDirectory(
						path.join(directory, "diagnostics"),
					)
					assert.deepStrictEqual(observed32, [])
				}
			}).pipe(Effect.provide(crashFileSystem(fault)))
		}).pipe(Effect.scoped),
)

it.effect(
	"retries failed diagnostic expiry removal while history still reports the retained outcome",
	() =>
		Effect.gen(function* () {
			const fault = yield* Ref.make<Fault>({
				enabled: false,
				at: -1,
				after: false,
				steps: [],
			})
			yield* Effect.gen(function* () {
				const { fs, path, directory } = yield* scratch
				const journal = yield* Journal.open(directory, {
					diagnosticRetention: "1 hour",
				})
				yield* journal.append({
					...line("a", "Conclusion", "Failed"),
					diagnostic: "A cause to expire",
				})
				const before = (yield* Journal.history(directory))[0]!
				const reference = Option.getOrThrow(before.diagnosticReference)
				const file = path.join(directory, "diagnostics", `${reference.id}.json`)
				yield* TestClock.adjust("1 hour")
				yield* Ref.set(fault, { enabled: true, at: 1, after: false, steps: [] })
				const error = yield* Effect.flip(journal.prune)
				assert.equal(error.reason, "Storage")
				assert.isDefined(error.cause)
				const remains = yield* fs.exists(file)
				assert.isTrue(remains)
				const expired = (yield* Journal.history(directory))[0]!
				assert.equal(expired.diagnosticStatus, "Expired")
				assert.deepStrictEqual(expired.facts, before.facts)
				yield* Ref.update(fault, (s) => ({ ...s, enabled: false }))
				yield* journal.prune
				const removed = yield* fs.exists(file)
				assert.isFalse(removed)
			}).pipe(Effect.provide(crashFileSystem(fault)))
		}).pipe(Effect.scoped),
)

it.effect(
	"finds a later compactable range beyond a lone concluded segment and an unfinished Change",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory } = yield* scratch
			const journal = yield* Journal.open(directory, { segmentBytes: 1 })
			for (const record of [
				line("a", "Conclusion", "Accepted"),
				line("unfinished", "Intent"),
				line("b", "Intent"),
				line("b", "Conclusion", "Accepted"),
				line("open", "Intent"),
			])
				yield* journal.append(record)
			const before = yield* Journal.history(directory)
			const count = yield* journal.compact
			assert.equal(count, 2)
			const history = yield* Journal.history(directory)
			assert.deepStrictEqual(history, before)
			const names = yield* fs.readDirectory(directory)
			assert.include(names, "compacted-3-4.jsonl")
			const untouched = yield* fs.exists(
				path.join(directory, "segment-000001.jsonl"),
			)
			assert.isTrue(untouched)
		}).pipe(Effect.scoped, Effect.provide(services)),
)

it.effect(
	"restarts a history read whose listed source segments are concurrently compacted",
	() =>
		Effect.gen(function* () {
			const f = yield* compactionFixture()
			const pending = yield* Ref.make(true)
			const racing: FileSystem.FileSystem = {
				...f.fs,
				readFileString: (file, encoding) =>
					Effect.gen(function* () {
						if (
							file === f.path.join(f.directory, "segment-000001.jsonl") &&
							(yield* Ref.getAndSet(pending, false))
						)
							yield* f.journal.compact.pipe(Effect.orDie)
						return yield* f.fs.readFileString(file, encoding)
					}),
			}
			const history = yield* Journal.history(f.directory).pipe(
				Effect.provideService(FileSystem.FileSystem, racing),
			)
			assert.deepStrictEqual(history, f.before)
			const untriggered = yield* Ref.get(pending)
			assert.isFalse(untriggered)
		}).pipe(Effect.scoped, Effect.provide(services)),
)
