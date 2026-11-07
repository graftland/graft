/** Operator-provided process confinement. A launcher is part of the trusted host. */
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
	Array,
	Cause,
	Config,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Result,
	Schema,
	Stream,
	String,
	type Scope,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { Artifact } from "./Artifact"

export class SandboxError extends Schema.TaggedError<
	SandboxError,
	{ readonly brand: unique symbol }
>()("SandboxError", {
	reason: Schema.Literals([
		"LauncherUnavailable",
		"UnsupportedPlacement",
		"UnsupportedLayout",
	]),
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
export interface Request {
	readonly artifact: Artifact
	readonly contractEntry: string
}
export interface Launch {
	readonly command: readonly [string, ...string[]]
	readonly contractModule: string
	readonly implementation: string
}
export class Launcher extends Context.Service<
	Launcher,
	{
		readonly prepare: (
			request: Request,
		) => Effect.Effect<Launch, SandboxError, Scope.Scope>
	}
>()("@graftland/plugin-remote/Sandbox/Launcher") {}

/** Scoped launcher selection inherited by managed entries, independent of graph dependencies. */
export const Current = Context.Reference<Launcher["Service"] | undefined>(
	"@graftland/plugin-remote/Sandbox/Current",
	{ defaultValue: () => undefined },
)

/** Linux namespaces are mandatory. No unsuccessful probe falls back to an ordinary child. */
export const linux = Layer.effect(
	Launcher,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		return Launcher.of({
			prepare: (request) =>
				Effect.gen(function* () {
					if (process.platform !== "linux")
						return yield* SandboxError.make({
							reason: "LauncherUnavailable",
							message:
								"Untrusted plugins require the Linux bubblewrap launcher",
						})
					const contract = path.normalize(request.contractEntry)
					if (
						path.isAbsolute(contract) ||
						contract === ".." ||
						String.startsWith("../")(contract)
					)
						return yield* SandboxError.make({
							reason: "UnsupportedLayout",
							message:
								"The sandbox contract must be inside the captured artifact",
						})
					const bootstrap = fileURLToPath(
						import.meta.resolve("@graftland/plugin-remote/internal/sandbox"),
					)
					const searchPath = yield* Config.String("PATH")
					const search = String.split(searchPath, ":")
					const executable = Effect.fnUntraced(function* (name: string) {
						const found = yield* Effect.findFirst(
							Array.map(search, (directory) => path.resolve(directory, name)),
							(candidate) => fs.exists(candidate),
						)
						if (Option.isNone(found))
							return yield* SandboxError.make({
								reason: "LauncherUnavailable",
								message: "Sandbox launcher requires " + name,
							})
						return yield* fs.realPath(found.value)
					})
					const prlimit = yield* executable("prlimit")
					const bwrap = yield* executable("bwrap")
					const node = yield* fs.realPath(process.execPath)
					const libraryProcess = yield* spawner.spawn(
						ChildProcess.make("ldd", [node]),
					)
					const [status, output] = yield* Effect.all(
						[
							libraryProcess.exitCode,
							Stream.mkString(Stream.decodeText(libraryProcess.stdout)),
						],
						{ concurrency: 2 },
					)
					if (status !== 0)
						return yield* SandboxError.make({
							reason: "LauncherUnavailable",
							message: "Cannot resolve the trusted Node runtime libraries",
						})
					const libraries = Array.dedupe(
						Array.flatMap(String.split(output, "\n"), (line) => {
							const match = /(?:=>\s+)?(\/[^\s]+)\s+\(/.exec(line)
							return match === null ? [] : [match[1]!]
						}),
					)
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
						"--clearenv",
						"--preserve-fds",
						"1",
						"--proc",
						"/proc",
						"--dev",
						"/dev",
						"--size",
						"16777216",
						"--tmpfs",
						"/tmp",
						"--ro-bind",
						node,
						"/node",
						"--ro-bind",
						bootstrap,
						"/graft/child.js",
						"--ro-bind",
						request.artifact.directory,
						"/app",
						...Array.flatMap(libraries, (library) => [
							"--ro-bind",
							library,
							library,
						]),
						"--chdir",
						"/app",
						"--",
						"/node",
						"--permission",
						"--allow-fs-read=/app",
						"--allow-fs-read=/graft/child.js",
						"--max-old-space-size=128",
						"/graft/child.js",
					]
					// Startup itself checks namespace availability; a failed launch remains a failed unit.
					return {
						command: [
							prlimit,
							"--nofile=256",
							"--fsize=16777216",
							"--",
							bwrap,
							...args,
						] as const,
						contractModule: pathToFileURL(path.join("/app", contract)).href,
						implementation: pathToFileURL(
							path.join("/app", request.artifact.identity.entry),
						).href,
					}
				}).pipe(
					Effect.catchCause((cause) => {
						if (Cause.hasInterrupts(cause))
							return Effect.logError(
								"Sandbox preparation was interrupted",
								cause,
							).pipe(
								Effect.andThen(
									Effect.failCause(
										Cause.fromReasons<never>(
											Array.filter(cause.reasons, Cause.isInterruptReason),
										),
									),
								),
							)
						const error = Cause.findError(cause)
						if (
							Result.isSuccess(error) &&
							Schema.is(SandboxError)(error.success)
						)
							return Effect.fail(error.success)
						return SandboxError.make({
							reason: "LauncherUnavailable",
							message:
								"Sandbox launcher preparation failed; no process fallback is permitted",
							cause,
						})
					}),
				),
		})
	}),
)
