import { Cause, Effect, FileSystem, Path } from "effect"
import { StateDirectoryLocked } from "./model"

/** SQLite owns the local directory lock for the enclosing scope, including failed startup. */
export const acquire = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* fs.makeDirectory(directory, { recursive: true })
		const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"))
		const locked = (cause: unknown) =>
			StateDirectoryLocked.make({
				detail:
					"The runner state directory is already owned or cannot be locked",
				cause: Cause.die(cause),
			})
		const db = yield* Effect.acquireRelease(
			Effect.try({
				try: () => new DatabaseSync(path.join(directory, "owner.sqlite")),
				catch: locked,
			}),
			(db) => Effect.sync(() => db.close()),
		)
		yield* Effect.try({ try: () => db.exec("BEGIN EXCLUSIVE"), catch: locked })
	})
