import { Effect, FileSystem, Option, Path } from "effect"

import { isOnlyFailure } from "./recovery"

/** Resolve an existing referent, or a missing regular file in its canonical parent directory. */
export const fileTarget = Effect.fnUntraced(function* (entry: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	return yield* fs.realPath(entry).pipe(
		Effect.catchCauseIf(
			(cause) =>
				isOnlyFailure(cause, (error) => error.reason._tag === "NotFound"),
			Effect.fnUntraced(function* (cause) {
				const info = yield* fs.lstat(entry).pipe(
					Effect.asSome,
					Effect.catchCauseIf(
						(cause) =>
							isOnlyFailure(cause, (error) => error.reason._tag === "NotFound"),
						() => Effect.succeedNone,
					),
				)
				// A dangling link is an existing entry, not permission to replace it.
				if (Option.isSome(info)) return yield* Effect.failCause(cause)
				const parent = yield* fs.realPath(path.dirname(entry))
				return path.join(parent, path.basename(entry))
			}),
		),
	)
})
