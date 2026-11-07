import { Console, Effect, Schema } from "effect"
import { CliError, Flag } from "effect/cli"

import * as Control from "../Control"

export const common = {
	socket: Flag.String("socket"),
	json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
}
export const overrideRevocations = Flag.Boolean("override-revocations").pipe(
	Flag.withDefault(false),
)
export const invoke = Effect.fnUntraced(
	function* (
		options: { readonly socket: string; readonly json: boolean },
		request: Control.Request,
	) {
		const reply = yield* Control.call(options.socket, request)
		const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
			reply,
		)
		yield* Console.log(
			options.json ? text : `${reply.ok ? "Accepted" : "Rejected"}: ${text}`,
		)
		if (!reply.ok)
			return yield* CliError.UserError.make({
				cause: reply,
				userMessage: "Release command rejected",
			})
	},
	Effect.mapError((cause) =>
		CliError.UserError.make({ cause, userMessage: "Release command failed" }),
	),
)
