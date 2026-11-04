#!/usr/bin/env node
/** Runs local children and WebSocket supervisors, and issues their deployment certificates. */
import { Graft } from "@graftland/graft"
import { NodeRuntime } from "@effect/platform-node"
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
import process from "node:process"
import { pathToFileURL } from "node:url"
import { platform } from "./internal/platform"
import { bytes } from "./internal/stdioChannel"
import { load, run } from "./Runner"
import { Bootstrap } from "./internal/runner/Bootstrap"
import * as Watchdog from "./internal/runner/Watchdog"
import * as Serve from "./internal/serve"
import { MtlsAuthenticator } from "./Auth"
import * as Authentication from "./internal/auth/flags"
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
const listenerEntries = Effect.fnUntraced(function* (
	options: Parameters<typeof Authentication.entry>[0] & {
		readonly stdio: boolean
		readonly listen: ReadonlyArray<typeof Listen.Type>
		readonly cert: Option.Option<string>
		readonly key: Option.Option<string>
	},
) {
	if (
		options.stdio &&
		(options.listen.length > 0 || Option.isSome(options.auth))
	)
		return yield* Authentication.usage(
			"--stdio cannot be combined with --listen or --auth",
		)
	yield* Authentication.validate(options, options.stdio)
	const secure = Array.some(
		options.listen,
		(address) => typeof address !== "string" && address.protocol === "wss:",
	)
	if (!secure && (Option.isSome(options.cert) || Option.isSome(options.key)))
		return yield* Authentication.usage(
			"--cert and --key require a wss:// listener",
		)
	if (options.stdio)
		return [
			{
				id: "remote-stdio",
				name: "@graftland/plugin-remote/runner/stdio",
				config: {
					identity: Option.getOrElse(options.identity, () => "anonymous"),
				},
			},
		]
	if (options.listen.length === 0)
		return yield* Authentication.usage(
			"--listen or --stdio is required without --config",
		)
	const auth = yield* Authentication.entry(options)
	const certificate = secure
		? {
				cert: yield* required(options.cert, "cert"),
				key: yield* required(options.key, "key"),
			}
		: {}
	const listeners = yield* Effect.forEach(options.listen, (address, index) =>
		Effect.gen(function* () {
			const id = `remote-listener-${index}`
			if (
				auth.key === MtlsAuthenticator.key &&
				(typeof address === "string" || address.protocol !== "wss:")
			)
				return yield* Authentication.usage(
					"Mutual TLS requires wss:// listeners",
				)
			if (typeof address === "string")
				return {
					id,
					name: "@graftland/plugin-remote/runner/unix",
					config: { path: address, auth: auth.key },
				}
			const url = yield* Schema.encodeEffect(Url)(address)
			return {
				id,
				name: "@graftland/plugin-remote/internal/legacy/runner/websocket",
				config: {
					...(address.protocol === "wss:" ? certificate : {}),
					url,
					auth: auth.key,
				},
			}
		}),
	)
	return [auth.entry, ...listeners]
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
		...Authentication.flags,
		state: Flag.String("state").pipe(Flag.optional),
		root: Flag.String("root").pipe(Flag.optional),
		cert: Flag.String("cert").pipe(Flag.optional),
		key: Flag.String("key").pipe(Flag.optional),
		lease: duration("lease"),
		grace: duration("grace"),
	},
	Effect.fnUntraced(function* (options) {
		if (Option.isSome(options.config)) {
			if (
				options.stdio ||
				options.listen.length > 0 ||
				Authentication.anySupplied(options) ||
				Array.some(
					[
						options.state,
						options.root,
						options.cert,
						options.key,
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
					name: "@graftland/plugin-remote/runner/supervisor",
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
			const channel = yield* bytes
			return yield* run(definition, channel, session, bootstrap, watchdog.stop)
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
			const channel = yield* bytes
			return yield* run(definition, channel, session)
		}),
).pipe(Command.withSubcommands([child, serve, certificates]))

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
