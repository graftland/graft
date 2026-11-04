#!/usr/bin/env node
/** Runs local children and WebSocket supervisors, and issues their deployment certificates. */
import { Graft } from "@graftland/graft"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Console,
	Cause,
	Array,
	Duration,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { Digest, SecureRandom } from "effect/crypto"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { load, run } from "./Runner"
import { Bootstrap } from "./internal/runner/Bootstrap"
import * as Watchdog from "./internal/runner/Watchdog"
import * as Serve from "./internal/serve"
import { MtlsAuthenticator } from "./Auth"
import { Url } from "./internal/websocket"
import * as Certificates from "./internal/Certificates"
import { Config as SupervisorConfig } from "./runner/supervisor"

const duration = (name: string) =>
	Flag.String(name).pipe(
		Flag.withSchema(Schema.DurationFromString),
		Flag.filter(
			(value) => Duration.isFinite(value) && Duration.toMillis(value) > 0,
			() => "Duration must be finite and positive",
		),
		Flag.optional,
	)
const required = <A>(value: Option.Option<A>, flag: string) =>
	Effect.fromOption(value, () =>
		CliError.UserError.make({
			cause: `Missing --${flag}`,
			userMessage: `--${flag} is required without --config`,
		}),
	)
const serve = Command.make(
	"serve",
	{
		config: Flag.String("config").pipe(Flag.optional),
		listen: Flag.String("listen").pipe(Flag.withSchema(Url), Flag.atLeast(0)),
		auth: Flag.Literals("auth", ["mtls"]).pipe(Flag.optional),
		state: Flag.String("state").pipe(Flag.optional),
		root: Flag.String("root").pipe(Flag.optional),
		cert: Flag.String("cert").pipe(Flag.optional),
		key: Flag.String("key").pipe(Flag.optional),
		ca: Flag.String("ca").pipe(Flag.optional),
		lease: duration("lease"),
		grace: duration("grace"),
	},
	Effect.fnUntraced(function* (options) {
		if (Option.isSome(options.config)) {
			if (
				options.listen.length > 0 ||
				Array.some(
					[
						options.auth,
						options.state,
						options.root,
						options.cert,
						options.key,
						options.ca,
						options.lease,
						options.grace,
					],
					(value: Option.Option<unknown>) => Option.isSome(value),
				)
			)
				return yield* CliError.UserError.make({
					cause: "Conflicting serve options",
					userMessage: "--config cannot be combined with serve shorthand flags",
				})
			return yield* Serve.run({ _tag: "Config", config: options.config.value })
		}
		if (options.listen.length === 0)
			return yield* CliError.UserError.make({
				cause: "Missing --listen",
				userMessage: "--listen is required without --config",
			})
		yield* required(options.auth, "auth")
		const addresses = yield* Effect.forEach(options.listen, (url) =>
			Schema.encodeEffect(Url)(url),
		)
		const state = yield* required(options.state, "state")
		const root = yield* required(options.root, "root")
		const cert = yield* required(options.cert, "cert")
		const key = yield* required(options.key, "key")
		const ca = yield* required(options.ca, "ca")
		const supervisor = yield* Schema.encodeEffect(SupervisorConfig)({
			state,
			root,
			...Option.match(options.lease, {
				onNone: () => ({}),
				onSome: (lease) => ({ lease }),
			}),
			...Option.match(options.grace, {
				onNone: () => ({}),
				onSome: (grace) => ({ grace }),
			}),
		})
		return yield* Serve.run({
			_tag: "Entries",
			entries: [
				{
					id: "remote-supervisor",
					name: "@graftland/remote/runner/supervisor",
					config: supervisor,
				},
				{
					id: "remote-auth",
					name: "@graftland/remote/runner/auth/mtls",
					config: { ca },
				},
				...Array.map(addresses, (url, index) => ({
					id: `remote-listener-${index}`,
					name: "@graftland/remote/runner/websocket",
					config: { url, cert, key, auth: MtlsAuthenticator.key },
				})),
			],
		})
	}),
)
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
		Certificates.generate(options).pipe(
			Effect.andThen(Console.log(`Certificates written to ${options.out}`)),
			Effect.catchTag("CertificateExists", (error) =>
				CliError.UserError.make({ cause: error, userMessage: error.message }),
			),
		),
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
						"A contract module or the child/serve/certificates subcommand is required",
				})
			const definition = yield* load(contract.value)
			return yield* run(definition, session)
		}),
).pipe(Command.withSubcommands([child, serve, certificates]))

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				Layer.provideMerge(
					Graft.layer,
					Layer.mergeAll(
						NodeServices.layer,
						Digest.layerWebCrypto,
						SecureRandom.layerWebCrypto,
					),
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
