import {
	Array,
	ConfigProvider,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	Queue,
	Schema,
	Terminal,
	type Cause,
	type Scope,
} from "effect"
import { TerminalCapabilities } from "effect/cli"
import type { ChildProcessSpawner } from "effect/process"
import {
	NodeChildProcessSpawner,
	NodeFileSystem,
	NodePath,
} from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import {
	CreateError,
	InvalidName,
	InvalidPackageManager,
} from "../src/index.ts"
import { main } from "../src/internal/main.ts"
import { resolve, type Input } from "../src/internal/resolve.ts"

const key = (name: string, input?: string): Terminal.UserInput => ({
	input: Option.fromUndefinedOr(input),
	key: { name, ctrl: false, meta: false, shift: false },
})
const enter = key("return")
/** Clears the prefilled default with Ctrl+U, then types the text. */
const typed = (text: string) => [
	{
		input: Option.none(),
		key: { name: "u", ctrl: true, meta: false, shift: false },
	},
	...Array.map(Array.fromIterable(text), (character) =>
		key(character, character),
	),
]

/** A terminal that reads the given keys, then ends input as Ctrl+C does. */
const terminal = (keys: ReadonlyArray<Terminal.UserInput>) =>
	Effect.gen(function* () {
		const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
		yield* Queue.offerAll(queue, keys)
		yield* Queue.end(queue)
		return Terminal.make({
			columns: Effect.succeed(80),
			rows: Effect.succeed(24),
			size: Effect.die("unused"),
			readInput: Effect.succeed(queue),
			readLine: Effect.die("unused"),
			display: () => Effect.void,
		})
	})

const services = Layer.provideMerge(
	NodeChildProcessSpawner.layer,
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
)

/** Runs with a terminal that can prompt or not, typing the given keys. */
const run =
	(options: {
		readonly canPrompt: boolean
		readonly keys?: ReadonlyArray<Terminal.UserInput>
	}) =>
	<A, E>(
		effect: Effect.Effect<
			A,
			E,
			| FileSystem.FileSystem
			| Path.Path
			| Terminal.Terminal
			| ChildProcessSpawner.ChildProcessSpawner
		>,
	) =>
		Effect.flatMap(terminal(options.keys ?? []), (mock) =>
			effect.pipe(
				Effect.provideService(Terminal.Terminal, mock),
				Effect.provideService(TerminalCapabilities.TerminalCapabilities, {
					canColor: false,
					canAnimate: false,
					canPrompt: options.canPrompt,
				}),
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromEnv({
						env: {
							npm_config_user_agent:
								"pnpm/9.15.9 npm/? node/v22.19.0 linux x64",
						},
					}),
				),
			),
		)

const input: Input = {
	directory: Option.none(),
	template: Option.none(),
	name: Option.none(),
	plugins: [],
	packageManager: Option.none(),
	install: Option.none(),
	git: Option.none(),
	yes: false,
}
const enough = Array.replicate(enter, 8)

const test = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| FileSystem.FileSystem
		| Path.Path
		| ChildProcessSpawner.ChildProcessSpawner
		| Scope.Scope
	>,
) => effect.pipe(Effect.scoped, Effect.provide(services))

describe("resolve", () => {
	it.effect(
		"gives the same answers when asked, with --yes, or off a terminal",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const root = yield* fs.makeTempDirectoryScoped()
				for (const directory of [
					Option.none(),
					Option.some(path.join(root, "app")),
				]) {
					const given = { ...input, directory }
					const asked = yield* resolve(given).pipe(
						run({ canPrompt: true, keys: enough }),
					)
					// No keys: any question would fail with QuitError.
					const yes = yield* resolve({ ...given, yes: true }).pipe(
						run({ canPrompt: true }),
					)
					const piped = yield* resolve(given).pipe(run({ canPrompt: false }))
					assert.deepStrictEqual(asked, yes)
					assert.deepStrictEqual(asked, piped)
					assert.deepStrictEqual(asked, {
						directory: Option.getOrElse(directory, () => "graft-app"),
						template: "app",
						name: undefined,
						plugins: [],
						packageManager: { agent: "pnpm", declaration: undefined },
						install: true,
						git: true,
					})
				}
			}).pipe(test),
	)

	it.effect("asks for the plugin's package name, defaulting to a prefix", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const root = yield* fs.makeTempDirectoryScoped()
			const given = {
				...input,
				directory: Option.some(path.join(root, "hello")),
				template: Option.some("plugin" as const),
				install: Option.some(false),
				git: Option.some(false),
			}
			const accepted = yield* resolve(given).pipe(
				run({ canPrompt: true, keys: [enter] }),
			)
			assert.strictEqual(accepted.name, undefined)
			const named = yield* resolve(given).pipe(
				run({ canPrompt: true, keys: [...typed("graft-plugin-hi"), enter] }),
			)
			assert.strictEqual(named.name, "graft-plugin-hi")
		}).pipe(test),
	)

	it.effect("asks again for a directory that is not empty", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const root = yield* fs.makeTempDirectoryScoped()
			const taken = path.join(root, "taken")
			yield* fs.makeDirectory(taken)
			yield* fs.writeFileString(path.join(taken, "keep.txt"), "keep me")
			const free = path.join(root, "free")
			const given = { ...input, directory: Option.some(taken) }
			const answers = yield* resolve(given).pipe(
				run({ canPrompt: true, keys: [...typed(free), enter, ...enough] }),
			)
			assert.strictEqual(answers.directory, free)
			const error = yield* Effect.flip(
				resolve(given).pipe(run({ canPrompt: false })),
			)
			assert.isTrue(Schema.is(CreateError)(error), `${error}`)
		}).pipe(test),
	)

	it.effect("records the package manager only with a version", () =>
		Effect.gen(function* () {
			const answers = (packageManager: string) =>
				resolve({
					...input,
					yes: true,
					packageManager: Option.some(packageManager),
				}).pipe(
					run({ canPrompt: false }),
					Effect.map((answers) => answers.packageManager),
				)
			const pinned = yield* answers("yarn@4.9.1")
			assert.deepStrictEqual(pinned, {
				agent: "yarn-berry",
				declaration: "yarn@4.9.1",
			})
			const unpinned = yield* answers("npm")
			assert.deepStrictEqual(unpinned, {
				agent: "npm",
				declaration: undefined,
			})
			const error = yield* Effect.flip(answers("bun"))
			assert.isTrue(Schema.is(InvalidPackageManager)(error), `${error}`)
		}).pipe(test),
	)

	it.effect("rejects an invalid --name before asking anything", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				resolve({ ...input, name: Option.some("Not Valid") }).pipe(
					run({ canPrompt: true }),
				),
			)
			assert.isTrue(Schema.is(InvalidName)(error), `${error}`)
		}).pipe(test),
	)

	it.effect("writes nothing when cancelled", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const root = yield* fs.makeTempDirectoryScoped()
			const exit = yield* Effect.exit(
				main({ ...input, directory: Option.some(path.join(root, "app")) }).pipe(
					run({ canPrompt: true }),
				),
			)
			assert.isTrue(Exit.hasInterrupts(exit), `${exit}`)
			const observed = yield* fs.readDirectory(root)
			assert.deepStrictEqual(observed, [])
		}).pipe(test),
	)
})
