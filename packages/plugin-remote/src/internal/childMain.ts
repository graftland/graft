#!/usr/bin/env node
/** Internal executable for local and supervised child runtimes. */
import { Graft } from "@graftland/graft"
import { NodeRuntime } from "@effect/platform-node"
import { Array, Effect, Layer, Logger, Option, Schema } from "effect"
import { Argument, CliError, Command } from "effect/cli"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { platform } from "./platform"
import { bytes } from "./stdioChannel"
import { load, run } from "./childRuntime"
import { Bootstrap } from "./runner/Bootstrap"
import * as Watchdog from "./runner/Watchdog"

const child = Command.make(
	"child",
	{
		contract: Argument.String("contract"),
		session: Argument.String("session"),
		bootstrap: Argument.String("bootstrap").pipe(
			Argument.withSchema(Schema.fromJsonString(Bootstrap)),
		),
	},
	({ contract, session, bootstrap }) =>
		Effect.gen(function* () {
			const watchdog = yield* Watchdog.start
			// The executable owns stdin; it must not retain the process after a supervisor stop.
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					process.stdin.destroy()
				}),
			)
			const begin = yield* Effect.raceFirst(
				watchdog.begin.pipe(Effect.as(true)),
				watchdog.stop.pipe(Effect.as(false)),
			)
			if (!begin) return
			const definition = yield* load(pathToFileURL(contract).href)
			const channel = yield* bytes
			return yield* run(definition, channel, session, bootstrap, watchdog.stop)
		}),
)
const cli = Command.make(
	"remote-child",
	{
		contract: Argument.String("contract").pipe(Argument.optional),
		session: Argument.String("session").pipe(Argument.withDefault("local")),
	},
	({ contract, session }) =>
		Effect.gen(function* () {
			if (Option.isNone(contract))
				return yield* CliError.UserError.make({
					cause: "Missing contract module",
					userMessage: "A contract module or the child subcommand is required",
				})
			const definition = yield* load(contract.value)
			const channel = yield* bytes
			return yield* run(definition, channel, session)
		}),
).pipe(Command.withSubcommands([child]))

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				Layer.provideMerge(Graft.layer, platform),
			)
			return yield* Command.run(cli, { version: "0.0.0" }).pipe(
				Effect.provideContext(context),
			)
		}),
	).pipe(
		(effect) =>
			Effect.withFiber((main) =>
				effect.pipe(
					Effect.tapCause((cause) =>
						// NodeRuntime uses this fiber's id; a self-interrupt here is indistinguishable, but worker cleanup is not.
						Array.every(
							cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === main.id,
						) ||
						Array.every(
							cause.reasons,
							(reason) =>
								reason._tag === "Fail" && CliError.isCliError(reason.error),
						)
							? Effect.void
							: Effect.logError(cause),
					),
				),
			),
		Effect.provideService(Logger.LogToStderr, true),
	),
	// Report inside the stderr context, including failures from resource cleanup.
	{ disableErrorReporting: true },
)
