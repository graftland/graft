/**
 * Generates each template under .cache/e2e, where its dependencies resolve to
 * this workspace without installing, then checks, tests, builds and runs it.
 * Uses the built packages, so run `pnpm build` first.
 */
import {
	Array,
	Effect,
	FileSystem,
	Path,
	Record,
	Stream,
	String,
	type Scope,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import { create, type TemplateName } from "../src/index.ts"

const workspace = (relative: string) =>
	new URL(`../../../${relative}`, import.meta.url).pathname
const bin = {
	graft: workspace("packages/cli/dist/bin.js"),
	tsc: workspace("node_modules/.bin/tsc"),
	vitest: workspace("node_modules/.bin/vitest"),
}

/** Runs a command to completion, with its combined output. */
const exec = (command: string, args: ReadonlyArray<string>, cwd: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const handle = yield* spawner.spawn(
			ChildProcess.make(command, args, { cwd, stdin: "ignore" }),
		)
		const [output, code] = yield* Effect.all(
			[Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
			{ concurrency: 2 },
		)
		return { output, code }
	}).pipe(Effect.scoped)

/** Starts the application and waits for a log line; closing the scope stops it. */
const start = (cwd: string, expected: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const handle = yield* spawner.spawn(
			ChildProcess.make(process.execPath, [bin.graft, "start"], {
				cwd,
				stdin: "ignore",
			}),
		)
		const lines = yield* handle.all.pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.takeUntil(String.includes(expected)),
			Stream.runCollect,
			Effect.timeout("30 seconds"),
		)
		return Array.join(lines, "\n")
	}).pipe(Effect.scoped)

const generate = (template: TemplateName) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		for (const file of Array.append(
			Record.values(bin),
			workspace("packages/core/dist/index.js"),
		))
			if (!(yield* fs.exists(file)))
				return yield* Effect.die(`${file} is missing; run pnpm build first`)
		const directory = path.join(
			path.dirname(path.dirname(new URL(import.meta.url).pathname)),
			".cache",
			"e2e",
			template,
		)
		yield* fs.remove(directory, { recursive: true, force: true })
		yield* create({ directory, template })
		return directory
	})

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		| FileSystem.FileSystem
		| Path.Path
		| ChildProcessSpawner.ChildProcessSpawner
		| Scope.Scope
	>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("generated projects", () => {
	it.live(
		"app type-checks, writes its editor schema and starts its example plugin",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* generate("app")
				const checked = yield* exec(bin.tsc, ["-p", "."], directory)
				assert.strictEqual(checked.code, 0, checked.output)
				const schema = yield* exec(
					process.execPath,
					[bin.graft, "schema"],
					directory,
				)
				assert.strictEqual(schema.code, 0, schema.output)
				const written = yield* fs.exists(`${directory}/graft.schema.json`)
				assert.isTrue(written)
				// The ticker greets once the greeter publishes its service.
				const log = yield* start(directory, "Hello, Graft!")
				assert.include(log, "Hello, Graft!")
			}).pipe(run),
		120_000,
	)

	it.live(
		"plugin type-checks, passes its tests and builds",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const directory = yield* generate("plugin")
				const checked = yield* exec(bin.tsc, ["-p", "."], directory)
				assert.strictEqual(checked.code, 0, checked.output)
				const tested = yield* exec(bin.vitest, ["run"], directory)
				assert.strictEqual(tested.code, 0, tested.output)
				const built = yield* exec(
					bin.tsc,
					["-p", "tsconfig.build.json"],
					directory,
				)
				assert.strictEqual(built.code, 0, built.output)
				for (const file of ["index.js", "index.d.ts"]) {
					const exists = yield* fs.exists(path.join(directory, "dist", file))
					assert.isTrue(exists, file)
				}
			}).pipe(run),
		120_000,
	)

	it.live(
		"minimal starts with an empty config",
		() =>
			Effect.gen(function* () {
				const directory = yield* generate("minimal")
				const log = yield* start(directory, "Running graft.yml")
				assert.include(log, "Running graft.yml")
			}).pipe(run),
		120_000,
	)
})
