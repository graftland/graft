import { assert, it } from "@effect/vitest"
import { Array, Cause, Effect, Exit, Option, Ref } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { run, setup } from "./fixtures.ts"

it.effect(
	"restores the exclusive install snapshot byte-for-byte after installer and recovery writes",
	() =>
		Effect.gen(function* () {
			const { fs, path, directory, write, manager } = yield* setup
			yield* fs.makeDirectory(path.join(directory, ".yarn"))
			const snapshots = [
				[
					"package.json",
					new TextEncoder().encode(
						'\uFEFF{\r\n\t"packageManager":"yarn@4.9.0", "scripts":{"start":"original"}\r\n}\r\n',
					),
				],
				["yarn.lock", new TextEncoder().encode("__metadata:\n  version: 8\n")],
				[
					".yarnrc.yml",
					new TextEncoder().encode(
						"# Keep this comment.\r\nnodeLinker: node-modules\r\n",
					),
				],
				[
					".yarn/install-state.gz",
					new Uint8Array([0x1f, 0x8b, 0, 0xff, 0x80, 13, 10]),
				],
			] as const
			for (const [name, bytes] of snapshots)
				yield* fs.writeFile(path.join(directory, name), bytes)
			const checkSnapshot = Effect.fnUntraced(function* () {
				for (const [name, expected] of snapshots) {
					const actual = yield* fs.readFile(path.join(directory, name))
					assert.deepStrictEqual(
						Array.fromIterable(actual),
						Array.fromIterable(expected),
						name,
					)
				}
				const newFileExists = yield* fs.exists(path.join(directory, ".pnp.cjs"))
				assert.strictEqual(newFileExists, false)
			})
			const calls = yield* Ref.make(0)
			const pm = yield* manager(() =>
				Effect.gen(function* () {
					const call = yield* Ref.updateAndGet(calls, (count) => count + 1)
					if (call === 2) yield* checkSnapshot()
					// Rollback restores the full snapshot, including unrelated manifest fields.
					yield* write(
						"package.json",
						'{"scripts":{"start":"changed during install"}}',
					)
					yield* write("yarn.lock", "changed lock")
					yield* write(".yarnrc.yml", "changed config")
					yield* write(".yarn/install-state.gz", "changed state")
					yield* write(".pnp.cjs", "created during install")
					return ChildProcessSpawner.ExitCode(call === 1 ? 7 : 0)
				}),
			)
			const exit = yield* Effect.exit(pm.install({ added: "1" }))
			assert(Exit.isFailure(exit))
			const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
			assert.strictEqual(error._tag, "PackageManagerError")
			if (error._tag === "PackageManagerError")
				assert.strictEqual(error.operation, "install")
			const count = yield* Ref.get(calls)
			assert.strictEqual(count, 2)
			yield* checkSnapshot()
		}).pipe(run),
)
