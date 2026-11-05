import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	PlatformError,
	Queue,
	Record,
	Ref,
	Schema,
	String,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { run, setup, success } from "./fixtures.ts"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const missing = PlatformError.systemError({
	_tag: "NotFound",
	module: "FileSystem",
	method: "readFile",
})
const denied = PlatformError.systemError({
	_tag: "PermissionDenied",
	module: "FileSystem",
	method: "readFile",
})

describe("dependency state reads", () => {
	it.effect(
		"takes fresh version and real-path snapshots on both sides of installation",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, manager } = yield* setup
				yield* write("package.json", '{"dependencies":{"dep":"1"}}')
				for (const version of ["1", "2"]) {
					yield* fs.makeDirectory(path.join(directory, version))
					yield* write(`${version}/package.json`, `{"version":"${version}"}`)
				}
				yield* fs.makeDirectory(path.join(directory, "node_modules"))
				const link = path.join(directory, "node_modules/dep")
				yield* fs.symlink(path.join(directory, "1"), link)
				const reads = yield* Ref.make(0)
				const paths = yield* Ref.make(0)
				const pm = yield* manager(
					() =>
						Effect.gen(function* () {
							yield* fs.remove(link)
							yield* fs.symlink(path.join(directory, "2"), link)
							return yield* success
						}),
					{
						...fs,
						readFileString: (file) =>
							fs
								.readFileString(file)
								.pipe(
									Effect.tap(() =>
										String.includes("/node_modules/")(file)
											? Ref.update(reads, (n) => n + 1)
											: Effect.void,
									),
								),
						realPath: (file) =>
							fs
								.realPath(file)
								.pipe(Effect.tap(() => Ref.update(paths, (n) => n + 1))),
					},
				)
				const result = yield* pm.install({ dep: "2" })
				const beforePath = yield* fs.realPath(path.join(directory, "1"))
				const afterPath = yield* fs.realPath(path.join(directory, "2"))
				assert.deepStrictEqual(result.updated, [
					{
						name: "dep",
						before: { spec: "1", version: "1", path: beforePath },
						after: { spec: "2", version: "2", path: afterPath },
					},
				])
				const readCount = yield* Ref.get(reads)
				const pathCount = yield* Ref.get(paths)
				assert.strictEqual(readCount, 2)
				assert.strictEqual(pathCount, 2)
			}).pipe(run),
	)

	it.effect(
		"bounds concurrent reads and skips dependency existence probes",
		() =>
			Effect.gen(function* () {
				const { fs, write, manager } = yield* setup
				const names = Array.makeBy(40, (i) => `dep-${i}`)
				const manifest = yield* encodeJson({
					dependencies: Record.fromEntries(
						Array.map(names, (name) => [name, "1"] as const),
					),
				})
				yield* write("package.json", manifest)
				const entered = yield* Queue.unbounded<string>()
				const release = yield* Deferred.make<void>()
				const active = yield* Ref.make(0)
				const reads = yield* Ref.make(0)
				const paths = yield* Ref.make(0)
				const pm = yield* manager(() => success, {
					...fs,
					exists: (file) =>
						String.includes("/node_modules/")(file)
							? Effect.die("Unexpected dependency existence probe")
							: fs.exists(file),
					readFileString: (file) =>
						String.includes("/node_modules/")(file)
							? Effect.gen(function* () {
									yield* Ref.update(reads, (n) => n + 1)
									return yield* Effect.acquireUseRelease(
										Ref.update(active, (n) => n + 1),
										() =>
											Effect.gen(function* () {
												yield* Queue.offer(entered, file)
												yield* Deferred.await(release)
												return '{"version":"1.2.3"}'
											}),
										() => Ref.update(active, (n) => n - 1),
									)
								})
							: fs.readFileString(file),
					realPath: (file) =>
						Ref.update(paths, (n) => n + 1).pipe(Effect.as(file)),
				})
				const reading = yield* pm.readState.pipe(Effect.forkScoped)
				yield* Effect.forEach(Array.range(1, 16), () => Queue.take(entered))
				const observed1 = yield* Ref.get(active)
				assert.strictEqual(observed1, 16)
				const observed2 = yield* Queue.size(entered)
				assert.strictEqual(observed2, 0)
				yield* Deferred.succeed(release, undefined)
				const state = yield* Fiber.join(reading)
				assert.strictEqual(HashMap.size(state), 40)
				const observed3 = yield* Ref.get(active)
				assert.strictEqual(observed3, 0)
				const observed4 = yield* Ref.get(reads)
				assert.strictEqual(observed4, 40)
				const observed5 = yield* Ref.get(paths)
				assert.strictEqual(observed5, 40)
			}).pipe(run),
	)

	for (const cancel of [false, true]) {
		it.effect(
			`joins all pending reads on ${cancel ? "cancellation" : "failure"}`,
			() =>
				Effect.gen(function* () {
					const { fs, write, manager } = yield* setup
					const manifest = yield* encodeJson({
						dependencies: Record.fromEntries(
							Array.makeBy(32, (i) => [`dep-${i}`, "1"] as const),
						),
					})
					yield* write("package.json", manifest)
					const entered = yield* Queue.unbounded<string>()
					const fail = yield* Deferred.make<void>()
					const active = yield* Ref.make(0)
					const pm = yield* manager(() => success, {
						...fs,
						readFileString: (file) =>
							String.includes("/node_modules/")(file)
								? Effect.acquireUseRelease(
										Ref.update(active, (n) => n + 1),
										() =>
											Effect.gen(function* () {
												yield* Queue.offer(entered, file)
												if (String.includes("/dep-0/")(file)) {
													yield* Deferred.await(fail)
													return yield* denied
												}
												return yield* Effect.never
											}),
										() => Ref.update(active, (n) => n - 1),
									)
								: fs.readFileString(file),
					})
					const reading = yield* pm.readState.pipe(Effect.forkScoped)
					yield* Effect.forEach(Array.range(1, 16), () => Queue.take(entered))
					if (cancel) yield* Fiber.interrupt(reading)
					else {
						yield* Deferred.succeed(fail, undefined)
						const exit = yield* Effect.exit(Fiber.join(reading))
						assert(Exit.isFailure(exit))
						assert.deepStrictEqual(
							Option.getOrThrow(Cause.findErrorOption(exit.cause)),
							denied,
						)
					}
					const observed6 = yield* Ref.get(active)
					assert.strictEqual(observed6, 0)
				}).pipe(run),
		)
	}

	it.effect("only treats an entirely NotFound read cause as absence", () =>
		Effect.gen(function* () {
			const { fs, write, manager } = yield* setup
			yield* write("package.json", '{"optionalDependencies":{"missing":"1"}}')
			const causes = [
				Cause.fail(denied),
				Cause.combine(Cause.fail(missing), Cause.fail(denied)),
				Cause.combine(Cause.fail(missing), Cause.die("read defect")),
			]
			for (const cause of causes) {
				const pm = yield* manager(() => success, {
					...fs,
					readFileString: (file) =>
						String.includes("/node_modules/")(file)
							? Effect.failCause(cause)
							: fs.readFileString(file),
				})
				const exit = yield* Effect.exit(pm.readState)
				assert(Exit.isFailure(exit))
				assert.deepStrictEqual(exit.cause.reasons, cause.reasons)
			}
			const pm = yield* manager(() => success, {
				...fs,
				readFileString: (file) =>
					String.includes("/node_modules/")(file)
						? Effect.fail(missing)
						: fs.readFileString(file),
				realPath: () => Effect.die("Missing dependencies have no real path"),
			})
			const state = yield* pm.readState
			assert.deepStrictEqual(Option.getOrThrow(HashMap.get(state, "missing")), {
				spec: "1",
				version: undefined,
				path: undefined,
			})
		}).pipe(run),
	)

	it.effect(
		"propagates invalid JSON, non-file reads, and missing real paths",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, manager } = yield* setup
				yield* write("package.json", '{"dependencies":{"dep":"1"}}')
				const folder = path.join(directory, "node_modules/dep")
				yield* fs.makeDirectory(folder, { recursive: true })
				yield* write("node_modules/dep/package.json", "invalid JSON")
				const pm = yield* manager(() => success)
				const invalid = yield* Effect.exit(pm.readState)
				assert(Exit.isFailure(invalid))
				assert.strictEqual(
					Option.getOrThrow(Cause.findErrorOption(invalid.cause))._tag,
					"SchemaError",
				)
				yield* fs.remove(path.join(folder, "package.json"), { recursive: true })
				yield* fs.makeDirectory(path.join(folder, "package.json"))
				const nonFile = yield* Effect.exit(pm.readState)
				assert(Exit.isFailure(nonFile))
				yield* fs.remove(path.join(folder, "package.json"), { recursive: true })
				yield* write("node_modules/dep/package.json", '{"version":"1"}')
				const moved = yield* manager(() => success, {
					...fs,
					realPath: () => Effect.fail(missing),
				})
				const exit = yield* Effect.exit(moved.readState)
				assert(Exit.isFailure(exit))
				assert.deepStrictEqual(
					Option.getOrThrow(Cause.findErrorOption(exit.cause)),
					missing,
				)
			}).pipe(run),
	)
})
