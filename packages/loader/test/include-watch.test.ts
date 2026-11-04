import { assert, describe, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Option,
	Logger,
	MutableList,
	Path,
	Queue,
	Ref,
	Stream,
	Schema,
} from "effect"
import { TestClock } from "effect/testing"
import { parse } from "yaml"
import { Include, Loader } from "../src/index.ts"
import { echo, loaderService, run } from "./utils.ts"

const setupNotifications = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const file = path.join(directory, "graft.yml")
	const ready = yield* Deferred.make<void>()
	const events = yield* Queue.unbounded<FileSystem.WatchEvent>()
	const reads = yield* Ref.make(0)
	const readEvents = yield* Queue.unbounded<void>()
	yield* Graft.provide(FileSystem.FileSystem, {
		...fs,
		readFileString: (path, encoding) =>
			Ref.update(reads, (n) => n + 1).pipe(
				Effect.andThen(fs.readFileString(path, encoding)),
				Effect.tap(() => Queue.offer(readEvents, undefined)),
			),
		watch: (_, options) =>
			Stream.unwrap(
				Effect.sync(() => {
					options?.onReady?.()
					Deferred.doneUnsafe(ready, Effect.void)
					return Stream.fromQueue(events)
				}),
			),
	})
	yield* fs.writeFileString(
		file,
		"- id: a\n  name: echo\n  config: { text: original }\n",
	)
	yield* Graft.plugin(Include.Include, { path: file, watch: true })
	const loader = yield* loaderService
	yield* loader.ready
	yield* Deferred.await(ready)
	return {
		fs,
		file,
		loader,
		reads,
		readEvents,
		notify: Queue.offer(events, { _tag: "Update", path: file }),
	}
})

describe("include watcher serialization", () => {
	it.effect.each([
		"- [invalid\n",
		"- id: duplicate\n  name: echo\n- id: duplicate\n  name: echo\n",
	])(
		"recovers from an invalid initial document without replacing it: %s",
		(invalid) =>
			run((journal) => ({ echo: echo(journal) }))((journal) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = path.join(directory, "graft.yml")
					const ready = yield* Deferred.make<void>()
					const events = yield* Queue.unbounded<FileSystem.WatchEvent>()
					yield* Graft.provide(FileSystem.FileSystem, {
						...fs,
						watch: (_, options) =>
							Stream.unwrap(
								Effect.sync(() => {
									options?.onReady?.()
									Deferred.doneUnsafe(ready, Effect.void)
									return Stream.fromQueue(events)
								}),
							),
					})
					yield* fs.writeFileString(file, invalid)
					const failure = yield* Graft.logs.pipe(
						Stream.filter((entry) => Cause.hasFails(entry.cause)),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					)
					const included = yield* Graft.plugin(Include.Include, {
						path: file,
						watch: true,
					})
					yield* included.await
					const log = yield* Fiber.join(failure)
					const logged = Option.getOrThrow(log)
					assert(Option.isSome(Cause.findErrorOption(logged.cause)))
					const loader = yield* loaderService
					yield* Deferred.await(ready)
					const initialEntries = yield* loader.entries
					assert.deepStrictEqual(initialEntries, [])
					const edit = yield* Effect.exit(loader.create({ name: "echo" }))
					assert(Exit.isFailure(edit))
					const unchanged = yield* fs.readFileString(file)
					assert.strictEqual(unchanged, invalid)
					const changed = yield* loader.changes.pipe(
						Stream.filter((entries) => entries.length === 1),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					)
					yield* fs.writeFileString(
						file,
						"- name: echo\n  config: { text: recovered }\n",
					)
					yield* Queue.offer(events, { _tag: "Update", path: file })
					yield* TestClock.adjust("200 millis")
					yield* Fiber.join(changed)
					yield* loader.ready
					yield* journal.expect(["start recovered"])
					const entries = yield* loader.entries
					const text = yield* fs.readFileString(file)
					assert.deepStrictEqual(entries, parse(text))
				}),
			),
	)

	it.effect(
		"fails initial parsing without watch and preserves the original error",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = `${directory}/graft.yml`
					yield* fs.writeFileString(file, "- [invalid\n")
					const included = yield* Graft.plugin(Include.Include, { path: file })
					const result = yield* Effect.exit(included.await)
					assert(Exit.isFailure(result))
					const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
					assert(error.pipe(Schema.is(Loader.StoreError)))
					assert.instanceOf(error.cause, Error)
				}),
			),
	)

	it.effect(
		"serializes a watcher refresh with an API edit waiting to run",
		() =>
			run((journal) => ({ echo: echo(journal) }))(() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const directory = yield* fs.makeTempDirectoryScoped()
					const file = path.join(directory, "graft.yml")
					const captured = yield* Deferred.make<void>()
					const release = yield* Deferred.make<void>()
					const watching = yield* Deferred.make<void>()
					const pause = yield* Ref.make(false)
					yield* Graft.provide(FileSystem.FileSystem, {
						...fs,
						readFileString: (name, encoding) =>
							Effect.gen(function* () {
								const text = yield* fs.readFileString(name, encoding)
								if (yield* Ref.getAndSet(pause, false)) {
									yield* Deferred.succeed(captured, undefined)
									yield* Deferred.await(release)
								}
								return text
							}),
						watch: (_, options) =>
							Stream.unwrap(
								Effect.sync(() => {
									options?.onReady?.()
									Deferred.doneUnsafe(watching, Effect.void)
									return Stream.never
								}),
							),
					})
					yield* fs.writeFileString(
						file,
						"- id: a\n  name: echo\n  config: { text: original }\n",
					)
					yield* Graft.plugin(Include.Include, { path: file, watch: true })
					const loader = yield* loaderService
					yield* loader.ready
					yield* Deferred.await(watching)
					const observed = yield* loader.changes.pipe(
						Stream.take(3),
						Stream.runCollect,
						Effect.forkChild({ startImmediately: true }),
					)
					yield* fs.writeFileString(
						file,
						"- id: a\n  name: echo\n  config: { text: external }\n",
					)
					yield* Ref.set(pause, true)
					yield* TestClock.adjust("100 millis")
					yield* Deferred.await(captured)
					// The edit must wait for the watcher to finish reading and synchronizing.
					const edit = yield* loader
						.create({ id: "b", name: "echo", disabled: true })
						.pipe(Effect.forkChild({ startImmediately: true }))
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(edit)
					const snapshots = yield* Fiber.join(observed)
					assert.deepStrictEqual(
						Array.map(snapshots, (entries) =>
							Array.map(entries, (entry) => entry.id),
						),
						[["a"], ["a"], ["a", "b"]],
					)
					const persisted = yield* Effect.map(fs.readFileString(file), parse)
					const entries = yield* loader.entries
					assert.deepStrictEqual(entries, persisted)
				}),
			),
	)

	it.effect(
		"refreshes an external edit after an API operation fails validation",
		() =>
			run((journal) => ({ echo: echo(journal) }))((journal) =>
				Effect.gen(function* () {
					const { fs, file, loader } = yield* setupNotifications
					yield* fs.writeFileString(
						file,
						"- id: a\n  name: echo\n  config: { text: external }\n",
					)
					const failed = yield* Effect.exit(loader.remove("missing"))
					assert(Exit.isFailure(failed))
					const observed = yield* loader.changes.pipe(
						Stream.drop(1),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					)
					yield* TestClock.adjust("100 millis")
					yield* Fiber.join(observed)
					yield* loader.ready
					yield* journal.expect([
						"start original",
						"stop original",
						"start external",
					])
					const entries = yield* loader.entries
					const disk = yield* Effect.map(fs.readFileString(file), parse)
					assert.deepStrictEqual(entries, disk)
				}),
			),
	)

	it.effect(
		"retains the last valid tree after a failed refresh and accepts the next notification",
		() =>
			run((journal) => ({ echo: echo(journal) }))((journal) =>
				Effect.gen(function* () {
					const { fs, file, loader, notify } = yield* setupNotifications
					const before = yield* loader.entries
					yield* fs.writeFileString(file, "- [invalid\n")
					const failure = yield* Graft.logs.pipe(
						Stream.filter(
							(entry) =>
								Array.isArray(entry.message) &&
								Array.contains(
									entry.message,
									"Refreshing loader entries failed",
								),
						),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					)
					yield* TestClock.adjust("100 millis")
					const result = yield* Fiber.join(failure)
					const logged = Option.getOrThrow(result)
					assert(Option.isSome(Cause.findErrorOption(logged.cause)))
					const after = yield* loader.entries
					assert.deepStrictEqual(after, before)
					const invalid = yield* fs.readFileString(file)
					assert.strictEqual(invalid, "- [invalid\n")
					const observed = yield* loader.changes.pipe(
						Stream.drop(1),
						Stream.runHead,
						Effect.forkChild({ startImmediately: true }),
					)
					yield* fs.writeFileString(
						file,
						"- name: echo\n  config: { text: recovered }\n",
					)
					yield* notify
					yield* TestClock.adjust("100 millis")
					yield* Fiber.join(observed)
					yield* loader.ready
					yield* journal.expect([
						"start original",
						"stop original",
						"start recovered",
					])
					const disk = yield* Effect.map(fs.readFileString(file), parse)
					const entries = yield* loader.entries
					assert.deepStrictEqual(entries, disk)
					assert.isString(entries[0]?.id)
				}),
			),
	)
})

it.effect(
	"coalesces a notification burst into one read after the quiet period",
	() =>
		run((journal) => ({ echo: echo(journal) }))(() =>
			Effect.gen(function* () {
				const { notify, reads, readEvents } = yield* setupNotifications
				yield* TestClock.adjust("100 millis")
				yield* Queue.take(readEvents)
				yield* Queue.take(readEvents)
				yield* Ref.set(reads, 0)
				for (let index = 0; index < 20; index++) yield* notify
				// Settle the producer handoff before measuring the quiet period.
				yield* TestClock.adjust("0 millis")
				yield* TestClock.adjust("99 millis")
				const checked1 = yield* Ref.get(reads)

				assert.strictEqual(checked1, 0)
				yield* notify
				// Settle the producer handoff before measuring the quiet period.
				yield* TestClock.adjust("0 millis")
				yield* TestClock.adjust("99 millis")
				const checked2 = yield* Ref.get(reads)

				assert.strictEqual(checked2, 0)
				yield* TestClock.adjust("1 millis")
				yield* Queue.take(readEvents)
				const checked3 = yield* Ref.get(reads)

				assert.strictEqual(checked3, 1)
				yield* TestClock.adjust("1 second")
				const checked4 = yield* Ref.get(reads)

				assert.strictEqual(checked4, 1)
			}),
		),
)

it.effect(
	"logs the complete native watcher cleanup cause before merge discards it",
	() =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				yield* fs.writeFileString(file, "[]")
				const ready = yield* Deferred.make<void>()
				const marker = new Error("watcher cleanup failed")
				const logs = MutableList.make<Logger.Options<unknown>>()
				yield* Graft.provide(FileSystem.FileSystem, {
					...fs,
					watch: (_, options) =>
						Stream.unwrap(
							Effect.gen(function* () {
								yield* Effect.addFinalizer(() => Effect.die(marker))
								options?.onReady?.()
								yield* Deferred.succeed(ready, undefined)
								return Stream.never
							}),
						),
				})
				yield* Effect.gen(function* () {
					const fork = yield* Graft.plugin(Include.Include, {
						path: file,
						watch: true,
					})
					yield* fork.await
					yield* Deferred.await(ready)
					yield* fork.dispose
				}).pipe(
					Effect.provide(
						Logger.layer([
							Logger.make((entry) => {
								MutableList.append(logs, entry)
							}),
						]),
					),
				)
				assert.isTrue(
					Array.some(MutableList.toArray(logs), (log) =>
						Array.some(
							log.cause.reasons,
							(reason) => reason._tag === "Die" && reason.defect === marker,
						),
					),
				)
			}),
		),
)

it.effect("logs pure interruption from a native watcher finalizer", () =>
	run(() => ({}))(() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = `${directory}/graft.yml`
			yield* fs.writeFileString(file, "[]")
			const ready = yield* Deferred.make<void>()

			const logs = MutableList.make<Logger.Options<unknown>>()
			yield* Graft.provide(FileSystem.FileSystem, {
				...fs,
				watch: (_, options) =>
					Stream.unwrap(
						Effect.gen(function* () {
							yield* Effect.addFinalizer(() => Effect.interrupt)
							options?.onReady?.()
							yield* Deferred.succeed(ready, undefined)
							return Stream.never
						}),
					),
			})
			yield* Effect.gen(function* () {
				const fork = yield* Graft.plugin(Include.Include, {
					path: file,
					watch: true,
				})
				yield* fork.await
				yield* Deferred.await(ready)
				yield* fork.dispose
			}).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make((entry) => {
							MutableList.append(logs, entry)
						}),
					]),
				),
			)
			assert.isTrue(
				Array.some(MutableList.toArray(logs), (log) =>
					Cause.hasInterruptsOnly(log.cause),
				),
			)
		}),
	),
)
