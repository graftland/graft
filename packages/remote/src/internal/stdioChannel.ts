import { NodeSink } from "@effect/platform-node"
import { Cause, Effect, Stdio, Stream } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's extra inherited descriptor carries protocol output separately from console output.
import { createWriteStream } from "node:fs"
import { TransportError } from "../Errors"
import type * as Port from "./port"

export const bytes = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const output = yield* Effect.sync(() =>
		createWriteStream("", { fd: 3, autoClose: false }),
	)
	return {
		input: stdio.stdin.pipe(
			Stream.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
		output: NodeSink.fromWritable({
			evaluate: () => output,
			onError: (cause) => TransportError.make({ cause: Cause.die(cause) }),
			endOnDone: false,
		}),
	} satisfies Port.Channel
})
