import { Graft, Plugin, type Fork } from "@graftland/graft"
import { ConfigDirectory, Entry, ModuleResolver } from "@graftland/loader"
import { Cause, Effect, Option, Path, Schema, References, Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import * as Contract from "../Contract"
import { LocalTransport, WorkerTransport } from "../Transport"
import * as Configuration from "./entryConfig"
import * as Assembly from "./assembly"
import { executionPlugin } from "./execution"
import { follow } from "./follow"
import { children } from "./cleanup"
import { resolveEntry } from "./runner/Packages"
import { local, worker } from "../Targets"

export class EntryError extends Schema.TaggedError<
	EntryError,
	{ readonly brand: unique symbol }
>()("RemoteEntryError", {
	entry: Schema.Option(Schema.String),
	directory: Schema.Option(Schema.String),
	field: Schema.String,
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {
	override get message() {
		return `Remote entry ${Option.getOrElse(this.entry, () => "<programmatic>")} failed at ${this.field}`
	}
}
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
	const resolver = yield* ModuleResolver.ModuleResolver
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
const directTarget = Effect.fnUntraced(function* (
	contract: Contract.RunnerContract,
	input: typeof Configuration.Host.Type,
	selected: ReturnType<typeof local> | ReturnType<typeof worker>,
	annotations: Annotations,
) {
	const path = yield* Path.Path
	const source = yield* ConfigDirectory
	const directory = path.resolve(Option.getOrElse(source, () => "."))
	const module = yield* resolveEntry(directory, input.contract)
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
			{ contractModule: module },
			selected,
			annotations,
		),
		input.config,
		selected._tag === "Local" ? LocalTransport : WorkerTransport,
	)
})
const runnerTarget = Effect.fnUntraced(function* (
	contract: Contract.RunnerContract,
	input: typeof Configuration.Host.Type,
	target: Exclude<
		Configuration.Connect,
		{ readonly local: object } | { readonly worker: object }
	>,
	annotations: Annotations,
) {
	const transport = yield* resolve(
		Configuration.hostTransport(target),
		"connect.transport",
	)
	const auth = yield* resolve(
		Configuration.authentication("host", target.auth),
		"connect.auth",
	)
	const consumer = executionPlugin(
		contract,
		{ contractModule: input.contract },
		{
			_tag: "Connector",
			explicitAuth: target.auth !== undefined,
			...(target.instance === undefined ? {} : { instance: target.instance }),
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
const load = Effect.fnUntraced(function* (
	input: typeof Configuration.Host.Type,
) {
	const annotations = yield* References.CurrentLogAnnotations
	const contract = yield* loadContract(input.contract)
	const failConfig = yield* boundary("config")
	yield* Schema.decodeEffect(contract.config)(input.config).pipe(
		Effect.catchCause(failConfig),
	)
	const target = input.connect
	const failConnect = yield* boundary("connect")
	// The contract import lease outlives the execution and all capability children.
	const scope = yield* children
	const launch =
		target.local !== undefined
			? directTarget(contract, input, local(target.local), annotations)
			: target.worker !== undefined
				? directTarget(contract, input, worker(target.worker), annotations)
				: runnerTarget(contract, input, target, annotations)
	const fork = yield* launch.pipe(
		Scope.provide(scope),
		Effect.catchCause(failConnect),
	)
	yield* follow(fork, failConnect)
})
export const host = Plugin.make({
	name: "remote",
	config: Configuration.Host,
	inject: [
		ModuleResolver.ModuleResolver,
		Path.Path,
		ChildProcessSpawner.ChildProcessSpawner,
	],
	apply: load,
})
