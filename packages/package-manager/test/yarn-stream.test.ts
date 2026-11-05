import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Option,
	PlatformError,
	Ref,
	Stream,
	String,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { detectAgent } from "../src/index.ts"
import { run, setup } from "./fixtures.ts"

describe("streaming Yarn detection", () => {
	it.effect("matches the original any-line rule across byte boundaries", () =>
		Effect.gen(function* () {
			const { fs, directory, write } = yield* setup
			yield* write("package.json", "{}")
			yield* write("yarn.lock", "")
			const samples = [
				"",
				"__metadata:",
				"prefix__metadata:",
				"x__metadata:more",
				"x__metadata:\nmore",
				" __metadata:",
				"\uFEFF__metadata:",
				"\uFEFF\n__metadata:",
				"text\r__metadata:",
				"text\r\n__metadata:",
				"text\u2028__metadata:",
				"text\u2029__metadata:",
				"__metadat",
				String.repeat(40000)("x\n") + "__metadata:",
				String.repeat(70000)("x") + "__metadata:",
			]
			for (const source of samples) {
				const bytes = new TextEncoder().encode(source)
				const sizes = source.length > 100 ? [16384] : [1, 2, 7, 11, 12, 16]
				for (const size of sizes) {
					const chunks = Array.makeBy(Math.ceil(bytes.length / size), (i) =>
						bytes.slice(i * size, (i + 1) * size),
					)
					const detected = yield* detectAgent({ directory }).pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							stream: () => Stream.fromIterable(chunks),
							readFileString: () => Effect.die("Lockfiles must be streamed"),
						}),
					)
					assert.strictEqual(
						detected,
						/^__metadata:/m.test(new TextDecoder().decode(bytes))
							? "yarn-berry"
							: "yarn-classic",
						`Chunk size: ${size}; source: ${String.slice(0, 80)(source)}`,
					)
				}
			}
		}).pipe(run),
	)

	it.effect(
		"stops pulling and closes the stream immediately after a match",
		() =>
			Effect.gen(function* () {
				const { fs, directory, write } = yield* setup
				yield* write("package.json", "{}")
				yield* write("yarn.lock", "")
				const closed = yield* Ref.make(0)
				const lock = Stream.unwrap(
					Effect.acquireRelease(
						Effect.succeed(
							Stream.succeed(new TextEncoder().encode("__metadata:")),
						),
						() => Ref.update(closed, (n) => n + 1),
					),
				).pipe(Stream.concat(Stream.die("Must not pull past metadata")))
				const detected = yield* detectAgent({ directory }).pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						stream: () => lock,
					}),
				)
				assert.strictEqual(detected, "yarn-berry")
				const observed7 = yield* Ref.get(closed)
				assert.strictEqual(observed7, 1)
			}).pipe(run),
	)

	it.effect(
		"propagates read failures before a match and releases a cancelled stream",
		() =>
			Effect.gen(function* () {
				const { fs, directory, write } = yield* setup
				yield* write("package.json", "{}")
				yield* write("yarn.lock", "")
				const error = PlatformError.systemError({
					_tag: "PermissionDenied",
					module: "FileSystem",
					method: "read",
				})
				const exit = yield* Effect.exit(
					detectAgent({ directory }).pipe(
						Effect.provideService(FileSystem.FileSystem, {
							...fs,
							stream: () => Stream.fail(error),
						}),
					),
				)
				assert(Exit.isFailure(exit))
				assert.deepStrictEqual(
					Option.getOrThrow(Cause.findErrorOption(exit.cause)),
					error,
				)
				const entered = yield* Deferred.make<void>()
				const closed = yield* Ref.make(false)
				const lock = Stream.unwrap(
					Effect.acquireRelease(
						Deferred.succeed(entered, undefined).pipe(Effect.as(Stream.never)),
						() => Ref.set(closed, true),
					),
				)
				const detecting = yield* detectAgent({ directory }).pipe(
					Effect.provideService(FileSystem.FileSystem, {
						...fs,
						stream: () => lock,
					}),
					Effect.forkScoped,
				)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(detecting)
				const observed8 = yield* Ref.get(closed)
				assert.strictEqual(observed8, true)
			}).pipe(run),
	)
})
