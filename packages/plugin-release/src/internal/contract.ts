import { createRequire } from "node:module"

import { Cause, Effect, FileSystem, Path, String } from "effect"

import { ReleaseError } from "../Model"

/** Resolve once at the release source, never relative to the Remote runtime. */
export const resolveContract = Effect.fnUntraced(function* (
	origin: string,
	specifier: string,
) {
	const path = yield* Path.Path
	const fs = yield* FileSystem.FileSystem
	const base = yield* path.toFileUrl(origin)
	const file = yield* Effect.try({
		try: () => {
			if (String.startsWith("file:")(specifier)) {
				const url = new URL(specifier)
				if (url.search !== "" || url.hash !== "")
					throw new Error(
						"Contract file URLs must not contain a query or fragment",
					)
				return url
			}
			if (/^[a-z][a-z0-9+.-]*:/i.test(specifier))
				throw new Error(
					"Only file URLs and Node module specifiers are supported",
				)
			return createRequire(base).resolve(specifier)
		},
		catch: (cause) =>
			ReleaseError.make({
				code: "Contract",
				message: "Cannot resolve contract from release source: " + specifier,
				cause: Cause.fail(cause),
			}),
	})
	const filename =
		typeof file === "string" ? file : yield* path.fromFileUrl(file)
	const resolved = yield* fs.realPath(filename)
	return (yield* path.toFileUrl(resolved)).href
})
