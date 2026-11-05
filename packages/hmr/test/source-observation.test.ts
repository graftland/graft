import {
	Array,
	ByteSize,
	Cause,
	Effect,
	Fiber,
	FileSystem,
	HashMap,
	Logger,
	MutableList,
	Option,
	PlatformError,
	Queue,
	Ref,
	Scope,
	Stream,
	String,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import * as Source from "../src/internal/sourceObservation"

it.effect(
	"retries observation against the retained digest, including edits in the failed window",
	() =>
		Effect.gen(function* () {
			const version = yield* Ref.make("first")
			const subscriptions = yield* Queue.unbounded<number>()
			const attempts = yield* Ref.make(0)
			const logs = MutableList.make<string>()
			const fs = FileSystem.makeNoop({
				realPath: (path) => Effect.succeed(path),
				stat: (path) =>
					Effect.succeed({
						type: String.endsWith(".mjs")(path) ? "File" : "Directory",
						size: ByteSize.bytes(5),
						mtime: Option.none(),
						ino: Option.none(),
						atime: Option.none(),
						birthtime: Option.none(),
						dev: 0n,
						mode: 0,
						nlink: Option.some(1n),
						uid: Option.none(),
						gid: Option.none(),
						rdev: Option.some(0n),
						blksize: Option.none(),
						blocks: Option.none(),
					}),
				readFile: () =>
					Ref.get(version).pipe(
						Effect.map((text) => new TextEncoder().encode(text)),
					),
				watch: () =>
					Stream.unwrap(
						Effect.gen(function* () {
							const attempt = yield* Ref.getAndUpdate(attempts, (n) => n + 1)
							yield* Queue.offer(subscriptions, attempt)
							return attempt === 0
								? Stream.fail(
										PlatformError.systemError({
											module: "FileSystem",
											method: "watch",
											_tag: "Unknown",
											cause: "Transient observation failure",
										}),
									)
								: Stream.never
						}),
					),
			})
			yield* Effect.gen(function* () {
				const source = yield* Source.make()
				const activation = yield* Scope.make()
				yield* source.watch(["file:///source/implementation.mjs"], activation)
				const changed = yield* source.changes.pipe(
					Stream.runHead,
					Effect.forkScoped,
				)
				const first = yield* Queue.take(subscriptions)
				assert.equal(first, 0)
				yield* Ref.set(version, "second")
				yield* TestClock.adjust("2 seconds")
				const second = yield* Queue.take(subscriptions)
				assert.equal(second, 1)
				const event = yield* Fiber.join(changed)
				assert.isTrue(Option.isSome(event))
				assert.isTrue(
					Array.some(
						MutableList.toArray(logs),
						String.includes("Transient observation failure"),
					),
				)
			}).pipe(
				Effect.provideService(FileSystem.FileSystem, fs),
				Effect.provide(
					Logger.layer([
						Logger.make(({ cause }) => {
							MutableList.append(logs, Cause.pretty(cause))
						}),
					]),
				),
			)
		}).pipe(Effect.scoped),
)

it.effect("retains failed dependencies and replaces them after success", () =>
	Effect.gen(function* () {
		const reads = MutableList.make<string>()
		const subscriptions = yield* Queue.unbounded<void>()
		const fs = FileSystem.makeNoop({
			realPath: (path) => Effect.succeed(path),
			stat: (path) =>
				Effect.succeed({
					type: String.endsWith(".mjs")(path) ? "File" : "Directory",
					size: ByteSize.bytes(1),
					mtime: Option.none(),
					ino: Option.none(),
					atime: Option.none(),
					birthtime: Option.none(),
					dev: 0n,
					mode: 0,
					nlink: Option.some(1n),
					uid: Option.none(),
					gid: Option.none(),
					rdev: Option.some(0n),
					blksize: Option.none(),
					blocks: Option.none(),
				}),
			readFile: (path) =>
				Effect.sync(() => {
					MutableList.append(reads, path)
					return new Uint8Array([1])
				}),
			watch: () =>
				Stream.fromEffect(Queue.offer(subscriptions, undefined)).pipe(
					Stream.drain,
					Stream.concat(Stream.never),
				),
		})
		yield* Effect.gen(function* () {
			const source = yield* Source.make()
			const files = (name: string) =>
				HashMap.make([
					"file:///source/" + name + ".mjs",
					{ generation: 1, content: undefined },
				])
			yield* source.imported("contract", files("obsolete"), false)
			yield* source.imported("contract", files("another"), false)
			const watcher = yield* source.changes.pipe(
				Stream.runDrain,
				Effect.forkScoped,
			)
			yield* Queue.take(subscriptions)
			yield* TestClock.adjust("2 seconds")
			assert.include(MutableList.toArray(reads), "/source/obsolete.mjs")
			assert.include(MutableList.toArray(reads), "/source/another.mjs")
			yield* source.imported("contract", files("current"), true)
			yield* Queue.take(subscriptions)
			yield* TestClock.adjust("2 seconds")
			MutableList.clear(reads)
			yield* TestClock.adjust("12 seconds")
			assert.deepEqual(MutableList.toArray(reads), ["/source/current.mjs"])
			yield* source.imported(
				"file:///source/replacement.mjs",
				files("replacement"),
				true,
			)
			const activation = yield* Scope.make()
			yield* source.watch(["file:///source/replacement.mjs"], activation)
			yield* TestClock.adjust("2 seconds")
			MutableList.clear(reads)
			yield* TestClock.adjust("12 seconds")
			assert.deepEqual(MutableList.toArray(reads), ["/source/replacement.mjs"])
			yield* Fiber.interrupt(watcher)
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs))
	}).pipe(Effect.scoped),
)

const sourceFiles = (first: Ref.Ref<string>) =>
	Effect.gen(function* () {
		const subscriptions = yield* Queue.unbounded<void>()
		const fs = FileSystem.makeNoop({
			realPath: (path) => Effect.succeed(path),
			stat: (path) =>
				Effect.succeed({
					type: String.endsWith(".mjs")(path) ? "File" : "Directory",
					size: ByteSize.bytes(5),
					mtime: Option.none(),
					ino: Option.none(),
					atime: Option.none(),
					birthtime: Option.none(),
					dev: 0n,
					mode: 0,
					nlink: Option.some(1n),
					uid: Option.none(),
					gid: Option.none(),
					rdev: Option.some(0n),
					blksize: Option.none(),
					blocks: Option.none(),
				}),
			readFile: (path) =>
				(path === "/source/first.mjs"
					? Ref.get(first)
					: Effect.succeed("second")
				).pipe(Effect.map((text) => new TextEncoder().encode(text))),
			watch: () =>
				Stream.fromEffect(Queue.offer(subscriptions, undefined)).pipe(
					Stream.drain,
					Stream.concat(Stream.never),
				),
		})
		return { fs, subscriptions }
	})

it.effect("accumulates the files one activation watches", () =>
	Effect.gen(function* () {
		const first = yield* Ref.make("first")
		const { fs, subscriptions } = yield* sourceFiles(first)
		yield* Effect.gen(function* () {
			const source = yield* Source.make()
			const activation = yield* Scope.make()
			yield* source.watch(["file:///source/first.mjs"], activation)
			yield* source.watch(["file:///source/second.mjs"], activation)
			const changed = yield* source.changes.pipe(
				Stream.runHead,
				Effect.timeoutOption("1 minute"),
				Effect.forkScoped,
			)
			yield* Queue.take(subscriptions)
			yield* Ref.set(first, "edited")
			// The fake stat stays unchanged; advance the retained digest audit.
			yield* TestClock.adjust("12 seconds")
			const event = yield* Fiber.join(changed)
			assert.isTrue(Option.isSome(event))
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs))
	}).pipe(Effect.scoped),
)

it.effect("stops observing files a newer activation no longer watches", () =>
	Effect.gen(function* () {
		const first = yield* Ref.make("first")
		const { fs, subscriptions } = yield* sourceFiles(first)
		yield* Effect.gen(function* () {
			const source = yield* Source.make()
			const previous = yield* Scope.make()
			const next = yield* Scope.make()
			yield* source.watch(
				["file:///source/first.mjs", "file:///source/second.mjs"],
				previous,
			)
			yield* source.watch(["file:///source/second.mjs"], next)
			const changed = yield* source.changes.pipe(
				Stream.runHead,
				Effect.timeoutOption("1 minute"),
				Effect.forkScoped,
			)
			yield* Queue.take(subscriptions)
			yield* Ref.set(first, "edited")
			yield* TestClock.adjust("2 minutes")
			const event = yield* Fiber.join(changed)
			assert.isTrue(Option.isNone(Option.flatten(event)))
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs))
	}).pipe(Effect.scoped),
)
