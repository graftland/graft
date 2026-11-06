import {
	Array,
	ConfigProvider,
	Effect,
	FileSystem,
	MutableList,
	Path,
	Schema,
	Sink,
	Stream,
	String,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { parse } from "yaml"

import * as Manage from "../src/Manage"

/** The registry has `@graftland/plugin-remote` and no `graft-plugin-remote`. */
const viewed = (args: ReadonlyArray<string>) =>
	args[0] === "view" && args[1] !== "@graftland/plugin-remote"
const manager = (code: number, calls: MutableList.MutableList<string>) =>
	ChildProcessSpawner.make((command) =>
		Effect.sync(() => {
			const args =
				command._tag === "StandardCommand"
					? Array.map(command.args, (word) => `${word}`)
					: []
			const view = args[0] === "view"
			if (!view) MutableList.append(calls, command._tag)
			const missing = viewed(args)
			return ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(2147483647),
				exitCode: Effect.succeed(
					ChildProcessSpawner.ExitCode(view ? (missing ? 1 : 0) : code),
				),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: Stream.empty,
				stderr: Stream.empty,
				all: Stream.make(
					new TextEncoder().encode(
						missing ? "npm error code E404" : view ? `"${args[1] ?? ""}"` : "",
					),
				),
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			})
		}),
	)

for (const global of [false, true]) {
	it.live.each(["", "# Empty configuration\n", "null\n"])(
		`installs and enables a ${global ? "user" : "project"} command plugin in an empty document (%j) once`,
		(text) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const directory = yield* fs.makeTempDirectoryScoped()
				if (!global)
					yield* fs.writeFileString(
						directory + "/package.json",
						'{"name":"example","private":true}',
					)
				yield* fs.writeFileString(directory + "/graft.yml", text)
				const calls = MutableList.make<string>()
				yield* Manage.addPlugin("remote", global).pipe(
					Effect.andThen(Manage.addPlugin("remote", global)),
					Effect.provideService(
						ChildProcessSpawner.ChildProcessSpawner,
						manager(0, calls),
					),
					Effect.provideService(Path.Path, {
						...path,
						resolve: (...parts) => path.resolve(directory, ...parts),
					}),
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromUnknown({ GRAFT_HOME: directory }),
					),
				)
				assert.lengthOf(MutableList.toArray(calls), 2)
				const manifest = yield* fs
					.readFileString(directory + "/package.json")
					.pipe(
						Effect.flatMap(
							Schema.decodeUnknownEffect(
								Schema.fromJsonString(
									Schema.Struct({
										dependencies: Schema.Record(Schema.String, Schema.String),
									}),
								),
							),
						),
					)
				assert.equal(
					manifest.dependencies["@graftland/plugin-remote"],
					"latest",
				)
				const saved = yield* fs.readFileString(directory + "/graft.yml")
				if (String.startsWith("#")(text))
					assert.include(saved, "# Empty configuration")
				const entries = yield* Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({ name: Schema.String, cli: Schema.Boolean }),
					),
				)(parse(saved))
				assert.deepEqual(entries, [
					{ name: "@graftland/plugin-remote/cli", cli: true },
				])
			}).pipe(
				Effect.scoped,
				Effect.provide([NodeServices.layer, SecureRandom.layerWebCrypto]),
			),
	)
}

it.live("does not enable a command plugin when installation fails", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped()
		const original = "- name: existing\n  cli: true\n"
		yield* fs.writeFileString(directory + "/package.json", '{"private":true}')
		yield* fs.writeFileString(directory + "/graft.yml", original)
		const calls = MutableList.make<string>()
		const result = yield* Manage.addPlugin("remote", true).pipe(
			Effect.result,
			Effect.provideService(
				ChildProcessSpawner.ChildProcessSpawner,
				manager(1, calls),
			),
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown({ GRAFT_HOME: directory }),
			),
		)
		assert.equal(result._tag, "Failure")
		const unchanged = yield* fs.readFileString(directory + "/graft.yml")
		assert.equal(unchanged, original)
	}).pipe(
		Effect.scoped,
		Effect.provide([NodeServices.layer, SecureRandom.layerWebCrypto]),
	),
)
