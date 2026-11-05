import {
	Effect,
	FileSystem,
	Path,
	PlatformError,
	Schema,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class GitError extends Schema.TaggedError<
	GitError,
	{ readonly brand: unique symbol }
>()("GitError", {
	message: Schema.String,
	exitCode: Schema.Int,
}) {}

/** Whether git can make a repository at a path: `missing` when git is not installed. */
export type GitStatus = "available" | "missing" | "inside"

const isMissing = (error: PlatformError.PlatformError) =>
	error.reason._tag === "NotFound"

/** The path itself, or its closest ancestor that exists. */
const existing = (
	directory: string,
): Effect.Effect<
	string,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const parent = path.dirname(directory)
		return (yield* fs.exists(directory)) || parent === directory
			? directory
			: yield* existing(parent)
	})

/** Probes a path, which need not exist yet, from its closest existing ancestor. */
export const probe = Effect.fn("Create.probeGit")(function* (
	directory: string,
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const path = yield* Path.Path
	const cwd = yield* existing(path.resolve(directory))
	return yield* spawner
		.string(
			ChildProcess.make("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd,
				stdin: "ignore",
			}),
		)
		.pipe(
			Effect.map((output): GitStatus =>
				String.trim(output) === "true" ? "inside" : "available",
			),
			Effect.catchIf(isMissing, () => Effect.succeed<GitStatus>("missing")),
		)
})

/**
 * Makes the project a git repository, without a first commit. Skips a project
 * inside another repository or without git, and says which.
 */
export const init = Effect.fn("Create.gitInit")(function* (directory: string) {
	const status = yield* probe(directory)
	if (status !== "available") return status
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(
		ChildProcess.make("git", ["init", "--quiet"], {
			cwd: directory,
			stdin: "ignore",
			stdout: "ignore",
		}),
	)
	const [stderr, exitCode] = yield* Effect.all(
		[Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
		{ concurrency: 2 },
	)
	if (exitCode !== 0)
		return yield* GitError.make({
			message: String.trim(stderr) || `git init exited with code ${exitCode}`,
			exitCode,
		})
	return "initialized" as const
}, Effect.scoped)
