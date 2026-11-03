import { Cause, Effect, FileSystem, Path } from "effect"
import { failure } from "./model"

/** Local-filesystem exclusive ownership; no PID file or stale-lock deletion race. */
export const acquire = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* fs.makeDirectory(directory, { recursive: true })
		const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"))
		yield* Effect.acquireRelease(
			Effect.try({
				try: () => {
					const db = new DatabaseSync(path.join(directory, "owner.sqlite"))
					try {
						db.exec("BEGIN EXCLUSIVE")
						return db
					} catch (error) {
						db.close()
						throw error
					}
				},
				catch: (cause) =>
					failure(
						"Conflict",
						"The runner state directory is already owned or cannot be locked",
						Cause.die(cause),
					),
			}),
			(db) => Effect.sync(() => db.close()),
		)
	})
