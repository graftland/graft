import {
	Array,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Ref,
	Schema,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const executable = new URL("../.cache/commands/cli/bin.js", import.meta.url)
	.pathname

it.live(
	"rejects watch before loading an invalid application revision (O6)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			yield* fs.writeFileString(`${directory}/graft.yml`, "plugins: [\n")
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						executable,
						"--no-plugins",
						"start",
						`${directory}/graft.yml`,
						"--watch",
					],
					{ cwd: directory, env: { GRAFT_HOME: directory + "/home" } },
				),
			)
			const output = yield* Stream.mkString(Stream.decodeText(child.all))
			const code = yield* child.exitCode
			assert.notEqual(code, 0)
			assert.include(output, "Watch and live Loader mutation are unsupported")
			assert.notInclude(output, "YAMLParseError")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"fails CLI startup on invalid initial YAML without waiting for edits (O6)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			yield* fs.writeFileString(`${directory}/graft.yml`, "plugins: [\n")
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[executable, "--no-plugins", "start", `${directory}/graft.yml`],
					{ cwd: directory, env: { GRAFT_HOME: directory + "/home" } },
				),
			)
			const output = yield* Stream.mkString(Stream.decodeText(child.all))
			const code = yield* child.exitCode
			assert.notEqual(code, 0)
			assert.include(output, "YAMLParseError")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"reads !env once from an env file after process environment values (F2, O6)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const plugin = yield* quote(
				new URL("../.cache/integration/plugin.mjs", import.meta.url).href,
			)
			const effect = yield* quote(import.meta.resolve("effect"))
			yield* fs.writeFileString(
				`${directory}/package.json`,
				'{"name":"start-env-fixture","type":"module"}',
			)
			yield* fs.writeFileString(
				`${directory}/plugin.mjs`,
				`import {Plugin} from ${plugin};import {Effect,Schema} from ${effect};export default Plugin.make({name:"env",config:Schema.Struct({file:Schema.String,shared:Schema.String,empty:Schema.String}),apply:config=>Effect.logInfo("VALUES file="+config.file+" shared="+config.shared+" empty=["+config.empty+"]")});`,
			)
			yield* fs.writeFileString(
				`${directory}/.env`,
				"GRAFT_TEST_FILE=file\nGRAFT_TEST_SHARED=file\nGRAFT_TEST_EMPTY=file\n",
			)
			yield* fs.writeFileString(
				`${directory}/graft.yml`,
				"- id: env\n  name: ./plugin.mjs\n  config:\n    file: !env GRAFT_TEST_FILE\n    shared: !env GRAFT_TEST_SHARED\n    empty: !env GRAFT_TEST_EMPTY\n",
			)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						executable,
						"--no-plugins",
						"start",
						`${directory}/graft.yml`,
						"--env-file",
						`${directory}/.env`,
					],
					{
						cwd: directory,
						env: {
							GRAFT_HOME: directory + "/home",
							GRAFT_TEST_SHARED: "process",
							GRAFT_TEST_EMPTY: "",
						},
						extendEnv: true,
					},
				),
			)
			const ready = yield* Deferred.make<void>()
			const output = yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) =>
					String.includes("VALUES file=file shared=process empty=[]")(line)
						? Deferred.succeed(ready, undefined)
						: Effect.logDebug(line),
				),
				Effect.forkScoped,
			)
			yield* Deferred.await(ready).pipe(
				Effect.raceFirst(
					Fiber.join(output).pipe(
						Effect.andThen(
							Effect.die("CLI exited before applying the environment fixture"),
						),
					),
				),
			)
			yield* child.kill()
			yield* Fiber.join(output)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

/** Starts the CLI on a fixture directory and collects output until a line matches or the process exits. */
const startUntil = Effect.fnUntraced(function* (
	directory: string,
	expected: string,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const child = yield* spawner.spawn(
		ChildProcess.make(
			process.execPath,
			[executable, "--no-plugins", "start", `${directory}/graft.yml`],
			{
				cwd: directory,
				env: { GRAFT_HOME: directory + "/home" },
				extendEnv: true,
			},
		),
	)
	const ready = yield* Deferred.make<void>()
	const lines = yield* Ref.make<ReadonlyArray<string>>([])
	const output = yield* child.all.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.runForEach((line) =>
			Ref.update(lines, Array.append(line)).pipe(
				Effect.andThen(
					String.includes(expected)(line)
						? Deferred.succeed(ready, undefined)
						: Effect.void,
				),
			),
		),
		Effect.forkScoped,
	)
	const exited = yield* Deferred.await(ready).pipe(
		Effect.as(false),
		Effect.raceFirst(Fiber.join(output).pipe(Effect.as(true))),
	)
	if (!exited) yield* child.kill()
	yield* Fiber.join(output)
	const collected = yield* Ref.get(lines)
	return { exited, output: Array.join(collected, "\n") }
})
const fixtureModules = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const plugin = yield* quote(
		new URL("../.cache/integration/plugin.mjs", import.meta.url).href,
	)
	const effect = yield* quote(import.meta.resolve("effect"))
	yield* fs.writeFileString(
		`${directory}/package.json`,
		'{"name":"start-host-fixture","type":"module"}',
	)
	yield* fs.writeFileString(
		`${directory}/plugin.mjs`,
		`import {isMainThread} from "node:worker_threads";import {Plugin} from ${plugin};import {Effect} from ${effect};if (isMainThread && process.send === undefined) throw new Error("PLUGIN EVALUATED IN HOST");export default Plugin.make({name:"unit-only",apply:()=>Effect.logInfo("SERVING IN UNIT")});`,
	)
	yield* fs.writeFileString(
		`${directory}/command.mjs`,
		`throw new Error("COMMAND PLUGIN IMPORTED");`,
	)
})

it.live(
	"serves an entry in a unit while neither the host nor the Loader imports plugin or command modules (I1, P1)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			yield* fixtureModules(directory)
			yield* fs.writeFileString(
				`${directory}/graft.yml`,
				"- id: commands\n  name: ./command.mjs\n  cli: true\n- id: app\n  name: ./plugin.mjs\n",
			)
			const result = yield* startUntil(directory, "SERVING IN UNIT")
			assert.isFalse(result.exited, result.output)
			assert.notInclude(result.output, "PLUGIN EVALUATED IN HOST")
			assert.notInclude(result.output, "COMMAND PLUGIN IMPORTED")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

it.live(
	"rejects an entry field the kernel deployment does not carry instead of dropping it (O6)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			yield* fixtureModules(directory)
			yield* fs.writeFileString(
				`${directory}/graft.yml`,
				"- id: app\n  name: ./plugin.mjs\n  isolate:\n    app/Database: true\n",
			)
			const result = yield* startUntil(directory, "SERVING IN UNIT")
			assert.isTrue(result.exited, result.output)
			assert.include(result.output, "DeploymentUnsupported")
			assert.notInclude(result.output, "SERVING IN UNIT")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

it.live(
	"rejects protocol stdio because no plugin owns the process stdio (O6)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			yield* fs.writeFileString(`${directory}/graft.yml`, "[]\n")
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[executable, "--stdio", "start", `${directory}/graft.yml`],
					{ cwd: directory, env: { GRAFT_HOME: directory + "/home" } },
				),
			)
			const output = yield* Stream.mkString(Stream.decodeText(child.all))
			const code = yield* child.exitCode
			assert.notEqual(code, 0)
			assert.include(output, "graft start --stdio is unsupported")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)
