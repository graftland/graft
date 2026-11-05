import {
	Array,
	ByteSize,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	HashMap,
	HashSet,
	Option,
	Order,
	PlatformError,
	Queue,
	Ref,
	Stream,
	String,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { changes } from "../src/internal/changes"
import { digest } from "../src/internal/digest"
import type { FileVersion } from "../src/internal/modules"

const version = (content: string | undefined, generation = 1): FileVersion => ({
	generation,
	content,
})

const setup = Effect.gen(function* () {
	const content = yield* Ref.make<
		Exit.Exit<Uint8Array, PlatformError.PlatformError>
	>(Exit.succeed(new Uint8Array([1])))
	const reads = yield* Ref.make<ReadonlyArray<string>>([])
	const closed = yield* Ref.make(false)
	const events = yield* Queue.unbounded<FileSystem.WatchEvent>()
	const fs = FileSystem.makeNoop({
		realPath: Effect.succeed,
		stat: () =>
			Effect.succeed({
				type: "Directory",
				size: ByteSize.bytes(0),
				dev: 0n,
				mode: 0,
				mtime: Option.none(),
				atime: Option.none(),
				birthtime: Option.none(),
				ino: Option.none(),
				nlink: Option.none(),
				uid: Option.none(),
				gid: Option.none(),
				rdev: Option.none(),
				blksize: Option.none(),
				blocks: Option.none(),
			}),
		readFile: (path) =>
			Ref.update(reads, Array.append(path)).pipe(
				Effect.andThen(Ref.get(content)),
				Effect.flatMap(
					(exit): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
						exit,
				),
			),
		watch: (_path, options) =>
			Stream.unwrap(
				Effect.addFinalizer(() => Ref.set(closed, true)).pipe(
					Effect.andThen(Effect.sync(() => options?.onReady?.())),
					Effect.as(Stream.fromQueue(events)),
				),
			),
	})
	const files = yield* Ref.make(
		HashMap.make([
			"file:///app/dependency.mjs",
			version(digest(new Uint8Array([1]))),
		]),
	)
	const ready = yield* Deferred.make<void>()
	const notifications = yield* Ref.make(0)
	const start = (
		paths = ["/app"],
		recursive = false,
		options: Pick<import("../src/index").WatchOptions, "filter"> = {},
	) =>
		changes((use) => Ref.get(files).pipe(Effect.flatMap(use)), paths, {
			...options,
			recursive,
			debounce: 0,
			onReady: () => Deferred.doneUnsafe(ready, Exit.void),
		}).pipe(
			Stream.runForEach(() => Ref.update(notifications, (n) => n + 1)),
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.forkScoped,
		)
	return {
		content,
		reads,
		closed,
		events,
		files,
		ready,
		notifications,
		start,
		fs,
	}
})

describe("watch reconciliation", () => {
	it.live("coalesces every dirty path in a native event burst", () =>
		Effect.gen(function* () {
			const { fs, files, content, events, ready } = yield* setup
			yield* Ref.update(
				files,
				HashMap.set(
					"file:///app/second.mjs",
					version(digest(new Uint8Array([1]))),
				),
			)
			const results = yield* Queue.unbounded<HashSet.HashSet<string>>()
			const delivered = yield* Queue.unbounded<void>()
			yield* changes(
				(use) => Ref.get(files).pipe(Effect.flatMap(use)),
				["/app"],
				{ onReady: () => Deferred.doneUnsafe(ready, Exit.void) },
			).pipe(
				Stream.runForEach((value) => Queue.offer(results, value)),
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					watch: (path, options) =>
						fs
							.watch(path, options)
							.pipe(Stream.tap(() => Queue.offer(delivered, undefined))),
				}),
				Effect.forkScoped,
			)
			yield* Deferred.await(ready)
			yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
			yield* Queue.offer(events, { _tag: "Update", path: "dependency.mjs" })
			yield* Queue.offer(events, { _tag: "Update", path: "second.mjs" })
			yield* Queue.take(delivered)
			yield* Queue.take(delivered)
			const changed = yield* Queue.take(results)
			assert.strictEqual(HashSet.size(changed), 2)
		}).pipe(Effect.scoped),
	)

	it.effect(
		"installs nonrecursive watches only for observed directories and missing ancestors",
		() =>
			Effect.gen(function* () {
				const { fs, files } = yield* setup
				yield* Ref.set(
					files,
					HashMap.make(
						[
							"file:///app/dist/plugin.mjs",
							version(digest(new Uint8Array([1]))),
						],
						["file:///app/missing/deep/helper.mjs", version(undefined)],
					),
				)
				const installed = yield* Queue.unbounded<{
					path: string
					recursive: boolean | undefined
				}>()
				yield* changes(
					(use) => Ref.get(files).pipe(Effect.flatMap(use)),
					["/app"],
					{ recursive: true },
				).pipe(
					Stream.runDrain,
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						stat: (path) =>
							String.startsWith("/app/missing")(path)
								? Effect.fail(
										PlatformError.systemError({
											_tag: "NotFound",
											module: "FileSystem",
											method: "stat",
											pathOrDescriptor: path,
										}),
									)
								: fs.stat(path),
						watch: (path, options) =>
							Stream.unwrap(
								Queue.offer(installed, {
									path,
									recursive: options?.recursive,
								}).pipe(Effect.as(Stream.never)),
							),
					}),
					Effect.forkScoped,
				)
				const first = yield* Queue.take(installed)
				const second = yield* Queue.take(installed)
				assert.deepStrictEqual(
					Array.sort([first.path, second.path], Order.String),
					["/app", "/app/dist"],
				)
				assert.strictEqual(first.recursive, false)
				assert.strictEqual(second.recursive, false)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"ignores native notifications for unchanged and unobserved files",
		() =>
			Effect.gen(function* () {
				const { start, ready, events, notifications, reads } = yield* setup
				yield* start()
				yield* Deferred.await(ready)
				yield* Queue.offer(events, { _tag: "Update", path: "unrelated.mjs" })
				yield* Queue.offer(events, { _tag: "Update", path: "dependency.mjs" })
				yield* TestClock.adjust("1 second")
				const count = yield* Ref.get(notifications)
				const paths = yield* Ref.get(reads)
				assert.strictEqual(count, 0)
				assert(Array.every(paths, (path) => path === "/app/dependency.mjs"))
			}).pipe(Effect.scoped),
	)

	it.effect(
		"uses stat between content audits and still detects silent same-stat writes",
		() =>
			Effect.gen(function* () {
				const { content, reads, ready, notifications, start } = yield* setup
				yield* start()
				yield* Deferred.await(ready)
				yield* TestClock.adjust("1 second")
				const first = yield* Ref.get(reads)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
				yield* TestClock.adjust("9 seconds")
				const result2 = yield* Ref.get(reads)
				assert.deepStrictEqual(result2, first)
				const result3 = yield* Ref.get(notifications)
				assert.strictEqual(result3, 0)
				yield* TestClock.adjust("1 second")
				const result4 = yield* Ref.get(notifications)
				assert.strictEqual(result4, 1)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"rejects an in-flight snapshot after its ownership token changes",
		() =>
			Effect.gen(function* () {
				const { fs, files, ready, content } = yield* setup
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const results = yield* Ref.make(0)
				yield* changes(
					(use) => Ref.get(files).pipe(Effect.flatMap(use)),
					["/app"],
					{ debounce: 0, onReady: () => Deferred.doneUnsafe(ready, Exit.void) },
				).pipe(
					Stream.runForEach(() => Ref.update(results, (n) => n + 1)),
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						readFile: (path) =>
							fs.readFile(path).pipe(
								Effect.tap(() => Deferred.succeed(entered, undefined)),
								Effect.tap(() => Deferred.await(release)),
							),
					}),
					Effect.forkScoped,
				)
				yield* Deferred.await(ready)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
				yield* TestClock.adjust("1 second")
				yield* Deferred.await(entered)
				yield* Ref.set(
					files,
					HashMap.make([
						"file:///app/dependency.mjs",
						version(digest(new Uint8Array([3])), 2),
					]),
				)
				yield* Deferred.succeed(release, undefined)
				yield* TestClock.adjust("1 second")
				const result5 = yield* Ref.get(results)
				assert.strictEqual(result5, 1)
			}).pipe(Effect.scoped),
	)

	it.effect("reconciles requested paths beneath a symlinked watch root", () =>
		Effect.gen(function* () {
			const { fs, content, ready, notifications } = yield* setup
			const files = HashMap.make([
				"file:///alias/dependency.mjs",
				version(digest(new Uint8Array([1]))),
			])
			const watching = yield* changes((use) => use(files), ["/alias"], {
				debounce: 0,
				onReady: () => Deferred.doneUnsafe(ready, Exit.void),
			}).pipe(
				Stream.runForEach(() => Ref.update(notifications, (n) => n + 1)),
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					realPath: (path) => Effect.succeed(path === "/alias" ? "/app" : path),
				}),
				Effect.forkScoped,
			)
			yield* Deferred.await(ready)
			yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
			yield* TestClock.adjust("1 second")
			const count = yield* Ref.get(notifications)
			assert.strictEqual(count, 1)
			yield* Fiber.interrupt(watching)
		}).pipe(Effect.scoped),
	)

	it.effect(
		"acknowledges failed attempts without repeatedly retrying unchanged files",
		() =>
			Effect.gen(function* () {
				const { content, files, ready, notifications, start } = yield* setup
				yield* start()
				yield* Deferred.await(ready)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
				yield* TestClock.adjust("1 second")
				// A failed candidate read these bytes. A new generation alone is not a change.
				yield* Ref.set(
					files,
					HashMap.make([
						"file:///app/dependency.mjs",
						version(digest(new Uint8Array([2])), 2),
					]),
				)
				yield* TestClock.adjust("3 seconds")
				const afterReadFailure = yield* Ref.get(notifications)
				assert.strictEqual(afterReadFailure, 1)
				// Resolution can fail before the hook reads a file at all. Its last observation
				// must stay acknowledged until another save, even across a new attempt.
				yield* Ref.set(
					files,
					HashMap.make(["file:///app/dependency.mjs", version(undefined, 3)]),
				)
				yield* TestClock.adjust("3 seconds")
				const afterResolveFailure = yield* Ref.get(notifications)
				assert.strictEqual(afterResolveFailure, 1)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([3])))
				yield* TestClock.adjust("10 seconds")
				const afterSave = yield* Ref.get(notifications)
				assert.strictEqual(afterSave, 2)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"reconciles newly available imported bytes within the same generation",
		() =>
			Effect.gen(function* () {
				const { content, files, ready, notifications, start } = yield* setup
				yield* Ref.set(
					files,
					HashMap.make(["file:///app/dependency.mjs", version(undefined)]),
				)
				yield* start()
				yield* Deferred.await(ready)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
				yield* TestClock.adjust("1 second")
				// A deferred native load read different bytes after the preceding snapshot.
				yield* Ref.set(
					files,
					HashMap.make([
						"file:///app/dependency.mjs",
						version(digest(new Uint8Array([3]))),
					]),
				)
				yield* TestClock.adjust("1 second")
				const count = yield* Ref.get(notifications)
				assert.strictEqual(count, 2)
				yield* TestClock.adjust("3 seconds")
				const afterQuietPeriod = yield* Ref.get(notifications)
				assert.strictEqual(afterQuietPeriod, 2)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"detects silent same-size writes, stays quiet when unchanged, and stops with its scope",
		() =>
			Effect.gen(function* () {
				const { content, reads, closed, ready, notifications, start } =
					yield* setup
				const watching = yield* start()
				yield* Deferred.await(ready)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
				yield* TestClock.adjust("1 second")
				const afterChange = yield* Ref.get(notifications)
				assert.strictEqual(afterChange, 1)
				yield* TestClock.adjust("2 seconds")
				const afterQuietPeriod = yield* Ref.get(notifications)
				assert.strictEqual(afterQuietPeriod, 1)
				yield* Fiber.interrupt(watching)
				const before = yield* Ref.get(reads)
				yield* TestClock.adjust("2 seconds")
				const readsAfterClose = yield* Ref.get(reads)
				assert.deepStrictEqual(readsAfterClose, before)
				const watcherClosed = yield* Ref.get(closed)
				assert.strictEqual(watcherClosed, true)
			}).pipe(Effect.scoped),
	)

	it.effect("advances the polling baseline when a native event arrives", () =>
		Effect.gen(function* () {
			const { content, events, ready, notifications, start } = yield* setup
			yield* start()
			yield* Deferred.await(ready)
			yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
			yield* Queue.offer(events, { _tag: "Update", path: "dependency.mjs" })
			yield* TestClock.adjust("2 seconds")
			const notificationCount = yield* Ref.get(notifications)
			assert.strictEqual(notificationCount, 1)
		}).pipe(Effect.scoped),
	)

	it.effect(
		"retains an event received while the downstream reload is suspended",
		() =>
			Effect.gen(function* () {
				const { content, events, files, fs, ready } = yield* setup
				const observed = yield* Queue.unbounded<void>()
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const reloads = yield* Ref.make(0)
				const watching = yield* changes(
					(use) => Ref.get(files).pipe(Effect.flatMap(use)),
					["/app"],
					{
						debounce: 0,
						onReady: () => Deferred.doneUnsafe(ready, Exit.void),
					},
				).pipe(
					Stream.tap(() => Queue.offer(observed, undefined)),
					Stream.debounce("50 millis"),
					Stream.mapEffect(() =>
						Effect.gen(function* () {
							const attempt = yield* Ref.updateAndGet(reloads, (n) => n + 1)
							if (attempt === 1) {
								yield* Deferred.succeed(entered, undefined)
								yield* Deferred.await(release)
							}
						}),
					),
					Stream.take(2),
					Stream.runDrain,
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.forkScoped,
				)
				yield* Deferred.await(ready)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
				yield* Queue.offer(events, { _tag: "Update", path: "dependency.mjs" })
				yield* Queue.take(observed)
				yield* TestClock.adjust("50 millis")
				yield* Deferred.await(entered)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([3])))
				yield* Queue.offer(events, { _tag: "Update", path: "dependency.mjs" })
				yield* Queue.take(observed)
				yield* TestClock.adjust("100 millis")
				yield* Deferred.succeed(release, undefined)
				yield* TestClock.adjust("100 millis")
				yield* Fiber.join(watching)
				const attempts = yield* Ref.get(reloads)
				assert.strictEqual(attempts, 2)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"does not reload merely because configuration loaded another module",
		() =>
			Effect.gen(function* () {
				const { files, ready, notifications, start } = yield* setup
				yield* start()
				yield* Deferred.await(ready)
				yield* Ref.update(
					files,
					HashMap.set(
						"file:///app/another.mjs",
						version(digest(new Uint8Array([1]))),
					),
				)
				yield* TestClock.adjust("1 second")
				const count = yield* Ref.get(notifications)
				assert.strictEqual(count, 0)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"filters native paths and reconciled files with the same absolute-path predicate",
		() =>
			Effect.gen(function* () {
				const { files, content, events, ready, reads, notifications, start } =
					yield* setup
				yield* Ref.set(
					files,
					HashMap.make([
						"file:///app/config.yml",
						version(digest(new Uint8Array([1]))),
					]),
				)
				const accepted = (path: string) => path === "/app/dependency.mjs"
				yield* start(["/app"], true, { filter: accepted })
				yield* Deferred.await(ready)
				yield* Ref.set(content, Exit.succeed(new Uint8Array([2])))
				yield* Queue.offer(events, { _tag: "Update", path: "config.yml" })
				yield* TestClock.adjust("2 seconds")
				const ignored = yield* Ref.get(notifications)
				const polled = yield* Ref.get(reads)
				assert.strictEqual(ignored, 0)
				assert.deepStrictEqual(polled, [])
				yield* Queue.offer(events, { _tag: "Update", path: "dependency.mjs" })
				yield* TestClock.adjust("1 second")
				const acceptedCount = yield* Ref.get(notifications)
				assert.strictEqual(acceptedCount, 0)
			}).pipe(Effect.scoped),
	)

	it.effect.each([false, true])(
		"respects watched roots and recursion (%s)",
		(recursive) =>
			Effect.gen(function* () {
				const { reads, files, ready, start } = yield* setup
				yield* Ref.set(
					files,
					HashMap.make(
						[
							"file:///app/dependency.mjs",
							version(digest(new Uint8Array([1]))),
						],
						[
							"file:///app/nested/child.mjs",
							version(digest(new Uint8Array([1]))),
						],
						[
							"file:///application/outside.mjs",
							version(digest(new Uint8Array([1]))),
						],
					),
				)
				yield* start(["/app"], recursive)
				yield* Deferred.await(ready)
				yield* TestClock.adjust("1 second")
				const observedReads = yield* Ref.get(reads)
				assert.deepStrictEqual(
					Array.sort(observedReads, Order.String),
					recursive
						? ["/app/dependency.mjs", "/app/nested/child.mjs"]
						: ["/app/dependency.mjs"],
				)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"preserves a reconciliation read failure and closes the watcher",
		() =>
			Effect.gen(function* () {
				const { content, closed, ready, start } = yield* setup
				const watching = yield* start()
				yield* Deferred.await(ready)
				const error = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "FileSystem",
					method: "readFile",
					pathOrDescriptor: "/app/dependency.mjs",
					cause: new Error("Access denied"),
				})
				yield* Ref.set(content, Exit.fail(error))
				yield* TestClock.adjust("1 second")
				const exit = yield* Fiber.await(watching)
				assert(Exit.isFailure(exit))
				assert.strictEqual(
					Option.getOrThrow(Cause.findErrorOption(exit.cause)),
					error,
				)
				const watcherClosed = yield* Ref.get(closed)
				assert.strictEqual(watcherClosed, true)
			}).pipe(Effect.scoped),
	)

	it.effect("ends immediately when there are no watched paths", () =>
		Effect.gen(function* () {
			const { start, reads } = yield* setup
			const watching = yield* start([])
			yield* Fiber.join(watching)
			const observedReads = yield* Ref.get(reads)
			assert.deepStrictEqual(observedReads, [])
		}).pipe(Effect.scoped),
	)
})
