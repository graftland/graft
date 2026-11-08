/** Output policy selected before any command or plugin can write to stdout. */
import { Array, Console, Effect, String } from "effect"
import { CliError, CliOutput } from "effect/cli"

import { ProtocolOutput } from "../Application"
import { reserve } from "./protocolOutput"

const usage = (message: string) =>
	Console.error(message).pipe(
		Effect.andThen(
			CliError.UserError.make({
				cause: "Invalid process flags",
				userMessage: message,
			}),
		),
	)

/** Select output policy before discovery or CLI action flags can produce text. */
export const output = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	args: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		const tokens = Array.takeWhile(args, (arg) => arg !== "--")
		const stdio = tokens.includes("--stdio")
		const program = Effect.gen(function* () {
			if (
				stdio &&
				Array.some(
					tokens,
					(arg) =>
						arg === "--wizard" ||
						String.startsWith("--wizard=")(arg) ||
						arg === "--completions" ||
						String.startsWith("--completions=")(arg),
				)
			)
				return yield* usage(
					"--stdio cannot be combined with wizard or completions",
				)
			if (
				Array.some(
					tokens,
					(arg) =>
						String.startsWith("--stdio=")(arg) ||
						arg === "--no-stdio" ||
						String.startsWith("--no-plugins=")(arg),
				)
			)
				return yield* usage("Use --stdio and --no-plugins as standalone flags")
			return yield* effect
		}).pipe(Effect.provideService(ProtocolOutput, stdio))
		return yield* stdio
			? program.pipe(
					reserve,
					Effect.provideService(
						CliOutput.Formatter,
						CliOutput.defaultFormatter({ colors: false }),
					),
				)
			: program
	})
