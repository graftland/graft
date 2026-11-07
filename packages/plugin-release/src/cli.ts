import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import { platform } from "@graftland/cli/Application"
import { Commands } from "@graftland/cli/Commands"
import { Plugin } from "@graftland/graft"

import { common, invoke, overrideRevocations } from "./internal/cliCommand"

const expected = Flag.String("expected")
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
		Command.make("approvals", common, (options) =>
			invoke(options, { _tag: "approvals" }),
		),
		Command.make(
			"revoke",
			{
				...common,
				reference: Argument.String("reference"),
				who: Flag.String("who"),
			},
			(options) =>
				invoke(options, {
					_tag: "revoke",
					references: [options.reference],
					who: options.who,
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
