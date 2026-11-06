import { Console, Effect, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"

import { platform } from "@graftland/cli/Application"
import { Commands } from "@graftland/cli/Commands"
import { Plugin } from "@graftland/graft"

import * as Control from "./Control"

const common = {
	socket: Flag.String("socket"),
	json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
}
const expected = Flag.String("expected")
const overrideRevocations = Flag.Boolean("override-revocations").pipe(
	Flag.withDefault(false),
)
const invoke = Effect.fnUntraced(
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
const command = Command.make("release").pipe(
	Command.withSubcommands([
		Command.make(
			"build",
			{
				...common,
				file: Argument.String("file"),
				references: Flag.String("reference").pipe(Flag.atLeast(0)),
				revocations: Flag.String("revoke").pipe(Flag.atLeast(0)),
			},
			(options) =>
				invoke(options, {
					_tag: "build",
					request: {
						file: options.file,
						references: options.references,
						revocations: options.revocations,
					},
				}),
		),
		Command.make(
			"plan",
			{ ...common, target: Argument.String("target") },
			(options) => invoke(options, { _tag: "plan", target: options.target }),
		),
		Command.make(
			"apply",
			{
				...common,
				target: Argument.String("target"),
				expected,
				overrideRevocations,
			},
			(options) =>
				invoke(options, {
					_tag: "apply",
					request: {
						target: options.target,
						expected: options.expected,
						overrideRevocations: options.overrideRevocations,
					},
				}),
		),
		Command.make(
			"rollback",
			{ ...common, expected, overrideRevocations },
			(options) =>
				invoke(options, {
					_tag: "rollback",
					expected: options.expected,
					overrideRevocations: options.overrideRevocations,
				}),
		),
		Command.make("history", common, (options) =>
			invoke(options, { _tag: "history" }),
		),
		Command.make("status", common, (options) =>
			invoke(options, { _tag: "status" }),
		),
	]),
	Command.provide(platform),
)

export default Plugin.make({
	name: "@graftland/plugin-release/cli",
	inject: [Commands],
	apply: () =>
		Effect.flatMap(Commands, (commands) => commands.register(command)),
})
