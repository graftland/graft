/**
 * Operating-system confinement for Process units. The launcher is trusted kernel code;
 * a missing or failing launcher never falls back to an ordinary process.
 */
import process from "node:process"
import { fileURLToPath } from "node:url"

import {
	Array,
	Cause,
	Config,
	Effect,
	FileSystem,
	Option,
	Path,
	Result,
	Schema,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class SandboxUnavailable extends Schema.TaggedError<
	SandboxUnavailable,
	{ readonly brand: unique symbol }
>()("SandboxUnavailable", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}

export interface Launch {
	readonly executable: string
	readonly args: ReadonlyArray<string>
}

/** The bundled unit entry: inside the sandbox nothing outside the bound paths exists. */
const unitScript = Effect.sync(() =>
	fileURLToPath(
		import.meta.resolve("@graftland/plugin-remote/internal/sandbox-unit"),
	),
)

/**
 * Builds the confined command for a unit that may read only `directories` (the captured
 * artifacts it imports). Linux bubblewrap with fresh user, pid, network, ipc and uts
 * namespaces, no capabilities, a cleared environment, Node's permission model and
 * resource limits; the Node IPC channel on fd 3 is the only way out.
 */
export const prepare = (directories: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (process.platform !== "linux")
			return yield* SandboxUnavailable.make({
				message: "Sandboxed units require Linux bubblewrap",
			})
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const searchPath = yield* Config.String("PATH")
		const search = String.split(searchPath, ":")
		const executable = Effect.fnUntraced(function* (name: string) {
			const found = yield* Effect.findFirst(
				Array.map(search, (directory) => path.resolve(directory, name)),
				(candidate) => fs.exists(candidate),
			)
			if (Option.isNone(found))
				return yield* SandboxUnavailable.make({
					message: "The sandbox launcher requires " + name,
				})
			return yield* fs.realPath(found.value)
		})
		const prlimit = yield* executable("prlimit")
		const bwrap = yield* executable("bwrap")
		const node = yield* fs.realPath(process.execPath)
		const entry = yield* unitScript
		const script = yield* fs.realPath(entry)
		const readable = yield* Effect.forEach(Array.dedupe(directories), (d) =>
			fs.realPath(d),
		)
		// Node's own dynamic loader lists what it maps, including itself. An ldd from
		// PATH may belong to another libc and leave Node unable to start.
		const libraries = yield* Effect.scoped(
			Effect.gen(function* () {
				const traced = yield* spawner.spawn(
					ChildProcess.make(node, [], {
						env: { LD_TRACE_LOADED_OBJECTS: "1" },
						extendEnv: false,
						stdin: "ignore",
					}),
				)
				const [status, output] = yield* Effect.all(
					[traced.exitCode, Stream.mkString(Stream.decodeText(traced.stdout))],
					{ concurrency: 2 },
				)
				const found = Array.dedupe(
					Array.flatMap(String.split(output, "\n"), (line) => {
						const match = /(?:=>\s+)?(\/[^\s]+)\s+\(/.exec(line)
						return match === null ? [] : [match[1]!]
					}),
				)
				if (status !== 0 || found.length === 0)
					return yield* SandboxUnavailable.make({
						message: "Cannot resolve the Node runtime libraries",
					})
				return found
			}),
		)
		const bind = (source: string, target = source) => [
			"--ro-bind",
			source,
			target,
		]
		const args = [
			"--unshare-user",
			"--unshare-ipc",
			"--unshare-pid",
			"--unshare-net",
			"--unshare-uts",
			"--disable-userns",
			"--cap-drop",
			"ALL",
			"--die-with-parent",
			"--new-session",
			// bwrap passes inherited descriptors through; the unit gets stdio and the IPC channel on fd 3.
			"--clearenv",
			"--setenv",
			"NODE_CHANNEL_FD",
			"3",
			"--setenv",
			"NODE_CHANNEL_SERIALIZATION_MODE",
			"json",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--size",
			"16777216",
			"--tmpfs",
			"/tmp",
			...bind(node, "/node"),
			...bind(script, "/graft/unit.js"),
			...Array.flatMap(readable, (directory) => bind(directory)),
			...Array.flatMap(libraries, (library) => bind(library)),
			"--chdir",
			"/tmp",
			"--",
			"/node",
			"--permission",
			"--allow-fs-read=/graft/unit.js",
			...Array.map(readable, (directory) => `--allow-fs-read=${directory}`),
			"--max-old-space-size=128",
			"/graft/unit.js",
		]
		return {
			executable: prlimit,
			args: ["--nofile=256", "--fsize=16777216", "--", bwrap, ...args],
		} satisfies Launch
	}).pipe(
		Effect.catchCause((cause) => {
			if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
			const error = Cause.findError(cause)
			return Result.isSuccess(error) &&
				Schema.is(SandboxUnavailable)(error.success)
				? Effect.fail(error.success)
				: SandboxUnavailable.make({
						message:
							"Preparing the sandbox failed; no unconfined process is started",
						cause,
					})
		}),
	)
