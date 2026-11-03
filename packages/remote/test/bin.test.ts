import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { command } from "../src/internal/runner/command"

const invoke = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const argv = yield* command()
		const child = yield* spawner.spawn(
			ChildProcess.make(argv[0], [...argv.slice(1), ...args], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		)
		return yield* Effect.all(
			{
				code: child.exitCode,
				stdout: Stream.mkString(Stream.decodeText(child.stdout)),
				stderr: Stream.mkString(Stream.decodeText(child.stderr)),
			},
			{ concurrency: "unbounded" },
		)
	})
const serve = [
	"serve",
	"--state",
	"unused-state",
	"--root",
	"unused-root",
	"--cert",
	"unused-cert",
	"--key",
	"unused-key",
	"--ca",
	"unused-ca",
]
describe("remote command line", () => {
	it.live(
		"reports invalid ports and durations as usage errors before reading files",
		() =>
			Effect.gen(function* () {
				const cases: ReadonlyArray<readonly [string, string, string]> = [
					["--port", "65536", "Port must be between"],
					["--port", "fraction", "integer"],
					["--lease", "0", "finite and positive"],
					["--grace", "Infinity", "finite and positive"],
					["--lease", "soon", "Duration"],
				]
				for (const [flag, value, detail] of cases) {
					const result = yield* invoke([...serve, flag, value])
					assert.notEqual(result.code, 0)
					const output = result.stdout + result.stderr
					assert.include(output, detail)
					assert.include(output, "USAGE")
					assert.notInclude(output, "ShowHelp: Help requested")
					assert.notInclude(output, "ENOENT")
				}
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.live("describes the child and serve subcommands", () =>
		Effect.gen(function* () {
			const result = yield* invoke(["--help"])
			assert.equal(result.code, 0)
			assert.include(result.stdout, "child")
			assert.include(result.stdout, "serve")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
	it.live("validates the supervised bootstrap before starting a watchdog", () =>
		Effect.gen(function* () {
			const result = yield* invoke([
				"child",
				"unused-contract",
				"session",
				"not-json",
			])
			assert.notEqual(result.code, 0)
			assert.include(result.stdout + result.stderr, "bootstrap")
			assert.notInclude(result.stdout + result.stderr, "watchdog failed")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})
