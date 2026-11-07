import { Effect } from "effect"

import type { Fork } from "@graftland/graft"

import { ExporterError } from "../Exporter"

export const awaitExporter = <I, E>(fork: Fork.Fork<I, E>) =>
	fork.await.pipe(
		Effect.catchCause((cause) => Effect.fail(ExporterError.make({ cause }))),
	)
