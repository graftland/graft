import { Effect, FileSystem, Layer, Path, Schema, Sink, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

import * as Manage from "../src/Manage"

/** A package manager that installs nothing and succeeds. */
const manager = ChildProcessSpawner.make(() =>
	Effect.succeed(
		ChildProcessSpawner.makeHandle({
			pid: ChildProcessSpawner.ProcessId(2147483647),
			exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
			isRunning: Effect.succeed(false),
			kill: () => Effect.void,
			stdin: Sink.drain,
			stdout: Stream.empty,
			stderr: Stream.empty,
			all: Stream.empty,
			getInputFd: () => Sink.drain,
			getOutputFd: () => Stream.empty,
			unref: Effect.succeed(Effect.void),
		}),
	),
)

const services = Layer.mergeAll(NodeServices.layer, SecureRandom.layerWebCrypto)

const Written = Schema.fromJsonString(Schema.Struct({ $schema: Schema.String }))

/** Runs a dependency change in a new project, with or without a schema file. */
const change = Effect.fnUntraced(function* <E>(
	run: Effect.Effect<
		void,
		E,
		| ChildProcessSpawner.ChildProcessSpawner
		| FileSystem.FileSystem
		| Path.Path
		| SecureRandom.SecureRandom
	>,
	schema: boolean,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped()
	yield* fs.writeFileString(
		path.join(directory, "package.json"),
		'{"name":"example","private":true,"dependencies":{"left-pad":"1.0.0"}}',
	)
	const file = path.join(directory, "graft.schema.json")
	if (schema) yield* fs.writeFileString(file, "stale\n")
	yield* run.pipe(
		Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, manager),
		Effect.provideService(Path.Path, {
			...path,
			resolve: (...parts) => path.resolve(directory, ...parts),
		}),
	)
	return yield* fs
		.exists(file)
		.pipe(
			Effect.flatMap((exists) =>
				exists ? Effect.asSome(fs.readFileString(file)) : Effect.succeedNone,
			),
		)
})

describe("keeping graft.schema.json current", () => {
	for (const [command, run] of [
		["add", Manage.add(["graft-plugin-example"])],
		["remove", Manage.remove(["left-pad"])],
	] as const)
		it.live(`regenerates an existing schema after ${command}`, () =>
			Effect.gen(function* () {
				const text = yield* change(run, true)
				assert.strictEqual(text._tag, "Some")
				if (text._tag === "Some") {
					const written = yield* Schema.decodeEffect(Written)(text.value)
					assert.strictEqual(
						written.$schema,
						"http://json-schema.org/draft-07/schema#",
					)
				}
			}).pipe(Effect.scoped, Effect.provide(services)),
		)

	it.live("does not create a schema the project does not have", () =>
		Effect.gen(function* () {
			const text = yield* change(Manage.add(["graft-plugin-example"]), false)
			assert.strictEqual(text._tag, "None")
		}).pipe(Effect.scoped, Effect.provide(services)),
	)
})
