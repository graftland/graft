import {
	Array,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Ref,
	Schedule,
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
	"lends the kernel's stdio to the one unit that claims it and exits when it ends its output",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const plugin = yield* quote(
				new URL("../.cache/integration/plugin.mjs", import.meta.url).href,
			)
			const effect = yield* quote(import.meta.resolve("effect"))
			const lend = yield* quote(
				new URL("../../plugin-remote/dist/ProcessStdio.js", import.meta.url)
					.href,
			)
			yield* fs.writeFileString(
				`${directory}/package.json`,
				'{"name":"start-stdio-fixture","type":"module"}',
			)
			yield* fs.writeFileString(
				`${directory}/echo.mjs`,
				`import {Plugin} from ${plugin};import {Effect,Stream} from ${effect};import {ProcessStdio} from ${lend};export default Plugin.make({name:"echo",inject:[ProcessStdio],apply:()=>Effect.gen(function*(){const stdio=yield* (yield* ProcessStdio).claim;yield* Effect.logInfo("UNIT LOG");yield* Plugin.fork(stdio.stdin.pipe(Stream.decodeText(),Stream.map((text)=>text.toUpperCase()),Stream.encodeText,Stream.run(stdio.stdout())))})});`,
			)
			yield* fs.writeFileString(
				`${directory}/graft.yml`,
				"- id: first\n  name: ./echo.mjs\n",
			)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						executable,
						"--no-plugins",
						"--stdio",
						"start",
						`${directory}/graft.yml`,
					],
					{
						cwd: directory,
						env: { GRAFT_HOME: directory + "/home" },
						extendEnv: true,
					},
				),
			)
			const stdout = yield* Stream.mkString(
				Stream.decodeText(child.stdout),
			).pipe(Effect.forkScoped)
			const stderr = yield* Stream.mkString(
				Stream.decodeText(child.stderr),
			).pipe(Effect.forkScoped)
			yield* Stream.make(
				new TextEncoder().encode("hello over the kernel\n"),
			).pipe(Stream.run(child.stdin))
			const code = yield* child.exitCode
			const out = yield* Fiber.join(stdout)
			const err = yield* Fiber.join(stderr)
			assert.strictEqual(out, "HELLO OVER THE KERNEL\n", err)
			assert.include(err, "UNIT LOG")
			assert.strictEqual(code, 0, err)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

it.live(
	"turns saved modules and config edits into Changes for the affected entries while the process keeps running (C9)",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const plugin = yield* quote(
				new URL("../.cache/integration/plugin.mjs", import.meta.url).href,
			)
			const effect = yield* quote(import.meta.resolve("effect"))
			const module = (name: string, line: string) =>
				`import {Plugin} from ${plugin};import {Effect} from ${effect};export default Plugin.make({name:"${name}",apply:()=>Effect.logInfo("${line}").pipe(Effect.andThen(Effect.addFinalizer(()=>Effect.logInfo("${name} stopped"))))});`
			/** Each plugin is its own package, so its captured artifact changes alone. */
			const write = Effect.fnUntraced(function* (name: string, line: string) {
				yield* fs.makeDirectory(`${directory}/${name}`, { recursive: true })
				yield* fs.writeFileString(
					`${directory}/${name}/package.json`,
					`{"name":"${name}","type":"module"}`,
				)
				yield* fs.writeFileString(
					`${directory}/${name}/index.mjs`,
					module(name, line),
				)
			})
			yield* write("edited", "EDITED v1")
			yield* write("other", "OTHER started")
			yield* fs.writeFileString(
				`${directory}/graft.yml`,
				"- id: edited\n  name: ./edited/index.mjs\n- id: other\n  name: ./other/index.mjs\n",
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
						"--watch",
					],
					{
						cwd: directory,
						env: { GRAFT_HOME: directory + "/home" },
						extendEnv: true,
					},
				),
			)
			const lines = yield* Ref.make<ReadonlyArray<string>>([])
			yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) => Ref.update(lines, Array.append(line))),
				Effect.forkScoped,
			)
			const seen = (text: string) =>
				Ref.get(lines).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("50 millis"),
						until: Array.some(String.includes(text)),
					}),
					Effect.timeout("20 seconds"),
				)
			yield* seen("EDITED v1")
			yield* seen("OTHER started")
			yield* write("edited", "EDITED v2")
			yield* seen("EDITED v2")
			yield* Effect.sleep("1 second")
			const after = yield* Ref.get(lines)
			const others = Array.filter(after, String.includes("OTHER started"))
			assert.lengthOf(others, 1, Array.join(after, "\n"))
			yield* fs.writeFileString(
				`${directory}/graft.yml`,
				"- id: edited\n  name: ./edited/index.mjs\n",
			)
			yield* seen("other stopped")
			yield* child.kill()
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	40000,
)

it.live(
	"keeps the config file out of artifacts, so editing one entry's config redeploys only that entry (C9)",
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
				'{"name":"start-app-fixture","type":"module"}',
			)
			yield* fs.writeFileString(
				`${directory}/greeter.mjs`,
				`import {Plugin} from ${plugin};import {Effect,Schema} from ${effect};export default Plugin.make({name:"greeter",config:Schema.Struct({greeting:Schema.String}),apply:(c)=>Effect.logInfo("GREETING "+c.greeting)});`,
			)
			yield* fs.writeFileString(
				`${directory}/other.mjs`,
				`import {Plugin} from ${plugin};import {Effect} from ${effect};export default Plugin.make({name:"other",apply:()=>Effect.logInfo("OTHER started")});`,
			)
			const config = (greeting: string) =>
				`- id: greeter\n  name: ./greeter.mjs\n  config:\n    greeting: ${greeting}\n- id: other\n  name: ./other.mjs\n`
			yield* fs.writeFileString(`${directory}/graft.yml`, config("Hello"))
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
					{
						cwd: directory,
						env: { GRAFT_HOME: directory + "/home" },
						extendEnv: true,
					},
				),
			)
			const lines = yield* Ref.make<ReadonlyArray<string>>([])
			yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) => Ref.update(lines, Array.append(line))),
				Effect.forkScoped,
			)
			const seen = (text: string) =>
				Ref.get(lines).pipe(
					Effect.repeat({
						schedule: Schedule.spaced("50 millis"),
						until: Array.some(String.includes(text)),
					}),
					Effect.timeout("20 seconds"),
				)
			yield* seen("GREETING Hello")
			yield* seen("OTHER started")
			yield* fs.writeFileString(`${directory}/graft.yml`, config("Hi"))
			yield* seen("GREETING Hi")
			yield* Effect.sleep("1 second")
			const after = yield* Ref.get(lines)
			assert.lengthOf(
				Array.filter(after, String.includes("OTHER started")),
				1,
				Array.join(after, "\n"),
			)
			yield* child.kill()
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	40000,
)
