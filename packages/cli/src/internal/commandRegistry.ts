import { Array, Effect, HashMap, Option, TxRef } from "effect"
import { Command, type CliError } from "effect/cli"
import {
	Commands,
	CommandRegistrationError,
	type Environment,
} from "../Commands"

export type Registered = Command.Command<
	string,
	never,
	{},
	CliError.CliError,
	Environment
>
/** The public register method checks E and R before input/name erasure. */
export const erase = (command: Command.Command.Any): Registered => command

const names = (command: Command.Command.Any) =>
	command.alias === undefined ? [command.name] : [command.name, command.alias]
const validate = (
	commands: ReadonlyArray<Command.Command.Any>,
): Effect.Effect<void, CommandRegistrationError> => {
	const all = Array.flatMap(commands, names)
	const duplicate = Array.findFirst(
		all,
		(name, index) => all.indexOf(name) !== index,
	)
	return Option.isSome(duplicate)
		? Effect.fail(
				CommandRegistrationError.make({
					command: duplicate.value,
					detail: "Duplicate command name or alias",
				}),
			)
		: Effect.forEach(
				commands,
				(command) =>
					validate(
						Array.flatMap(command.subcommands, (group) => group.commands),
					),
				{ discard: true },
			)
}
export const make = Effect.fnUntraced(function* (
	builtins: ReadonlyArray<Command.Command.Any>,
) {
	const state = yield* TxRef.make({
		frozen: false,
		entries: HashMap.empty<string, Registered>(),
	})
	const service = (owner: string) =>
		Commands.of({
			register: (command) =>
				Effect.acquireRelease(
					Effect.gen(function* () {
						const current = yield* TxRef.get(state)
						if (current.frozen)
							return yield* CommandRegistrationError.make({
								command: command.name,
								detail: "Registration is closed",
							})
						if (HashMap.has(current.entries, owner))
							return yield* CommandRegistrationError.make({
								command: command.name,
								detail: "A plugin must register exactly one root command",
							})
						yield* validate([
							...builtins,
							...HashMap.values(current.entries),
							command,
						])
						yield* TxRef.set(state, {
							...current,
							entries: HashMap.set(current.entries, owner, erase(command)),
						})
					}).pipe(Effect.tx),
					() =>
						TxRef.update(state, (current) => ({
							...current,
							entries: HashMap.remove(current.entries, owner),
						})).pipe(Effect.tx),
				),
		})
	const freeze = Effect.gen(function* () {
		const current = yield* TxRef.get(state)
		yield* TxRef.set(state, { ...current, frozen: true })
		return Array.fromIterable(HashMap.values(current.entries))
	}).pipe(Effect.tx)
	return {
		service,
		freeze,
		has: (owner: string) =>
			TxRef.get(state).pipe(
				Effect.map((current) => HashMap.has(current.entries, owner)),
				Effect.tx,
			),
	}
})
