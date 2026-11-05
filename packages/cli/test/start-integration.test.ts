import {
	Array,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Queue,
	Ref,
	Schema,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

const pluginUrl = new URL("../.cache/integration/plugin.mjs", import.meta.url)
const runtimeUrl = new URL("../.cache/integration/runtime.mjs", import.meta.url)
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

// A fresh Node process exercises Start's real layers and native module hooks.
describe("CLI configuration startup", () => {
	it.live.each([false, true])(
		"handles invalid initial YAML (watch: %s)",
		(watch) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const file = `${directory}/graft.yml`
				const plugin = yield* quote(pluginUrl.href)
				const effect = yield* quote(import.meta.resolve("effect"))
				yield* fs.writeFileString(file, "plugins: [\n")
				yield* fs.writeFileString(
					`${directory}/plugin.mjs`,
					`
import { Plugin } from ${plugin};
import { Effect } from ${effect};
export default Plugin.make({ name: 'recovered', apply: () => Effect.logInfo('RECOVERED_MARKER') });
`,
				)
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
				const child = yield* spawner.spawn(
					ChildProcess.make(
						process.execPath,
						[
							new URL("../.cache/commands/cli/bin.js", import.meta.url)
								.pathname,
							"start",
							file,
							...(watch ? ["--watch"] : []),
						],
						{ cwd: directory, env: { GRAFT_HOME: directory + "/home" } },
					),
				)
				const invalid = yield* Deferred.make<void>()
				const recovered = yield* Deferred.make<void>()
				const lines = yield* Ref.make("")
				const output = yield* child.all.pipe(
					Stream.decodeText(),
					Stream.splitLines,
					Stream.runForEach((line) =>
						Effect.gen(function* () {
							yield* Ref.update(lines, (text) => `${text}${line}\n`)
							if (String.includes("YAMLParseError")(line))
								yield* Deferred.succeed(invalid, undefined)
							if (String.includes("RECOVERED_MARKER")(line))
								yield* Deferred.succeed(recovered, undefined)
						}),
					),
					Effect.forkChild,
				)
				if (watch) {
					const ended = Fiber.join(output).pipe(
						Effect.andThen(Effect.die("CLI exited before recovery")),
					)
					yield* Deferred.await(invalid).pipe(Effect.raceFirst(ended))
					yield* fs.writeFileString(
						file,
						"- id: recovered\n  name: ./plugin.mjs\n",
					)
					yield* Deferred.await(recovered).pipe(Effect.raceFirst(ended))
					yield* child.kill()
				}
				const code = yield* child.exitCode
				yield* Fiber.join(output)
				const text = yield* Ref.get(lines)
				assert.include(text, "YAMLParseError")
				if (watch) assert.include(text, "RECOVERED_MARKER")
				else {
					assert.notStrictEqual(code, 0)
					assert.notInclude(text, "Running ")
				}
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
})

it.live(
	"unloads a module lease before reloading the remaining configured plugin",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = `${directory}/graft.yml`
			const runtime = yield* quote(runtimeUrl.href)
			const plugin = yield* quote(pluginUrl.href)
			const effect = yield* quote(import.meta.resolve("effect"))
			const node = yield* quote(import.meta.resolve("@effect/platform-node"))
			const config = yield* quote(file)
			const source = (
				name: string,
			) => `import { Plugin } from ${plugin}; import { Effect } from ${effect};
export default Plugin.make({ name: '${name}', apply: () => Effect.acquireRelease(
Effect.logInfo('START ${name}'), () => Effect.logInfo('STOP ${name}')) });`
			yield* fs.writeFileString(`${directory}/a.mjs`, source("a1"))
			yield* fs.writeFileString(`${directory}/b.mjs`, source("b1"))
			yield* fs.writeFileString(
				file,
				"- id: a\n  name: ./a.mjs\n- id: b\n  name: ./b.mjs\n",
			)
			const startedA = yield* Deferred.make<void>()
			const startedB = yield* Deferred.make<void>()
			const stoppedA = yield* Deferred.make<void>()
			const updatedB = yield* Deferred.make<void>()
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [
					"--input-type=module",
					"-e",
					`
import { Start } from ${runtime}; import { NodeRuntime } from ${node};
Start.run({ config: ${config}, watch: true }).pipe(NodeRuntime.runMain);`,
				]),
			)
			const output = yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) =>
					Effect.gen(function* () {
						if (String.includes("START a1")(line))
							yield* Deferred.succeed(startedA, undefined)
						if (String.includes("START b1")(line))
							yield* Deferred.succeed(startedB, undefined)
						if (String.includes("STOP a1")(line))
							yield* Deferred.succeed(stoppedA, undefined)
						if (String.includes("START b2")(line))
							yield* Deferred.succeed(updatedB, undefined)
					}),
				),
				Effect.forkChild,
			)
			const ended = Fiber.join(output).pipe(
				Effect.andThen(Effect.die("CLI exited before reloading")),
			)
			yield* Effect.gen(function* () {
				yield* Deferred.await(startedA)
				yield* Deferred.await(startedB)
				yield* fs.writeFileString(file, "- id: b\n  name: ./b.mjs\n")
				yield* Deferred.await(stoppedA)
				yield* fs.writeFileString(`${directory}/a.mjs`, "export default ???")
				yield* fs.writeFileString(`${directory}/b.mjs`, source("b2"))
				yield* Deferred.await(updatedB)
			}).pipe(Effect.raceFirst(ended))
			yield* child.kill()
			yield* Fiber.join(output)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live.each(["require-esm", "cached-commonjs", "symlink", "helper-symlink"])(
	"reports a restart instead of stale success for %s",
	(scenario) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const temporary = yield* fs.makeTempDirectoryScoped()
			const directory = yield* fs.realPath(temporary)
			const file = `${directory}/graft.yml`
			const runtime = yield* quote(runtimeUrl.href)
			const plugin = yield* quote(pluginUrl.href)
			const effect = yield* quote(import.meta.resolve("effect"))
			const node = yield* quote(import.meta.resolve("@effect/platform-node"))
			const config = yield* quote(file)
			const header = `import { Plugin } from ${plugin}; import { Effect } from ${effect};`
			const extension = scenario === "require-esm" ? "mjs" : "cjs"
			const required = (name: string) => `${header}
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
export default Plugin.make({ name: '${name}', apply: () => Effect.logInfo('START ${name}=' + require('./dep.${extension}').value) });`
			const plain = (name: string) =>
				`${header} export default Plugin.make({ name: '${name}', apply: () => Effect.logInfo('START ${name}') });`
			const write = (name: string, text: string) =>
				fs.writeFileString(`${directory}/${name}`, text)
			if (scenario === "symlink" || scenario === "helper-symlink") {
				yield* write("one.mjs", plain("one"))
				yield* write("two.mjs", plain("two"))
				const link = scenario === "symlink" ? "a.mjs" : "helper.mjs"
				yield* fs.symlink("one.mjs", `${directory}/${link}`)
				if (scenario === "helper-symlink")
					yield* write("a.mjs", "export { default } from './helper.mjs'")
			} else {
				yield* write(
					`dep.${extension}`,
					extension === "mjs"
						? "export const value = 1"
						: "module.exports = { value: 1 }",
				)
				yield* write("a.mjs", required("a"))
				yield* write("b.mjs", required("b"))
			}
			yield* write("graft.yml", "- id: a\n  name: ./a.mjs\n")
			const started = yield* Deferred.make<void>()
			const switched = yield* Deferred.make<void>()
			const restart = yield* Deferred.make<void>()
			const edited = yield* Deferred.make<void>()
			const output = yield* Ref.make("")
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [
					"--input-type=module",
					"-e",
					`import { Start } from ${runtime}; import { NodeRuntime } from ${node}; Start.run({ config: ${config}, watch: true }).pipe(NodeRuntime.runMain);`,
				]),
			)
			const reading = yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) =>
					Effect.gen(function* () {
						yield* Ref.update(output, (text) => `${text}${line}\n`)
						if (
							String.includes(
								scenario === "symlink" || scenario === "helper-symlink"
									? "START one"
									: "START a=1",
							)(line)
						)
							yield* Deferred.succeed(started, undefined)
						if (String.includes("START b=1")(line))
							yield* Deferred.succeed(switched, undefined)
						if (
							String.includes("Restart required")(line) &&
							(scenario === "require-esm" ||
								scenario === "cached-commonjs" ||
								(yield* Deferred.isDone(edited)))
						)
							yield* Deferred.succeed(restart, undefined)
					}),
				),
				Effect.forkChild,
			)
			const ended = Fiber.join(reading).pipe(
				Effect.andThen(
					Effect.die("CLI exited before reporting the restart requirement"),
				),
			)
			yield* Effect.gen(function* () {
				yield* Deferred.await(started)
				if (scenario === "cached-commonjs") {
					yield* write("graft.yml", "- id: b\n  name: ./b.mjs\n")
					yield* Deferred.await(switched)
				}
				yield* Deferred.succeed(edited, undefined)
				if (scenario === "symlink" || scenario === "helper-symlink") {
					const link = scenario === "symlink" ? "a.mjs" : "helper.mjs"
					yield* fs.remove(`${directory}/${link}`)
					yield* fs.symlink("two.mjs", `${directory}/${link}`)
				} else
					yield* write(
						`dep.${extension}`,
						extension === "mjs"
							? "export const value = 2"
							: "module.exports = { value: 2 }",
					)
				yield* Deferred.await(restart)
			}).pipe(
				Effect.raceFirst(ended),
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Ref.get(output).pipe(
								Effect.flatMap((text) =>
									Effect.logError(
										"CLI output before failure",
										text,
										exit.cause,
									),
								),
							)
						: Effect.void,
				),
			)
			yield* child.kill()
			yield* Fiber.join(reading)
			const text = yield* Ref.get(output)
			assert.include(text, "Restart required")
			if (scenario !== "symlink" && scenario !== "helper-symlink")
				assert.notInclude(text, "Reloaded 1 plugin module(s)")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live.each(["once", "watch", "symlink"])(
	"reads !env from an env file after the process environment (%s)",
	(mode) =>
		Effect.gen(function* () {
			const watch = mode !== "once"
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = `${directory}/graft.yml`
			const runtime = yield* quote(runtimeUrl.href)
			const plugin = yield* quote(pluginUrl.href)
			const effect = yield* quote(import.meta.resolve("effect"))
			const node = yield* quote(import.meta.resolve("@effect/platform-node"))
			const config = yield* quote(file)
			const envFile = yield* quote(`${directory}/.env`)
			yield* fs.writeFileString(
				`${directory}/plugin.mjs`,
				`
import { Plugin } from ${plugin};
import { Effect, Redacted, Schema } from ${effect};
export default Plugin.make({
	name: 'env',
	config: Schema.Struct({ file: Schema.String, shared: Schema.RedactedFromValue(Schema.String), empty: Schema.String }),
	apply: (config) => Effect.logInfo('VALUES file=' + config.file + ' shared=' + Redacted.value(config.shared) + ' empty=[' + config.empty + ']'),
});
`,
			)
			const targetDirectory = yield* fs.makeTempDirectoryScoped()
			if (mode === "symlink") {
				yield* fs.writeFileString(`${targetDirectory}/values.env`, "")
				yield* fs.symlink(`${targetDirectory}/values.env`, `${directory}/.env`)
			}
			yield* fs.writeFileString(
				`${directory}/.env`,
				"GRAFT_TEST_FILE=file\nGRAFT_TEST_SHARED=file\nGRAFT_TEST_EMPTY=file\n",
			)
			yield* fs.writeFileString(
				file,
				"- id: env\n  name: ./plugin.mjs\n  config:\n    file: !env GRAFT_TEST_FILE\n    shared: !env GRAFT_TEST_SHARED\n    empty: !env GRAFT_TEST_EMPTY\n",
			)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`
import { Start } from ${runtime}; import { NodeRuntime } from ${node};
Start.run({ config: ${config}, watch: ${watch}, envFile: ${envFile} }).pipe(NodeRuntime.runMain);`,
					],
					{
						env: { GRAFT_TEST_SHARED: "process", GRAFT_TEST_EMPTY: "" },
						extendEnv: true,
					},
				),
			)
			const values = yield* Queue.unbounded<string>()
			const output = yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.runForEach((line) =>
					String.includes("VALUES")(line)
						? Queue.offer(values, line)
						: Effect.void,
				),
				Effect.forkChild,
			)
			const ended = Fiber.join(output).pipe(
				Effect.andThen(Effect.die("CLI exited before loading the plugin")),
			)
			const first = yield* Queue.take(values).pipe(Effect.raceFirst(ended))
			assert.include(first, "file=file shared=process empty=[]")
			if (watch) {
				if (mode === "symlink") yield* Effect.sleep("1500 millis")
				yield* fs.writeFileString(
					`${directory}/.env`,
					"GRAFT_TEST_FILE=edited\nGRAFT_TEST_SHARED=file\nGRAFT_TEST_EMPTY=file\n",
				)
				const second = yield* Queue.take(values).pipe(Effect.raceFirst(ended))
				assert.include(second, "file=edited shared=process empty=[]")
			}
			yield* child.kill()
			yield* Fiber.join(output)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("recovers an initially invalid module through polling alone", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const temporary = yield* fs.makeTempDirectoryScoped()
		const directory = yield* fs.realPath(temporary)
		const runtime = yield* quote(runtimeUrl.href)
		const plugin = yield* quote(pluginUrl.href)
		const effect = yield* quote(import.meta.resolve("effect"))
		const node = yield* quote(import.meta.resolve("@effect/platform-node"))
		const config = yield* quote(`${directory}/graft.yml`)
		yield* fs.writeFileString(
			`${directory}/graft.yml`,
			"- id: broken\n  name: ./plugin.mjs\n",
		)
		yield* fs.writeFileString(`${directory}/plugin.mjs`, "export default ???")
		yield* fs.writeFileString(
			`${directory}/preload.mjs`,
			`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const watch = fs.watch;
fs.watch = (path, options, callback) => watch(path, options, (event, file) => {
	if (String(file) !== 'plugin.mjs') callback(event, file);
});
syncBuiltinESMExports();
`,
		)
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const child = yield* spawner.spawn(
			ChildProcess.make(process.execPath, [
				"--import",
				`${directory}/preload.mjs`,
				"--input-type=module",
				"-e",
				`import { Start } from ${runtime}; import { NodeRuntime } from ${node}; Start.run({ config: ${config}, watch: true }).pipe(NodeRuntime.runMain);`,
			]),
		)
		const failed = yield* Deferred.make<void>()
		const recovered = yield* Deferred.make<void>()
		const lines = yield* Ref.make("")
		const output = yield* child.all.pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.runForEach((line) =>
				Effect.gen(function* () {
					yield* Ref.update(lines, (text) => `${text}${line}\n`)
					if (String.includes("SyntaxError")(line))
						yield* Deferred.succeed(failed, undefined)
					if (String.includes("RECOVERED_BY_POLLING")(line))
						yield* Deferred.succeed(recovered, undefined)
				}),
			),
			Effect.forkChild,
		)
		const ended = Fiber.join(output).pipe(
			Effect.andThen(Effect.die("CLI exited before polling recovery")),
		)
		yield* Effect.gen(function* () {
			yield* Deferred.await(failed)
			yield* fs.writeFileString(
				`${directory}/plugin.mjs`,
				`import { Plugin } from ${plugin}; import { Effect } from ${effect}; export default Plugin.make({ name: 'recovered', apply: () => Effect.logInfo('RECOVERED_BY_POLLING') });`,
			)
			yield* Deferred.await(recovered)
		}).pipe(
			Effect.raceFirst(ended),
			Effect.onExit((exit) =>
				Exit.isFailure(exit)
					? Ref.get(lines).pipe(
							Effect.flatMap((text) =>
								Effect.logError(
									"CLI output before polling recovery failed",
									text,
									exit.cause,
								),
							),
						)
					: Effect.void,
			),
		)
		yield* child.kill()
		yield* Fiber.join(output)
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live.each(
	Array.flatMap(["local", "worker"], (target) =>
		Array.map(
			[
				{ failure: "none", repair: "contract" },
				{ failure: "import", repair: "contract" },
				{ failure: "import", repair: "dependency" },
				{ failure: "exports", repair: "contract" },
				{ failure: "exports", repair: "dependency" },
				{ failure: "startup", repair: "contract" },
				{ failure: "startup", repair: "dependency" },
				{ failure: "startup", repair: "implementation" },
			],
			(scenario) => ({ target, ...scenario }),
		),
	),
)(
	"reloads remote $target after $failure failure repaired in $repair",
	({ target, failure, repair }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const file = `${directory}/host.yml`
			const runtime = yield* quote(runtimeUrl.href)
			const plugin = yield* quote(pluginUrl.href)
			const effect = yield* quote(import.meta.resolve("effect"))
			const node = yield* quote(import.meta.resolve("@effect/platform-node"))
			const config = yield* quote(file)
			const remote = new URL("../.cache/remote/", import.meta.url)
			const contract = yield* quote(new URL("Contract.js", remote).href)
			const installation = `${directory}/node_modules/@graftland/plugin-remote`
			yield* fs.makeDirectory(installation, { recursive: true })
			yield* fs.writeFileString(
				`${installation}/package.json`,
				'{"type":"module","exports":{".":"./index.mjs","./host/local":"./local.mjs","./host/worker":"./worker.mjs"}}',
			)
			yield* Effect.forEach(
				[
					{ file: "index", source: "index" },
					{ file: "local", source: "host/local" },
					{ file: "worker", source: "host/worker" },
				],
				({ file, source }) =>
					quote(new URL(`${source}.js`, remote).href).pipe(
						Effect.flatMap((url) =>
							fs.writeFileString(
								`${installation}/${file}.mjs`,
								`export { default } from ${url};`,
							),
						),
					),
			)
			yield* fs.writeFileString(
				`${directory}/contract.mjs`,
				`
import { make } from ${contract};
import { Schema } from ${effect};
import { valid, selected } from './helper.mjs';
export const contract = valid ? make({ name: 'cli-remote', config: Schema.String,
module: new URL(selected ?? './implementation.mjs', import.meta.url).href }) : undefined;
`,
			)
			const validContract = yield* fs.readFileString(
				`${directory}/contract.mjs`,
			)
			const validHelper =
				"export const valid = true; export const selected = undefined;"
			yield* fs.writeFileString(`${directory}/helper.mjs`, validHelper)
			if (failure === "import")
				yield* fs.writeFileString(
					`${directory}/${repair === "dependency" ? "helper" : "contract"}.mjs`,
					"export const broken = ;",
				)
			if (failure === "exports")
				yield* fs.writeFileString(
					`${directory}/${repair === "dependency" ? "helper" : "contract"}.mjs`,
					repair === "dependency"
						? "export const valid = false; export const selected = undefined;"
						: "export const wrongName = 1;",
				)
			const implementation = (marker: string) => `
import { Plugin } from ${plugin};
import { Effect, Schema } from ${effect};
export default Plugin.make({ name: 'remote-implementation', config: Schema.String,
apply: (value) => Effect.acquireRelease(Effect.logInfo('${marker} ' + value),
() => Effect.logInfo('REMOTE_STOPPED')) });
`
			yield* fs.writeFileString(
				`${directory}/implementation.mjs`,
				implementation("REMOTE_STARTED"),
			)
			if (failure === "startup")
				yield* fs.writeFileString(
					`${directory}/implementation.mjs`,
					"export default ;",
				)

			const executable = yield* quote(process.execPath)
			const bin = yield* quote(
				new URL("internal/childMain.js", remote).pathname,
			)
			yield* fs.writeFileString(
				file,
				`
- id: remote
  name: remote
  config:
    contract: ./contract.mjs
    connect:
      ${target === "local" ? `local: { command: [${executable}, ${bin}] }` : "worker: { execArgv: [] }"}
    config: hello
`,
			)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [
					"--input-type=module",
					"-e",
					`
import { Start } from ${runtime}; import { NodeRuntime } from ${node};
Start.run({ config: ${config}, watch: true }).pipe(NodeRuntime.runMain);`,
				]),
			)
			const started = yield* Deferred.make<void>()
			const messages = yield* Queue.unbounded<string>()
			const output = yield* child.all.pipe(
				Stream.decodeText(),
				Stream.splitLines,
				Stream.tap((line) => Queue.offer(messages, line)),
				Stream.tap((line) =>
					String.includes("REMOTE_STARTED hello")(line)
						? Deferred.succeed(started, undefined)
						: Effect.void,
				),
				Stream.runFold(
					() => "",
					(text, line) => `${text}${line}\n`,
				),
				Effect.forkChild,
			)
			if (failure !== "none") {
				yield* Queue.take(messages).pipe(
					Effect.repeat({
						until: (line) =>
							String.includes(
								failure === "startup"
									? "ModuleImportFailed"
									: "could not be loaded",
							)(line),
					}),
				)
				if (failure === "startup") {
					if (repair === "implementation")
						yield* fs.writeFileString(
							`${directory}/implementation.mjs`,
							implementation("REMOTE_STARTED"),
						)
					else {
						yield* fs.writeFileString(
							`${directory}/fixed.mjs`,
							implementation("REMOTE_STARTED"),
						)
						if (repair === "contract")
							yield* fs.writeFileString(
								`${directory}/contract.mjs`,
								String.replace(
									"./implementation.mjs",
									"./fixed.mjs",
								)(validContract),
							)
						else
							yield* fs.writeFileString(
								`${directory}/helper.mjs`,
								"export const valid = true; export const selected = './fixed.mjs';",
							)
					}
				} else
					yield* fs.writeFileString(
						`${directory}/${repair === "dependency" ? "helper" : "contract"}.mjs`,
						repair === "dependency" ? validHelper : validContract,
					)
			}
			yield* Deferred.await(started).pipe(
				Effect.raceFirst(
					Fiber.join(output).pipe(
						Effect.flatMap((text) =>
							Effect.die(`CLI exited before remote activation: ${text}`),
						),
					),
				),
			)
			const waitFor = (marker: string) =>
				Queue.take(messages).pipe(
					Effect.repeat({ until: (line) => String.includes(marker)(line) }),
					Effect.raceFirst(
						Fiber.join(output).pipe(Effect.flatMap((text) => Effect.die(text))),
					),
				) // Keep the same process alive through a failed reload and a repair of its implementation.
			const running =
				failure === "startup" && repair !== "implementation"
					? "fixed"
					: "implementation"
			yield* fs.writeFileString(
				`${directory}/${running}.mjs`,
				"export default ;",
			)
			yield* waitFor("ModuleImportFailed")
			yield* fs.writeFileString(
				`${directory}/${running}.mjs`,
				implementation("REMOTE_UPDATED"),
			)
			yield* waitFor("REMOTE_UPDATED hello")
			if (failure === "startup" && repair !== "implementation") {
				yield* child.kill()
				const text = yield* Fiber.join(output)
				assert.include(text, "REMOTE_STOPPED")
				return
			}

			yield* fs.writeFileString(
				`${directory}/next.mjs`,
				implementation("CONTRACT_UPDATED"),
			)
			const original = yield* fs.readFileString(`${directory}/contract.mjs`)
			yield* fs.writeFileString(
				`${directory}/contract.mjs`,
				String.replace("./implementation.mjs", "./next.mjs")(original),
			)
			yield* waitFor("CONTRACT_UPDATED hello")
			yield* fs.writeFileString(
				`${directory}/next.mjs`,
				implementation("NEXT_UPDATED"),
			)
			yield* waitFor("NEXT_UPDATED hello")

			yield* child.kill()
			const text = yield* Fiber.join(output)
			assert.include(text, "REMOTE_STARTED hello")
			assert.include(text, "REMOTE_STOPPED")
			assert.notInclude(text, "Remote source watcher stopped")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	// Up to four reload rounds, each restarting the remote child process.
	20_000,
)
