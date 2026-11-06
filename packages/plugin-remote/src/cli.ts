import { Console, Effect } from "effect"
import { CliError, Command, Flag } from "effect/cli"

import { platform } from "@graftland/cli/Application"
import { Commands } from "@graftland/cli/Commands"
import { Plugin } from "@graftland/graft"

const certificates = Command.make(
	"certificates",
	{
		out: Flag.String("out").pipe(
			Flag.withDescription("Directory for the CA and issued certificates"),
		),
		server: Flag.String("server").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"Runner DNS name or IP address; repeat for additional SANs",
			),
		),
		identity: Flag.String("identity").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"Host identity; repeat to issue multiple client certificates",
			),
		),
		days: Flag.Int("days").pipe(
			Flag.withDefault(365),
			Flag.filter(
				(days) => days > 0,
				() => "Days must be a positive integer",
			),
		),
		force: Flag.Boolean("force").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"Replace requested leaf certificates, keeping the existing CA",
			),
		),
	},
	(options) =>
		Effect.promise(() => import("./internal/Certificates")).pipe(
			Effect.uninterruptible,
			Effect.flatMap((Certificates) => Certificates.generate(options)),
			Effect.andThen(Console.log(`Certificates written to ${options.out}`)),
			Effect.mapError((error) =>
				CliError.UserError.make({ cause: error, userMessage: String(error) }),
			),
		),
)

const command = Command.make("remote").pipe(
	Command.withSubcommands([certificates]),
	Command.provide(platform),
)
export default Plugin.make({
	name: "@graftland/plugin-remote/cli",
	inject: [Commands],
	apply: () =>
		Effect.flatMap(Commands, (commands) => commands.register(command)),
})
