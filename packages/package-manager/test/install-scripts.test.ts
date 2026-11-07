import { Effect, Ref } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { assert, it } from "@effect/vitest"

import { make } from "../src/index"
import { handle, run, setup, success } from "./fixtures"

for (const agent of ["npm", "pnpm", "yarn-classic", "yarn-berry"] as const)
	it.effect("disables lifecycle scripts for " + agent, () =>
		Effect.gen(function* () {
			const fixture = yield* setup
			yield* fixture.write("package.json", "{}")
			const seen = yield* Ref.make(false)
			const spawner = ChildProcessSpawner.make((command) =>
				Effect.gen(function* () {
					if (command._tag !== "StandardCommand")
						return yield* Effect.die("Unexpected pipeline")
					if (agent === "yarn-berry")
						assert.equal(command.options.env?.["YARN_ENABLE_SCRIPTS"], "false")
					else assert.include(command.args, "--ignore-scripts")
					yield* Ref.set(seen, true)
					return handle(success)
				}),
			)
			const manager = yield* make({
				directory: fixture.directory,
				agent,
				ignoreScripts: true,
			}).pipe(
				Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
			)
			yield* manager.install({})
			const observed = yield* Ref.get(seen)
			assert.isTrue(observed)
		}).pipe(run),
	)
