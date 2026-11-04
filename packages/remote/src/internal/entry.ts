import { Graft, Plugin, type Fork } from "@graftland/graft"
import { ConfigDirectory, Entry, ModuleResolver } from "@graftland/loader"
import {
	Cause,
	Effect,
	Option,
	Path,
	Schema,
	References,
	Scope,
	String,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import * as Contract from "../Contract"
import { MissingInstance, RemoteEntryError as EntryError } from "../Errors"
import { LocalTransport, WorkerTransport } from "./directTransport"
import * as Configuration from "./entryConfig"
import * as Assembly from "./assembly"
import { executionPlugin } from "./execution"
import { follow } from "./follow"
import { children } from "./cleanup"
import { resolveEntry } from "./runner/Packages"
import type { LocalTarget, WorkerTarget } from "./runner/Connection"
import type { ExecutionOptions } from "./execution"
import * as Importer from "./importer"
import { SecureRandom } from "effect/crypto"

export const boundary = Effect.fnUntraced(function* (field: string) {
	const entry = yield* Entry.CurrentId
	const directory = yield* ConfigDirectory
	return (cause: Cause.Cause<unknown>) =>
		Effect.fail(EntryError.make({ entry, directory, field, cause }))
})
export const resolve = Effect.fnUntraced(function* (
	reference: Configuration.Reference,
	field: string,
) {
	const existing = yield* Effect.serviceOption(ModuleResolver.ModuleResolver)
	const path = yield* Path.Path
	const source = yield* ConfigDirectory
	const directory = path.resolve(Option.getOrElse(source, () => "."))
	const resolver = yield* Option.match(existing, {
		onSome: Effect.succeed,
		onNone: () =>
			Effect.gen(function* () {
				const importer = yield* Importer.make(directory)
				return yield* ModuleResolver.make({
					base: directory,
					importer: (specifier) =>
						String.startsWith("@graftland/plugin-remote/")(specifier)
							? import(specifier)
							: importer(specifier),
				})
			}),
	})
	const fail = yield* boundary(field)
	const plugin = yield* resolver
		.resolve(reference.name)
		.pipe(Effect.catchCause(fail))
	return { plugin, config: reference.config }
})
export const loadContract = Effect.fnUntraced(function* (specifier: string) {
	const resolver = yield* ModuleResolver.ModuleResolver
	const fail = yield* boundary("contract")
	return yield* resolver.importModule(specifier).pipe(
		Effect.flatMap((module) =>
			Effect.fromOption(Contract.fromModule(module), () =>
				ModuleResolver.ModuleInvalid.make({
					specifier,
					cause: "Expected a default or named remote contract",
				}),
			),
		),
		Effect.catchCause(fail),
	)
})

/** Direct execution installs only its execution capability in a private realm. */
export const direct = (
	provider: Plugin.Plugin,
	consumer: Plugin.Plugin,
	input: Schema.Json,
	key: typeof LocalTransport | typeof WorkerTransport,
): Effect.Effect<Fork.Fork<never, unknown>, never, Graft.Graft | Scope.Scope> =>
	Graft.plugin(
		Plugin.make({
			name: "remote-direct",
			apply: Effect.fnUntraced(function* () {
				const capability = yield* Graft.plugin(provider)
				yield* follow(capability, (cause) =>
					Effect.fail(Assembly.CapabilityFailed.make({ cause })),
				)
				const execution = yield* Graft.plugin(consumer, input)
				yield* follow(execution, (cause) =>
					Effect.fail(Assembly.CapabilityFailed.make({ cause })),
				)
			}),
		}),
		undefined,
		{ isolate: [key] },
	)

type Annotations = Readonly<Record<string, unknown>>
const directTarget = Effect.fnUntraced(function* <
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
>(
	contract: Contract.Contract<S, E>,
	input: typeof Configuration.Host.Type,
	selected: LocalTarget | WorkerTarget,
	annotations: Annotations,
	options: ExecutionOptions,
) {
	const path = yield* Path.Path
	const source = yield* ConfigDirectory
	const directory = path.resolve(Option.getOrElse(source, () => "."))
	const module = String.startsWith("file:")(input.contract)
		? input.contract
		: yield* resolveEntry(directory, input.contract)
	const capability = yield* resolve(
		{
			name:
				selected._tag === "Local"
					? "@graftland/plugin-remote/host/local"
					: "@graftland/plugin-remote/host/worker",
		},
		"connect",
	)
	return yield* direct(
		capability.plugin,
		executionPlugin(
			contract,
			{ ...options, contractModule: module },
			selected,
			annotations,
		),
		input.config,
		selected._tag === "Local" ? LocalTransport : WorkerTransport,
	)
})
const runnerTarget = Effect.fnUntraced(function* <
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
>(
	contract: Contract.Contract<S, E>,
	input: typeof Configuration.Host.Type,
	target: Exclude<
		Configuration.Connect,
		{ readonly local: object } | { readonly worker: object }
	>,
	annotations: Annotations,
	options: ExecutionOptions,
	authOverride: typeof Assembly.Invocation.Type | undefined,
) {
	const instance =
		target.instance === undefined
			? yield* Entry.CurrentId
			: Option.some(target.instance)
	if (Option.isNone(instance)) return yield* MissingInstance.make({})
	const transport = yield* resolve(
		Configuration.hostTransport(target),
		"connect.transport",
	)
	const auth =
		authOverride ??
		(yield* resolve(
			Configuration.authentication("host", target.auth),
			"connect.auth",
		))
	const consumer = executionPlugin(
		contract,
		options,
		{
			_tag: "Connector",
			explicitAuth: target.auth !== undefined,
			instance: instance.value,
			...(target.lease === undefined ? {} : { lease: target.lease }),
			...(target.margin === undefined ? {} : { margin: target.margin }),
			...(target.expect === undefined ? {} : { expect: target.expect }),
		},
		annotations,
	)
	return yield* Assembly.host({
		transport,
		auth,
		consumer,
		input: input.config,
	})
})

export const launch = Effect.fnUntraced(function* <
	S extends Schema.Top & {
		readonly Encoded: Schema.Json
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
	E extends Schema.Top & {
		readonly DecodingServices: never
		readonly EncodingServices: never
	},
>(
	contract: Contract.Contract<S, E>,
	input: typeof Configuration.Host.Type,
	options: ExecutionOptions,
	authOverride?: typeof Assembly.Invocation.Type,
) {
	const annotations = yield* References.CurrentLogAnnotations
	const connect = input.connect
	const scope = yield* children
	return yield* Effect.gen(function* () {
		if (connect.local !== undefined)
			return yield* directTarget(
				contract,
				input,
				{ _tag: "Local", ...connect.local },
				annotations,
				options,
			)
		if (connect.worker !== undefined)
			return yield* directTarget(
				contract,
				input,
				{ _tag: "Worker", ...connect.worker },
				annotations,
				options,
			)
		return yield* runnerTarget(
			contract,
			input,
			connect,
			annotations,
			options,
			authOverride,
		)
	}).pipe(Scope.provide(scope))
})
const load = Effect.fnUntraced(function* (
	input: typeof Configuration.Host.Type,
) {
	const contract = yield* loadContract(input.contract)
	const failConfig = yield* boundary("config")
	yield* Schema.decodeEffect(contract.config)(input.config).pipe(
		Effect.catchCause(failConfig),
	)
	const failConnect = yield* boundary("connect")
	const fork = yield* launch(contract, input, {
		contractModule: input.contract,
	}).pipe(Effect.catchCause(failConnect))
	yield* follow(fork, failConnect)
})
export const host = Plugin.make({
	name: "remote",
	config: Configuration.Host,
	inject: [
		SecureRandom.SecureRandom,
		ModuleResolver.ModuleResolver,
		Path.Path,
		ChildProcessSpawner.ChildProcessSpawner,
	],
	apply: load,
})
