import { Console, Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"

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

const manifest = Command.make(
	"manifest",
	{
		directory: Argument.String("directory").pipe(Argument.withDefault(".")),
		check: Flag.Boolean("check").pipe(Flag.withDefault(false)),
		provenance: Flag.String("provenance").pipe(Flag.optional),
	},
	({ directory, check, provenance }) =>
		Effect.promise(() => import("./Publication")).pipe(
			Effect.uninterruptible,
			Effect.flatMap((Publication) =>
				(check
					? Publication.verify(directory)
					: Publication.write(directory)
				).pipe(
					Effect.tap(() =>
						Option.isSome(provenance)
							? Publication.record(directory, provenance.value)
							: Effect.void,
					),
				),
			),
			Effect.andThen(
				Console.log(
					check ? "Manifest agrees with code" : "Generated graft manifest",
				),
			),
			Effect.mapError((cause) =>
				CliError.UserError.make({ cause, userMessage: cause.message }),
			),
		),
).pipe(
	Command.withDescription("Generate or verify the graft field from built code"),
	Command.provide(platform),
)

const command = Command.make("remote").pipe(
	Command.withSubcommands([certificates, manifest]),
	Command.provide(platform),
)
export default Plugin.make({
	name: "@graftland/plugin-remote/cli",
	inject: [Commands],
	apply: () =>
		Effect.flatMap(Commands, (commands) => commands.register(command)),
})
