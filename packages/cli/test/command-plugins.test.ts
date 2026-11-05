import { Array, Config, Effect, FileSystem, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const install = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const location = directory + "/node_modules/graft-plugin-hello"
	yield* fs.makeDirectory(location, { recursive: true })
	yield* fs.writeFileString(
		location + "/package.json",
		'{"name":"graft-plugin-hello","type":"module","exports":{"./cli":"./cli.js"}}',
	)
	const target = yield* json(
		new URL("../.cache/integration/command-plugin.mjs", import.meta.url).href,
	)
	yield* fs.writeFileString(
		location + "/cli.js",
		`export { default } from ${target};`,
	)
})
const configure = Effect.fnUntraced(function* (
	directory: string,
	greeting: string,
) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.writeFileString(
		directory + "/graft.yml",
		`
- name: graft-plugin-hello/cli
  cli: true
  config:
    greeting: ${greeting}
- name: ./must-not-load.js
`,
	)
	yield* fs.writeFileString(
		directory + "/must-not-load.js",
		'throw new Error("Business plugins must not run during command discovery")',
	)
})
const run = Effect.fnUntraced(function* (
	cwd: string,
	home: string,
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>> = {},
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const process = yield* spawner.spawn(
		ChildProcess.make(
			globalThis.process.execPath,
			[
				new URL("../.cache/commands/cli/bin.js", import.meta.url).pathname,
				...args,
			],
			{
				cwd,
				env: { GRAFT_HOME: home, ...env },
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	)
	return yield* Effect.all(
		{
			code: process.exitCode,
			stdout: Stream.mkString(Stream.decodeText(process.stdout)),
			stderr: Stream.mkString(Stream.decodeText(process.stderr)),
		},
		{ concurrency: "unbounded" },
	)
})

it.live(
	"discovers only declared command plugins, including help and completions",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			yield* install(directory)
			yield* configure(directory, "Hello")
			for (const args of [
				["hello", "Ada"],
				["--help"],
				["--completions", "bash"],
			]) {
				const result = yield* run(directory, directory + "/home", args)
				assert.equal(result.code, 0, result.stderr)
				assert.include(
					result.stdout,
					Array.contains(args, "Ada") ? "Hello, Ada!" : "hello",
				)
				assert.notInclude(result.stderr, "Business plugins must not run")
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live(
	"loads user commands outside projects and lets project entries override the same module",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const home = directory + "/home"
			yield* install(home)
			yield* configure(home, "Global")
			const global = yield* run(directory, home, ["hello"])
			assert.equal(global.code, 0, global.stderr)
			assert.include(global.stdout, "Global, world!")
			yield* install(directory)
			yield* configure(directory, "Project")
			const project = yield* run(directory, home, ["hello"])
			assert.equal(project.code, 0, project.stderr)
			assert.include(project.stdout, "Project, world!")
			const disabled = yield* run(directory, home, ["--no-plugins", "--help"])
			assert.equal(disabled.code, 0, disabled.stderr)
			assert.notInclude(disabled.stdout, "hello")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("keeps protocol-mode help and version off stdout", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped()
		for (const args of [
			["start", "--stdio", "--help"],
			["--stdio", "--version"],
			["--stdio", "--completions", "bash"],
		]) {
			const result = yield* run(directory, directory + "/home", args)
			assert.equal(result.stdout, "")
			assert.isNotEmpty(result.stderr)
			assert.equal(result.code === 0, !Array.contains(args, "--completions"))
		}
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

for (const global of [false, true]) {
	it.live(
		`graft add --plugin enables a command ${global ? "globally" : "in the project"}`,
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const home = directory + "/home"
				const searchPath = yield* Config.String("PATH").pipe(
					Config.withDefault(""),
				)
				const tools = directory + "/tools"
				yield* fs.makeDirectory(tools)
				yield* fs.writeFileString(
					tools + "/npm",
					`#!${process.execPath}\nprocess.exitCode = 0;\n`,
				)
				yield* fs.chmod(tools + "/npm", 0o755)
				yield* fs.writeFileString(
					directory + "/package.json",
					'{"name":"example","private":true,"packageManager":"npm@10.0.0"}',
				)
				const result = yield* run(
					directory,
					home,
					["add", "--plugin", "remote", ...(global ? ["--global"] : [])],
					{
						PATH: tools + ":" + searchPath,
						npm_config_user_agent: "npm/10.0.0",
					},
				)
				assert.equal(result.code, 0, result.stdout + result.stderr)
				const location = global ? home : directory
				const manifest = yield* fs.readFileString(location + "/package.json")
				const config = yield* fs.readFileString(location + "/graft.yml")
				assert.include(manifest, '"@graftland/plugin-remote": "latest"')
				assert.include(config, "@graftland/plugin-remote/cli")
				assert.include(config, "cli: true")
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	)
}

it.live("activates command providers before waiting for their consumers", () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped()
		const fixture = yield* json(
			new URL("../.cache/integration/command-plugin.mjs", import.meta.url).href,
		)
		for (const name of ["consumer", "provider"])
			yield* fs.writeFileString(
				`${directory}/${name}.mjs`,
				`export { ${name} as default } from ${fixture};`,
			)
		yield* fs.writeFileString(
			directory + "/graft.yml",
			"- name: ./consumer.mjs\n  cli: true\n- name: ./provider.mjs\n  cli: true\n",
		)
		const result = yield* run(directory, directory + "/home", ["greet"])
		assert.equal(result.code, 0, result.stderr)
		assert.include(result.stdout, "Shared greeting")
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live(
	"reserves stdout before command plugins emit any kind of diagnostic",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped()
			const fixture = yield* json(
				new URL("../.cache/integration/command-plugin.mjs", import.meta.url)
					.href,
			)
			yield* fs.writeFileString(
				directory + "/diagnostics.mjs",
				`export { diagnostics as default } from ${fixture};`,
			)
			yield* fs.writeFileString(
				directory + "/graft.yml",
				"- name: ./diagnostics.mjs\n  cli: true\n",
			)
			const result = yield* run(directory, directory + "/home", [
				"--stdio",
				"diagnostic",
			])
			assert.equal(result.code, 0, result.stderr)
			assert.equal(result.stdout, "")
			for (const marker of [
				"TABLE",
				"DIR",
				"DIRXML",
				"GROUP",
				"COUNT",
				"TIME",
				"RAW",
				"LOG",
			])
				assert.include(result.stderr, "DIAGNOSTIC_" + marker)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
