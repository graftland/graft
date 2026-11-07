import {
	Cause,
	Effect,
	Option,
	Path,
	References,
	Schema,
	Scope,
	String,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"

import { Graft, Plugin, type Fork } from "@graftland/graft"
import { ConfigDirectory, Entry, ModuleResolver } from "@graftland/loader"

import * as Contract from "../Contract"
import { MissingInstance, RemoteError } from "../Errors"
import * as Assembly from "../internal/assembly"
import { children } from "../internal/cleanup"
import { LocalTransport, WorkerTransport } from "../internal/directTransport"
import { boundary, loadContract, resolve } from "../internal/entry"
import * as Configuration from "../internal/entryConfig"
import { executionPlugin, type ExecutionOptions } from "../internal/execution"
import { follow } from "../internal/follow"
import type { LocalTarget, WorkerTarget } from "../internal/runner/Connection"
import { resolveEntry } from "../internal/runner/Packages"
import { managedPlugin } from "../internal/transition"
import * as Policy from "../Policy"
import * as HostAssembly from "./assembly"

/** Direct execution installs only its execution capability in a private realm. */
export const direct = (
	provider: Plugin.Plugin,
	consumer: Effect.Effect<
		Plugin.Plugin,
		ModuleResolver.ModuleInvalid,
		Scope.Scope
	>,
	input: Schema.Json,
	key: typeof LocalTransport | typeof WorkerTransport,
): Effect.Effect<Fork.Fork<never, unknown>, never, Graft.Graft | Scope.Scope> =>
	Graft.plugin(
		Plugin.make({
			name: "@graftland/plugin-remote/host/direct",
			apply: Effect.fnUntraced(function* () {
				const capability = yield* Graft.plugin(provider)
				yield* follow(capability, (cause) =>
					Effect.fail(Assembly.CapabilityFailed.make({ cause })),
				)
				const definition = yield* consumer
				const execution = yield* Graft.plugin(definition, input)
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
	input: typeof Configuration.OrdinaryHost.Type,
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
	const implementation = String.startsWith("file:")(input.implementation)
		? input.implementation
		: yield* resolveEntry(directory, input.implementation)
	const capability = yield* resolve(
		{
			name:
				selected._tag === "Local"
					? "@graftland/plugin-remote/host/local"
					: "@graftland/plugin-remote/host/worker",
		},
		"connect",
	)

	const watch = yield* ModuleResolver.Watch
	const resolver = yield* Effect.serviceOption(ModuleResolver.ModuleResolver)
	const current: Effect.Effect<
		Contract.Contract<Contract.ConfigSchema, Contract.ErrorSchema>,
		ModuleResolver.ModuleInvalid,
		Scope.Scope
	> = Option.isSome(watch) && Option.isSome(resolver)
		? resolver.value.importModule(module).pipe(
				Effect.flatMap((namespace) =>
					Effect.fromOption(Contract.fromModule(namespace), () =>
						ModuleResolver.ModuleInvalid.make({
							specifier: module,
							cause: "Expected a remote contract",
						}),
					),
				),
			)
		: Effect.succeed(contract)
	const loaded = yield* current
	const consumer = Effect.succeed(
		executionPlugin(
			loaded,
			{ ...options, contractModule: module, implementation },
			selected,
			annotations,
		),
	)
	if (Option.isSome(watch)) {
		yield* ModuleResolver.observe([module, implementation])
	}
	const fork = yield* direct(
		capability.plugin,
		consumer,
		input.config,
		selected._tag === "Local" ? LocalTransport : WorkerTransport,
	)

	return fork
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
	input: typeof Configuration.OrdinaryHost.Type,
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
	return yield* HostAssembly.run({
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
	input: typeof Configuration.OrdinaryHost.Type,
	options: ExecutionOptions,
	authOverride?: typeof Assembly.Invocation.Type,
) {
	if (yield* Policy.enabled)
		return yield* RemoteError.make({
			cause: Cause.fail(
				Policy.PolicyError.make({
					message:
						"Operator policy requires captured managed direct entries; ordinary and runner deployments are unavailable",
				}),
			),
		})
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
	if (input.artifact !== undefined) {
		const deployment = input
		const failArtifact = yield* boundary("artifact")
		return yield* Effect.gen(function* () {
			const path = yield* Path.Path
			const source = yield* ConfigDirectory
			const directory = Option.getOrElse(source, () => ".")
			const contractModule = String.startsWith("file:")(deployment.contract)
				? deployment.contract
				: yield* resolveEntry(directory, deployment.contract)
			const fork = yield* Graft.plugin(
				managedPlugin(contract, {
					artifact: {
						...deployment.artifact,
						directory: path.resolve(directory, deployment.artifact.directory),
					},
					contractModule,
					target: deployment.target,
					maxInFlight: deployment.maxInFlight,
					policy: { probes: deployment.probes ?? [] },
				}),
				deployment.config,
			)
			yield* follow(fork, failArtifact)
		}).pipe(Effect.catchCause(failArtifact))
	}

	const failConnect = yield* boundary("connect")
	const fork = yield* launch(contract, input, {
		contractModule: input.contract,
		implementation: input.implementation,
	}).pipe(Effect.catchCause(failConnect))
	yield* follow(fork, failConnect)
})
export default Plugin.make({
	name: "@graftland/plugin-remote/host",
	config: Configuration.Host,
	inject: [
		SecureRandom.SecureRandom,
		ModuleResolver.ModuleResolver,
		Path.Path,
		ChildProcessSpawner.ChildProcessSpawner,
	],
	apply: load,
})
