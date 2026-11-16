import { Effect, Logger } from "effect"

import { program } from "./program.ts"

await Effect.runPromise(
	program.pipe(
		Effect.scoped,
		Effect.orDie,
		Effect.provide(Logger.layer([Logger.consolePretty()])),
	),
)
