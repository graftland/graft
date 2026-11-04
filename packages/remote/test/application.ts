import { ChildProcess, ChildProcessSpawner } from "effect/process"
import process from "node:process"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"

/** Install forwarding modules, not symlinks or build output, in a temporary application. */
export const application = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const installed = directory + "/node_modules/@graftland/plugin-remote"
	const modules = [
		"index",
		"runner/index",
		"host/local",
		"host/worker",
		"host/websocket",
		"host/auth/mtls",
		"host/auth/none",
		"runner/supervisor",
		"runner/websocket",
		"runner/auth/mtls",
		"runner/auth/none",
		"runner/stdio",
		"runner/unix",
		"internal/legacy/runner/websocket",
		"internal/legacy/runner/auth/mtls",
		"internal/legacy/runner/auth/none",
	]
	yield* fs.makeDirectory(installed, { recursive: true })
	const manifest = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.Json),
	)({
		name: "@graftland/plugin-remote",
		type: "module",
		exports: {
			".": "./index.mjs",
			"./runner": "./runner/index.mjs",
			"./*": "./*.mjs",
		},
	})
	yield* fs.writeFileString(installed + "/package.json", manifest)
	yield* Effect.forEach(
		modules,
		Effect.fnUntraced(function* (name) {
			const file = installed + "/" + name + ".mjs"
			const url = new URL("../dist/" + name + ".js", import.meta.url).href
			const quoted = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.String),
			)(url)
			return yield* fs
				.makeDirectory(path.dirname(file), { recursive: true })
				.pipe(
					Effect.andThen(
						fs.writeFileString(file, `export { default } from ${quoted};\n`),
					),
				)
		}),
		{ discard: true },
	)
})

export const runHost = Effect.fnUntraced(function* (directory: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const executable = new URL(
		"../.cache/integration/entry-host.js",
		import.meta.url,
	).pathname
	const child = yield* spawner.spawn(
		ChildProcess.make(process.execPath, [executable, directory], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	)
	const [code, stdout, stderr] = yield* Effect.all(
		[
			child.exitCode,
			child.stdout.pipe(Stream.decodeText(), Stream.mkString),
			child.stderr.pipe(Stream.decodeText(), Stream.mkString),
		],
		{ concurrency: "unbounded" },
	)
	return { code, stdout, stderr }
})

export const installModule = Effect.fnUntraced(function* (
	directory: string,
	name: string,
	url: string,
) {
	const fs = yield* FileSystem.FileSystem
	const root = directory + "/node_modules/" + name
	yield* fs.makeDirectory(root, { recursive: true })
	const manifest = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.Json),
	)({ name, type: "module", exports: "./index.mjs" })
	const quoted = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.String),
	)(url)
	yield* fs.writeFileString(root + "/package.json", manifest)
	yield* fs.writeFileString(
		root + "/index.mjs",
		`export * from ${quoted};\nexport { default } from ${quoted};\n`,
	)
})
