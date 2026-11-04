import { Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Schema,
	Sink,
	Stdio,
	Stream,
} from "effect"
import { Peer } from "../Auth"
import { Supervisor } from "../Supervisor"
import { TransportError } from "../Errors"
import { ServeLifecycle } from "../internal/ServeLifecycle"
import { EndOfStream } from "../internal/runner/Framing"

export const Config = Schema.Struct({
	identity: Schema.String.pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("anonymous")),
	),
	auth: Schema.optionalKey(Schema.Never),
})
const ended = (cause: Cause.Cause<unknown>): boolean =>
	cause.reasons.length > 0 &&
	Array.every(
		cause.reasons,
		(reason) =>
			reason._tag === "Fail" &&
			(Schema.is(TransportError)(reason.error)
				? ended(reason.error.cause)
				: Schema.is(EndOfStream)(reason.error)),
	)
export default Plugin.make({
	name: "remote-stdio-listener",
	config: Config,
	inject: [Supervisor, Stdio.Stdio, ServeLifecycle],
	apply: Effect.fnUntraced(function* (config) {
		const supervisor = yield* Supervisor
		const stdio = yield* Stdio.Stdio
		const lifecycle = yield* ServeLifecycle
		const channel = {
			input: stdio.stdin.pipe(
				Stream.mapError((error) =>
					TransportError.make({ cause: Cause.fail(error) }),
				),
			),
			output: stdio
				.stdout({ endOnDone: false })
				.pipe(
					Sink.mapError((error) =>
						TransportError.make({ cause: Cause.fail(error) }),
					),
				),
		}
		yield* Plugin.fork(
			supervisor.accept(channel).pipe(
				Effect.provideService(Peer, config.identity),
				Effect.scoped,
				Effect.catchCauseIf(
					(cause: Cause.Cause<TransportError>) => ended(cause),
					() => Effect.void,
				),
				Effect.onExit((exit) => Deferred.done(lifecycle.ended, exit)),
			),
		)
	}),
})
