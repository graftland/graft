import { Array, Effect, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { pluginPackage, pluginSpec } from "../src/index.ts"

/** A package manager whose registry has exactly `published`; records every lookup. */
const registry = (published: ReadonlyArray<string>, lookups: Array<string>) =>
	ChildProcessSpawner.make((command) =>
		Effect.sync(() => {
			const args =
				command._tag === "StandardCommand"
					? Array.map(command.args, (word) => `${word}`)
					: []
			const name = args[1] ?? ""
			lookups.push(name)
			const found = Array.contains(published, name)
			return ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(2147483647),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(found ? 0 : 1)),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: Stream.empty,
				stderr: Stream.empty,
				all: Stream.make(
					new TextEncoder().encode(
						found ? `"${name}"\n` : "npm error code E404",
					),
				),
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			})
		}),
	)

const resolveWith = (
	published: ReadonlyArray<string>,
	name: string,
	lookups: Array<string> = [],
) =>
	pluginPackage(name, { directory: ".", agent: "npm" }).pipe(
		Effect.provideService(
			ChildProcessSpawner.ChildProcessSpawner,
			registry(published, lookups),
		),
		Effect.provide(NodeServices.layer),
	)

it.effect("resolves a short name to the only published convention", () =>
	Effect.gen(function* () {
		const first = yield* resolveWith(["@graftland/plugin-review"], "review")
		assert.strictEqual(first, "@graftland/plugin-review")
		const third = yield* resolveWith(["graft-plugin-review"], "review")
		assert.strictEqual(third, "graft-plugin-review")
	}),
)

it.effect("ranks both conventions equally", () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(
			resolveWith(
				["@graftland/plugin-review", "graft-plugin-review"],
				"review",
			),
		)
		assert.strictEqual(error._tag, "AmbiguousPluginName")
	}),
)

it.effect("fails when neither convention is published", () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(resolveWith([], "review"))
		assert.strictEqual(error._tag, "PluginNotFound")
	}),
)

it.effect("keeps full names without asking the registry", () =>
	Effect.gen(function* () {
		const lookups: Array<string> = []
		const scoped = yield* resolveWith([], "@acme/audit", lookups)
		const unscoped = yield* resolveWith([], "graft-plugin-echo", lookups)
		assert.deepStrictEqual(
			[scoped, unscoped, lookups],
			["@acme/audit", "graft-plugin-echo", []],
		)
	}),
)

it.effect("keeps the range of a spec", () =>
	Effect.gen(function* () {
		const spec = yield* pluginSpec("echo@^1.2.0", {
			directory: ".",
			agent: "npm",
		}).pipe(
			Effect.provideService(
				ChildProcessSpawner.ChildProcessSpawner,
				registry(["graft-plugin-echo"], []),
			),
			Effect.provide(NodeServices.layer),
		)
		assert.strictEqual(spec, "graft-plugin-echo@^1.2.0")
	}),
)
