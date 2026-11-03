import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Ref } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { run, setup } from "./fixtures.ts"

for (const name of [
	"package.json",
	"package-lock.json",
	".npmrc",
	".yarn/install-state.gz",
]) {
	it.effect(`rejects a linked ${name} before any transaction write`, () =>
		Effect.gen(function* () {
			const { fs, path, directory, write, manager } = yield* setup
			yield* write("package.json", "{}")
			const calls = yield* Ref.make(0)
			const pm = yield* manager(
				() =>
					Ref.update(calls, (n) => n + 1).pipe(
						Effect.as(ChildProcessSpawner.ExitCode(1)),
					),
				{
					...fs,
					makeTempDirectory: () =>
						Effect.die("Must reject before creating a snapshot"),
				},
			)
			const target = path.join(directory, "source.json")
			yield* fs.writeFileString(target, "{}")
			const file = path.join(directory, name)
			yield* fs.makeDirectory(path.dirname(file), { recursive: true })
			yield* fs.remove(file, { force: true })
			yield* fs.symlink(target, file)
			const result = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(result))
			const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
			assert.strictEqual(error._tag, "UnsupportedFileTypeError")
			if (error._tag !== "UnsupportedFileTypeError") return
			assert.strictEqual(error.path, file)
			assert.strictEqual(error.fileType, "SymbolicLink")
			const actual = yield* fs.readFileString(target)
			assert.strictEqual(actual, "{}")
			const identity = yield* fs.readLink(file)
			assert.strictEqual(identity, target)
			const count = yield* Ref.get(calls)
			assert.strictEqual(count, 0)
			const status = yield* pm.recoveryRequired
			assert(Option.isNone(status))
		}).pipe(run),
	)
}

it.effect("rejects a dangling configuration link when creating a manager", () =>
	Effect.gen(function* () {
		const { fs, path, directory, write, manager } = yield* setup
		yield* write("package.json", "{}")
		yield* fs.symlink(
			path.join(directory, "missing"),
			path.join(directory, ".npmrc"),
		)
		const result = yield* Effect.exit(
			manager(() => Effect.die("Must not spawn")),
		)
		assert(Exit.isFailure(result))
		const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
		assert.strictEqual(error._tag, "UnsupportedFileTypeError")
	}).pipe(run),
)

it.effect("rejects directories in the managed file set", () =>
	Effect.gen(function* () {
		const { fs, path, directory, write, manager } = yield* setup
		yield* write("package.json", "{}")
		yield* fs.makeDirectory(path.join(directory, ".npmrc"))
		const result = yield* Effect.exit(
			manager(() => Effect.die("Must not spawn")),
		)
		assert(Exit.isFailure(result))
		const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
		assert.strictEqual(error._tag, "UnsupportedFileTypeError")
	}).pipe(run),
)

it.effect(
	"allows a new install after an unsupported link is replaced with a regular file",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory, write, manager } = yield* setup
			yield* write("package.json", "{}")
			const pm = yield* manager(() =>
				Effect.succeed(ChildProcessSpawner.ExitCode(0)),
			)
			const config = path.join(directory, ".npmrc")
			yield* fs.symlink(path.join(directory, "missing"), config)
			const rejected = yield* Effect.exit(pm.install({}))
			assert(Exit.isFailure(rejected))
			yield* fs.remove(config)
			yield* fs.writeFileString(config, "original config")
			const result = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isSuccess(result))
			const status = yield* pm.recoveryRequired
			assert(Option.isNone(status))
		}).pipe(run),
)
