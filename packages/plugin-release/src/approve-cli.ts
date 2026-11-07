import { Effect, FileSystem, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"

import { platform } from "@graftland/cli/Application"
import { Commands } from "@graftland/cli/Commands"
import { Plugin, Trust } from "@graftland/graft"

import { common, invoke, overrideRevocations } from "./internal/cliCommand"

const approve = Command.make(
	"approve",
	{
		...common,
		statement: Argument.String("statement"),
		who: Flag.String("who"),
		overrideRevocations,
	},
	(options) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const text = yield* fs.readFileString(options.statement)
			const expected = yield* Schema.decodeEffect(
				Schema.fromJsonString(Trust.Statement),
			)(text)
			yield* invoke(options, {
				_tag: "approve",
				request: {
					expected,
					who: options.who,
					overrideRevocations: options.overrideRevocations,
				},
			})
		}).pipe(
			Effect.mapError((cause) =>
				CliError.UserError.make({
					cause,
					userMessage: "Approval statement could not be read",
				}),
			),
		),
).pipe(Command.provide(platform))
export default Plugin.make({
	name: "@graftland/plugin-release/approve-cli",
	inject: [Commands],
	apply: () =>
		Effect.flatMap(Commands, (commands) => commands.register(approve)),
})
