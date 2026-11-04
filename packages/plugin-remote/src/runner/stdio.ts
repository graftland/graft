import { Graft, Plugin } from "@graftland/graft"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Option,
	Schema,
	Sink,
	Stdio,
	Stream,
} from "effect"
import { Listener, type Accept } from "../Transport"
import { TransportError } from "../Errors"
import * as Release from "@graftland/graft/Release"

export const Config = Schema.Struct({ auth: Schema.optionalKey(Schema.Never) })
export default Plugin.make({
	name: "remote-stdio-listener",
	config: Config,
	inject: [Stdio.Stdio],
	apply: Effect.fnUntraced(function* () {
		const stdio = yield* Stdio.Stdio
		yield* Graft.provide(Listener, {
			properties: {
				protocol: "stdio",
				encrypted: false,
				network: false,
				carries: [],
			},
			bind: Effect.fnUntraced(function* () {
				const ready = yield* Deferred.make<void>()
				const eof = yield* Deferred.make<void>()
				const channel = {
					input: stdio.stdin.pipe(
						Stream.onExit((exit) =>
							Exit.isSuccess(exit)
								? Deferred.succeed(eof, undefined)
								: Effect.void,
						),
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
				return {
					ready: Deferred.await(ready),
					serve: (accept: Accept) =>
						accept({
							authorization: Option.none(),
							certificate: Option.none(),
						}).pipe(
							Effect.mapError((error) =>
								TransportError.make({ cause: Cause.fail(error) }),
							),
							Effect.flatMap((session) =>
								Deferred.succeed(ready, undefined).pipe(
									Effect.andThen(session(channel)),
								),
							),
							Release.scoped,
							// Successful session completion alone is not EOF.
							Effect.andThen(Deferred.await(eof)),
						),
				}
			}),
		})
	}),
})
