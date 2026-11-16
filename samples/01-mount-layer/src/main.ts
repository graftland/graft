import { Effect, Layer, Logger } from "effect"

import { Graft } from "@graftland/graft"

import { program } from "./program.ts"

await Effect.runPromise(
	program.pipe(
		Effect.scoped,
		Effect.orDie,
		Effect.provide(
			Layer.provideMerge(Graft.layer, Logger.layer([Logger.consolePretty()])),
		),
	),
)
