import { Effect, FileSystem, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { published, type Agent } from "../src/index.ts"

/** A package manager that prints `output` and exits with `code`; records each command line. */
const answering = (code: number, output: string, commands: Array<string>) =>
	ChildProcessSpawner.make((command) =>
		Effect.sync(() => {
			if (command._tag === "StandardCommand") commands.push(command.command)
			return ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(2147483647),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: Stream.empty,
				stderr: Stream.empty,
				all: Stream.make(new TextEncoder().encode(output)),
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			})
		}),
	)

const ask = (
	agent: Agent,
	code: number,
	output: string,
	directory = ".",
	commands: Array<string> = [],
) =>
	published({ directory, agent }, "graft-plugin-demo").pipe(
		Effect.provideService(
			ChildProcessSpawner.ChildProcessSpawner,
			answering(code, output, commands),
		),
		Effect.provide(NodeServices.layer),
	)

it.effect("counts a package as published only when the output names it", () =>
	Effect.gen(function* () {
		const npm = yield* ask("npm", 0, '\"graft-plugin-demo\"\n')
		// The repository root has a package.json, so Yarn Berry runs there.
		const berry = yield* ask("yarn-berry", 0, '{"name":"graft-plugin-demo"}\n')
		assert.deepStrictEqual([npm, berry], [true, true])
	}),
)

it.effect(
	"asks npm for Yarn classic, which cannot tell a 404 from a failure",
	() =>
		Effect.gen(function* () {
			const commands: Array<string> = []
			yield* ask("yarn-classic", 0, '\"graft-plugin-demo\"\n', ".", commands)
			assert.deepStrictEqual(commands, ["npm"])
		}),
)

it.effect("fails on a Yarn classic style error line instead of guessing", () =>
	Effect.gen(function* () {
		const result = yield* Effect.exit(
			ask(
				"npm",
				0,
				'{"type":"error","data":"Received invalid response from npm."}\n',
			),
		)
		assert.strictEqual(result._tag, "Failure")
	}),
)

it.effect("reports npm's 404 as not published", () =>
	Effect.gen(function* () {
		const missing = yield* ask("npm", 1, "npm error code E404\n")
		assert.isFalse(missing)
	}),
)

it.effect("asks npm when Yarn Berry has no project to run in", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const empty = yield* fs.makeTempDirectoryScoped()
		const commands: Array<string> = []
		yield* ask("yarn-berry", 0, '\"graft-plugin-demo\"\n', empty, commands)
		assert.deepStrictEqual(commands, ["npm"])
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.effect("fails on output it cannot read", () =>
	Effect.gen(function* () {
		const result = yield* Effect.exit(ask("pnpm", 1, "ERR_PNPM_SOMETHING\n"))
		assert.strictEqual(result._tag, "Failure")
	}),
)

it.effect("asks npm when another package manager's answer is unreadable", () =>
	Effect.gen(function* () {
		const commands: Array<string> = []
		// pnpm refuses (as a parent project pinning Yarn would make it); npm answers.
		const spawner = ChildProcessSpawner.make((command) =>
			Effect.sync(() => {
				const npm =
					command._tag === "StandardCommand" && command.command === "npm"
				if (command._tag === "StandardCommand") commands.push(command.command)
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(2147483647),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(npm ? 0 : 1)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					stdin: Sink.drain,
					stdout: Stream.empty,
					stderr: Stream.empty,
					all: Stream.make(
						new TextEncoder().encode(
							npm
								? '\"graft-plugin-demo\"\n'
								: "This project is configured to use yarn\n",
						),
					),
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				})
			}),
		)
		const found = yield* published(
			{ directory: ".", agent: "pnpm" },
			"graft-plugin-demo",
		).pipe(
			Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			Effect.provide(NodeServices.layer),
		)
		assert.isTrue(found)
		assert.deepStrictEqual(commands, ["pnpm", "npm"])
	}),
)

for (const output of [
	'error Command "npm" not found.',
	"proxy failed on port 404",
	"registry hostname not found",
]) {
	it.effect(
		`does not mistake a command failure for a missing package: ${output}`,
		() =>
			Effect.gen(function* () {
				const result = yield* Effect.result(ask("yarn-berry", 1, output))
				assert.strictEqual(result._tag, "Failure")
				if (result._tag === "Failure") {
					assert.strictEqual(result.failure._tag, "PackageManagerError")
					assert.include(result.failure.message, output)
				}
			}),
	)
}
