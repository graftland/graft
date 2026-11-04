import { Context, Effect, Schema, Scope } from "effect"
import type { CliError, Command } from "effect/cli"

/** Services available when a registered command runs. Provide other services on the command itself. */
export type Environment = Command.Environment | Scope.Scope

/** A command name, alias, or registration lifetime conflicts with the host. */
export class CommandRegistrationError extends Schema.TaggedError<
	CommandRegistrationError,
	{ readonly brand: unique symbol }
>()("CommandRegistrationError", {
	command: Schema.String,
	detail: Schema.String,
}) {
	override get message() {
		return `${this.command}: ${this.detail}`
	}
}

/** Register one native Effect CLI command tree during the plugin's activation. */
export class Commands extends Context.Service<
	Commands,
	{
		readonly register: <
			const Name extends string,
			Input,
			ContextInput,
			E extends CliError.CliError,
			R extends Environment,
		>(
			command: Command.Command<Name, Input, ContextInput, E, R>,
		) => Effect.Effect<void, CommandRegistrationError, Scope.Scope>
	}
>()("@graftland/cli/Commands") {}

/** A declared command plugin could not be decoded from its config file. */
export class CommandConfigError extends Schema.TaggedError<
	CommandConfigError,
	{ readonly brand: unique symbol }
>()("CommandConfigError", {
	file: Schema.String,
	cause: Schema.Unknown,
}) {
	override get message() {
		return `Cannot read command plugins from ${this.file}`
	}
}
