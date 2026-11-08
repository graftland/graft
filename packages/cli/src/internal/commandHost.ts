import {
	Array,
	Cause,
	Effect,
	Layer,
	Option,
	Path,
	Schema,
	Stream,
	String,
} from "effect"
import { CliError, Command } from "effect/cli"

import { Graft, Plugin, type Fork } from "@graftland/graft"

import { Commands, type Environment } from "../Commands"
import * as Configuration from "./commandConfig"
import * as Registry from "./commandRegistry"
import * as Inspection from "./inspection"

class CommandPluginError extends Schema.TaggedError<
	CommandPluginError,
	{ readonly brand: unique symbol }
>()("CommandPluginError", {
	plugin: Schema.String,
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {
	override get message() {
		return `${this.plugin}: ${this.detail}`
	}
}
const failure = (name: string, cause: Cause.Cause<unknown>) =>
	CommandPluginError.make({
		plugin: name,
		detail: "Command plugin failed",
		cause,
	})
const observe = (fork: Fork.Fork, name: string) =>
	fork.state.pipe(
		Stream.runForEach((state) =>
			state._tag === "Failed"
				? Effect.fail(failure(name, state.cause))
				: Effect.void,
		),
		Effect.andThen(Effect.never),
	)
const activate = Effect.fnUntraced(function* (
	entry: Effect.Success<ReturnType<typeof Configuration.discover>>[number],
	registry: Effect.Success<ReturnType<typeof Registry.make>>,
) {
	const { ConfigDirectory, Entry, ModuleResolver } = yield* Effect.promise(
		() => import("@graftland/loader"),
	).pipe(Effect.uninterruptible)
	const path = yield* Path.Path
	const directory = path.dirname(entry.file)
	const control = yield* Inspection.Address
	const resolver = yield* ModuleResolver.make({ base: directory, control })
	const descriptor = yield* resolver.resolve(entry.name)
	const module = yield* Effect.tryPromise({
		try: () => import(descriptor.location),
		catch: (cause) =>
			ModuleResolver.ModuleInvalid.make({ specifier: entry.name, cause }),
	})
	const plugin = yield* Effect.fromOption(Plugin.fromModule(module), () =>
		ModuleResolver.ModuleInvalid.make({
			specifier: entry.name,
			cause: "The selected module no longer exports its described plugin",
		}),
	)
	const input = yield* Entry.resolveEnv(entry.config)
	const owner = Plugin.make({
		name: `command:${entry.name}`,
		apply: Effect.fnUntraced(function* () {
			yield* Graft.provide(Commands, registry.service(entry.name))
			const child = yield* Graft.plugin(plugin, input)
			const state = yield* child.state.pipe(
				Stream.filter(
					(state) => state._tag === "Active" || state._tag === "Failed",
				),
				Stream.runHead,
			)
			if (Option.isSome(state) && state.value._tag === "Failed")
				return yield* failure(entry.name, state.value.cause)
			yield* Plugin.fork(observe(child, entry.name))
		}),
	})
	const fork = yield* Graft.plugin(owner, undefined, {
		isolate: [Commands],
	}).pipe(Effect.provideService(ConfigDirectory, Option.some(directory)))
	yield* Effect.addFinalizer(() => fork.dispose.pipe(Effect.orDie))
	yield* fork.await.pipe(
		Effect.timeout("5 seconds"),
		Effect.catchCause((cause) => Effect.fail(failure(entry.name, cause))),
	)
	if (!(yield* registry.has(entry.name)))
		return yield* CommandPluginError.make({
			plugin: entry.name,
			detail: "The plugin did not register a command",
		})
	return fork
})

// Registration checks the error/environment bounds before this heterogeneous tree erases its input types.
const execute = <Name extends string, Input, ContextInput>(
	command: Command.Command<
		Name,
		Input,
		ContextInput,
		CliError.CliError,
		Environment
	>,
	version: string,
	args: ReadonlyArray<string>,
): Effect.Effect<void, CliError.CliError, Environment> =>
	Command.runWith(command, { version })(args)
const runCommands = Effect.fnUntraced(function* (
	builtins: ReadonlyArray<Command.Command.Any>,
	root: Command.Command<
		"graft",
		{ readonly stdio: boolean; readonly noPlugins: boolean },
		{ readonly stdio: boolean; readonly noPlugins: boolean },
		never,
		never
	>,
	version: string,
	args: ReadonlyArray<string>,
) {
	const registry = yield* Registry.make(builtins)
	const flags = Array.takeWhile(args, (arg) => arg !== "--")
	const entries =
		flags.includes("--no-plugins") ||
		(args.length === 1 && args[0] === "--version")
			? []
			: yield* Configuration.discover(
					Option.contains(
						Array.findFirst(flags, (arg) => !String.startsWith("-")(arg)),
						"start",
					) &&
						(flags.includes("--watch") || flags.includes("-w")),
				)
	const forks = yield* Effect.forEach(
		entries,
		(entry) =>
			activate(entry, registry).pipe(
				Effect.mapError((error) => failure(entry.name, Cause.fail(error))),
			),
		{ concurrency: "unbounded" },
	)
	const commands = yield* registry.freeze
	return yield* execute(
		root.pipe(
			Command.withSubcommands([
				...Array.map(builtins, Registry.erase),
				...commands,
			]),
		),
		version,
		args,
	).pipe(
		Effect.raceFirst(
			Effect.forEach(
				forks,
				(fork, index) => observe(fork, entries[index]?.name ?? "command"),
				{ concurrency: "unbounded" },
			).pipe(Effect.andThen(Effect.never)),
		),
	)
})

export const run = (...args: Parameters<typeof runCommands>) =>
	runCommands(...args).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This is the composition root for non-start embedded command plugins and their inspection owner.
		Effect.provide(Inspection.layer),
	)

/** Discovers and runs embedded command plugins; `start` never reaches this module. */
export const main = (...args: Parameters<typeof runCommands>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(Graft.layer)
			return yield* run(...args).pipe(Effect.provideContext(context))
		}),
	)
