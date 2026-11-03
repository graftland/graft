#!/usr/bin/env node
/** The executable owns either a local child, a supervised child, or a TLS supervisor. */
import { Graft } from "@graftland/graft"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Console,
	Cause,
	Array,
	Duration,
	Effect,
	FileSystem,
	Layer,
	Fiber,
	Option,
	Redacted,
	Schema,
} from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { Digest, SecureRandom } from "effect/crypto"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { load, run } from "./Runner"
import { Bootstrap } from "./internal/runner/Bootstrap"
import * as Watchdog from "./internal/runner/Watchdog"
import * as Server from "./internal/runner/Server"

const duration = (name: string, fallback: string) =>
	Flag.String(name).pipe(
		Flag.withDefault(fallback),
		Flag.withSchema(Schema.DurationFromString),
		Flag.map(Duration.toMillis),
		Flag.filter(
			(value) => Number.isFinite(value) && value > 0,
			() => "Duration must be finite and positive",
		),
	)
const serve = Command.make(
	"serve",
	{
		host: Flag.String("host").pipe(Flag.withDefault("127.0.0.1")),
		port: Flag.Int("port").pipe(
			Flag.withDefault(7443),
			Flag.filter(
				(value) => value >= 0 && value <= 65535,
				() => "Port must be between 0 and 65535",
			),
		),
		state: Flag.String("state"),
		root: Flag.String("root"),
		cert: Flag.String("cert"),
		key: Flag.String("key"),
		ca: Flag.String("ca"),
		lease: duration("lease", "15 seconds"),
		grace: duration("grace", "5 seconds"),
	},
	(options) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const privateKey = yield* fs.readFileString(options.key)
			const server = yield* Server.serve({
				...options,
				tls: {
					cert: yield* fs.readFileString(options.cert),
					key: Redacted.make(privateKey),
					ca: yield* fs.readFileString(options.ca),
				},
			})
			const message = yield* Schema.encodeEffect(
				Schema.fromJsonString(
					Schema.Struct({
						event: Schema.Literal("Listening"),
						port: Schema.NullOr(Schema.Int),
					}),
				),
			)({
				event: "Listening",
				port:
					server.address._tag === "UnixPathAddress"
						? null
						: server.address.port,
			})
			yield* Console.log(message)
			return yield* Fiber.join(server.server)
		}),
)
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
			return yield* run(definition, session, bootstrap, watchdog.stop)
		}),
)
const cli = Command.make(
	"graft-remote",
	{
		contract: Argument.String("contract").pipe(Argument.optional),
		session: Argument.String("session").pipe(Argument.withDefault("local")),
	},
	({ contract, session }) =>
		Effect.gen(function* () {
			if (Option.isNone(contract))
				return yield* CliError.UserError.make({
					cause: "Missing contract module",
					userMessage:
						"A contract module or the child/serve subcommand is required",
				})
			const definition = yield* load(contract.value)
			return yield* run(definition, session)
		}),
).pipe(Command.withSubcommands([child, serve]))

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				Layer.mergeAll(
					Layer.provideMerge(Graft.layer, NodeServices.layer),
					Digest.layerWebCrypto,
					SecureRandom.layerWebCrypto,
				),
			)
			return yield* Command.run(cli, { version: "0.0.0" }).pipe(
				Effect.provideContext(context),
				Effect.tapCause((cause) =>
					Array.every(
						cause.reasons,
						(reason) =>
							reason._tag === "Fail" && CliError.isCliError(reason.error),
					)
						? Effect.void
						: Console.error(Cause.pretty(cause)),
				),
			)
		}),
	),
)
