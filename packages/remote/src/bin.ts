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
	Logger,
	Option,
	Schema,
	String,
} from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { Digest, SecureRandom } from "effect/crypto"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { load, run } from "./Runner"
import { Bootstrap } from "./internal/runner/Bootstrap"
import * as Watchdog from "./internal/runner/Watchdog"
import * as Serve from "./internal/serve"
import { MtlsAuthenticator, NoAuthenticator } from "./Auth"
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
const Listen = Schema.Union([
	Url,
	Schema.String.check(
		Schema.makeFilter((value) => !String.includes("://")(value), {
			expected: "a unix socket path",
		}),
	),
])
const listenerEntries = Effect.fnUntraced(function* (options: {
	readonly stdio: boolean
	readonly listen: ReadonlyArray<typeof Listen.Type>
	readonly auth: Option.Option<"mtls" | "none">
	readonly identity: Option.Option<string>
	readonly cert: Option.Option<string>
	readonly key: Option.Option<string>
	readonly ca: Option.Option<string>
}) {
	const identity = Option.getOrElse(options.identity, () => "anonymous")
	if (options.stdio) {
		if (options.listen.length > 0 || Option.isSome(options.auth))
			return yield* CliError.UserError.make({
				cause: "Conflicting serve options",
				userMessage: "--stdio cannot be combined with --listen or --auth",
			})
		return [
			{
				id: "remote-stdio",
				name: "@graftland/remote/runner/stdio",
				config: { identity },
			},
		]
	}
	if (options.listen.length === 0)
		return yield* CliError.UserError.make({
			cause: "Missing --listen",
			userMessage: "--listen or --stdio is required without --config",
		})
	const mode = Option.getOrElse(options.auth, () => "none")
	const certificate =
		mode === "mtls"
			? {
					cert: yield* required(options.cert, "cert"),
					key: yield* required(options.key, "key"),
				}
			: undefined
	const authentication =
		mode === "mtls"
			? {
					name: "@graftland/remote/runner/auth/mtls",
					config: { ca: yield* required(options.ca, "ca") },
				}
			: { name: "@graftland/remote/runner/auth/none", config: { identity } }
	const listeners = yield* Effect.forEach(options.listen, (address, index) =>
		Effect.gen(function* () {
			const id = `remote-listener-${index}`
			if (typeof address === "string") {
				if (mode !== "none")
					return yield* CliError.UserError.make({
						cause: "Unsupported authentication",
						userMessage: "Unix listeners only support --auth none",
					})
				return {
					id,
					name: "@graftland/remote/runner/unix",
					config: { path: address, auth: NoAuthenticator.key },
				}
			}
			if (certificate === undefined)
				return yield* CliError.UserError.make({
					cause: "Unsupported authentication",
					userMessage: "WebSocket listeners currently require --auth mtls",
				})
			const url = yield* Schema.encodeEffect(Url)(address)
			return {
				id,
				name: "@graftland/remote/runner/websocket",
				config: { ...certificate, url, auth: MtlsAuthenticator.key },
			}
		}),
	)
	return [{ id: "remote-auth", ...authentication }, ...listeners]
})
const serve = Command.make(
	"serve",
	{
		config: Flag.String("config").pipe(Flag.optional),
		listen: Flag.String("listen").pipe(
			Flag.withSchema(Listen),
			Flag.atLeast(0),
		),
		stdio: Flag.Boolean("stdio").pipe(Flag.withDefault(false)),
		identity: Flag.String("identity").pipe(Flag.optional),
		auth: Flag.Literals("auth", ["mtls", "none"]).pipe(Flag.optional),
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
				options.stdio ||
				options.listen.length > 0 ||
				Array.some(
					[
						options.identity,
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
		const listeners = yield* listenerEntries(options)
		const state = yield* required(options.state, "state")
		const root = yield* required(options.root, "root")
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
				...listeners,
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
			)
		}),
	).pipe(
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause) ||
			Array.every(
				cause.reasons,
				(reason) => reason._tag === "Fail" && CliError.isCliError(reason.error),
			)
				? Effect.void
				: Effect.logError(cause),
		),
		Effect.provideService(Logger.LogToStderr, true),
	),
	// Report inside the stderr context, including failures from resource cleanup.
	{ disableErrorReporting: true },
)
