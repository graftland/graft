import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	HashMap,
	Option,
	Path,
	Ref,
	Schema,
} from "effect"
import type { PlatformError, Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { detectAgent, make } from "../src/index.ts"

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const setup = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	const write = (name: string, text: string) =>
		fs.writeFileString(path.join(directory, name), text)
	const read = (name: string) => fs.readFileString(path.join(directory, name))
	const manifest = (value: unknown) =>
		Effect.flatMap(encode(value), (text) => write("package.json", text))
	const real = yield* ChildProcessSpawner.ChildProcessSpawner
	const manager = (
		run: (
			command: ChildProcess.Command,
		) => Effect.Effect<
			ChildProcessSpawner.ExitCode,
			PlatformError.PlatformError
		>,
	) =>
		make({ directory }).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
				...real,
				exitCode: run,
			}),
		)
	return { fs, path, directory, write, read, manifest, manager, real }
})
const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| FileSystem.FileSystem
		| Path.Path
		| Scope.Scope
		| ChildProcessSpawner.ChildProcessSpawner
	>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))
const success = Effect.succeed(ChildProcessSpawner.ExitCode(0))

describe("agent detection", () => {
	it.effect(
		"respects explicit selection, packageManager, lockfiles and caller hints",
		() =>
			Effect.gen(function* () {
				const { directory, manifest, write, fs, path } = yield* setup
				for (const [spec, agent] of [
					["npm@11.0.0", "npm"],
					["pnpm@9.15.9", "pnpm"],
					["yarn@1.22.22", "yarn-classic"],
					["yarn@4.9.0+sha512.test", "yarn-berry"],
				] as const) {
					yield* manifest({ packageManager: spec })
					const observed1 = yield* detectAgent({
						directory,
						userAgent: "npm/11",
					})
					assert.strictEqual(observed1, agent)
				}
				const observed2 = yield* detectAgent({ directory, agent: "npm" })
				assert.strictEqual(observed2, "npm")
				yield* manifest({})
				for (const [file, content, agent] of [
					["package-lock.json", "{}", "npm"],
					["pnpm-lock.yaml", "", "pnpm"],
					["yarn.lock", "# yarn lockfile v1", "yarn-classic"],
					["yarn.lock", "__metadata:\n  version: 8", "yarn-berry"],
				] as const) {
					yield* write(file, content)
					const observed3 = yield* detectAgent({ directory })
					assert.strictEqual(observed3, agent)
					yield* fs.remove(path.join(directory, file))
				}
				const observed4 = yield* detectAgent({
					directory,
					userAgent: "pnpm/9.15.9 npm/? node/v24",
				})
				assert.strictEqual(observed4, "pnpm")
				const observed5 = yield* detectAgent({ directory })
				assert.strictEqual(observed5, "npm")
			}).pipe(run),
	)
	it.effect("rejects ambiguous locks and unsupported declarations", () =>
		Effect.gen(function* () {
			const { directory, manifest, write } = yield* setup
			yield* manifest({})
			yield* write("pnpm-lock.yaml", "")
			yield* write("yarn.lock", "")
			const observed6 = yield* Effect.exit(detectAgent({ directory }))
			assert(Exit.isFailure(observed6))
			yield* manifest({ packageManager: "unknown@1.0.0" })
			const observed7 = yield* Effect.exit(detectAgent({ directory }))
			assert(Exit.isFailure(observed7))
		}).pipe(run),
	)
})

describe("installation", () => {
	it.effect(
		"restores exact manifest and lock bytes and removes newly created locks on failure",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, write, read, manager } = yield* setup
				const original =
					'{\r\n\t"dependencies": { "old": "1" },\r\n\t"custom": true\r\n}\r\n'
				yield* write("package.json", original)
				yield* write("package-lock.json", "original lock\n")
				const calls = yield* Ref.make(0)
				const pm = yield* manager(() =>
					Effect.gen(function* () {
						const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
						if (call === 2) {
							const observed8 = yield* read("package.json")
							assert.strictEqual(observed8, original)
							const observed9 = yield* read("package-lock.json")
							assert.strictEqual(observed9, "original lock\n")
						}
						yield* write("package.json", "modified by process")
						yield* write("package-lock.json", "modified lock")
						yield* write("npm-shrinkwrap.json", "new lock")
						return ChildProcessSpawner.ExitCode(call === 1 ? 7 : 0)
					}),
				)
				const exit = yield* Effect.exit(pm.install({ old: null, added: "^2" }))
				assert(Exit.isFailure(exit))
				assert.strictEqual(
					Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag,
					"PackageManagerError",
				)
				const observed10 = yield* read("package.json")
				assert.strictEqual(observed10, original)
				const observed11 = yield* read("package-lock.json")
				assert.strictEqual(observed11, "original lock\n")
				const observed12 = yield* fs.exists(
					path.join(directory, "npm-shrinkwrap.json"),
				)
				assert.strictEqual(observed12, false)
				const observed13 = yield* Ref.get(calls)
				assert.strictEqual(observed13, 2)
			}).pipe(run),
	)
	it.effect("retains both install and recovery failures", () =>
		Effect.gen(function* () {
			const { write, read, manifest, manager } = yield* setup
			yield* manifest({})
			const original = yield* read("package.json")
			yield* write("package-lock.json", "lock")
			const pm = yield* manager(() =>
				Effect.succeed(ChildProcessSpawner.ExitCode(9)),
			)
			const exit = yield* Effect.exit(pm.install({ example: "1" }))
			assert(Exit.isFailure(exit))
			const errors = Arr.filter(exit.cause.reasons, Cause.isFailReason)
			assert.strictEqual(errors.length, 2)
			const observed14 = yield* read("package.json")
			assert.strictEqual(observed14, original)
		}).pipe(run),
	)
	it.effect("restores on interruption after the process is finalized", () =>
		Effect.gen(function* () {
			const { manifest, write, read, manager } = yield* setup
			yield* manifest({})
			const original = yield* read("package.json")
			const started = yield* Deferred.make<void>()
			const stopped = yield* Ref.make(false)
			const pm = yield* manager(() =>
				Effect.acquireUseRelease(
					Effect.void,
					() =>
						Effect.gen(function* () {
							yield* write("package.json", "partial")
							yield* Deferred.succeed(started, undefined)
							return yield* Effect.never
						}),
					() => Ref.set(stopped, true),
				),
			)
			const fiber = yield* pm.install({ example: "1" }).pipe(Effect.forkScoped)
			yield* Deferred.await(started)
			yield* Fiber.interrupt(fiber)
			const observed15 = yield* Ref.get(stopped)
			assert.strictEqual(observed15, true)
			const observed16 = yield* read("package.json")
			assert.strictEqual(observed16, original)
		}).pipe(run),
	)
	it.effect(
		"preserves fields, reports actual installed versions and serializes installs",
		() =>
			Effect.gen(function* () {
				const { fs, path, directory, manifest, read, manager } = yield* setup
				yield* manifest({
					scripts: { test: "custom" },
					devDependencies: { tool: "1" },
					optionalDependencies: { old: "1" },
					peerDependencies: { peer: "1" },
				})
				const pm = yield* manager(() =>
					Effect.gen(function* () {
						yield* fs.makeDirectory(path.join(directory, "node_modules/tool"), {
							recursive: true,
						})
						yield* fs.writeFileString(
							path.join(directory, "node_modules/tool/package.json"),
							'{"version":"2.0.0"}',
						)
						return ChildProcessSpawner.ExitCode(0)
					}),
				)
				const result = yield* pm.install({ tool: "^2", old: null, added: "3" })
				assert.deepStrictEqual(
					Arr.map(result.added, (c) => c.name),
					["added"],
				)
				assert.deepStrictEqual(
					Arr.map(result.removed, (c) => c.name),
					["old"],
				)
				assert.strictEqual(result.updated[0]?.after?.version, "2.0.0")
				yield* Effect.all(
					[pm.install({ first: "1" }), pm.install({ second: "2" })],
					{ concurrency: 2 },
				)
				const state = yield* pm.readState
				assert(HashMap.has(state, "first") && HashMap.has(state, "second"))
				const decoded = yield* read("package.json").pipe(
					Effect.flatMap(
						Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown)),
					),
				)
				assert.deepStrictEqual(decoded, {
					scripts: { test: "custom" },
					devDependencies: { tool: "^2" },
					optionalDependencies: {},
					peerDependencies: { peer: "1" },
					dependencies: { added: "3", first: "1", second: "2" },
				})
			}).pipe(run),
	)
	it.effect("validates changes before writing or spawning", () =>
		Effect.gen(function* () {
			const { manifest, read, manager } = yield* setup
			yield* manifest({})
			const pm = yield* manager(() => Effect.die("must not spawn"))
			const observed17 = yield* Effect.exit(pm.install({ "../escape": "1" }))
			assert(Exit.isFailure(observed17))
			const observed18 = yield* read("package.json")
			assert.strictEqual(observed18, "{}")
		}).pipe(run),
	)
	it.live(
		"runs a scoped real child process and restores files on nonzero exit",
		() =>
			Effect.gen(function* () {
				const { manifest, read, manager, real } = yield* setup
				yield* manifest({})
				const pm = yield* manager((command) => {
					assert.strictEqual(command._tag, "StandardCommand")
					if (command._tag !== "StandardCommand") return success
					return real.exitCode(
						ChildProcess.make(
							"node",
							[
								"-e",
								"if (!process.env.PATH) process.exit(19); require('node:fs').writeFileSync('package.json', 'partial'); process.exit(17)",
							],
							command.options,
						),
					)
				})
				const exit = yield* Effect.exit(pm.install({ example: "1" }))
				assert(Exit.isFailure(exit))
				const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
				assert.strictEqual(error._tag, "PackageManagerError")
				if (error._tag === "PackageManagerError")
					assert.strictEqual(error.exitCode, 17)
				const observed19 = yield* read("package.json")
				assert.strictEqual(observed19, "{}")
			}).pipe(run),
	)
})
