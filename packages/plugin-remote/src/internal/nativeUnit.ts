/** The only native bootstrap that imports plugin and contract modules. Importing it performs no I/O. */
import process from "node:process"
import { pathToFileURL } from "node:url"
import { parentPort } from "node:worker_threads"

import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	FiberMap,
	FiberSet,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Predicate,
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { FetchHttpClient } from "effect/http"
import type { Socket } from "effect/socket"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Fork, Graft, Plugin, Transition, type Kernel } from "@graftland/graft"

import * as Artifact from "../Artifact"
import * as Configuration from "../Configuration"
import * as Contract from "../Contract"
import * as EncodedLimit from "./encodedLimit"
import * as Operations from "./operations"
import * as Owned from "./ownedCalls"
import * as Network from "./unitNetwork"
import * as Wire from "./unitProtocol"
import * as Resolution from "./unitResolution"
import * as Routing from "./unitRouter"

class UnitFault extends Schema.TaggedError<
	UnitFault,
	{ readonly brand: unique symbol }
>()("UnitFault", {
	reason: Schema.optionalKey(Schema.Literal("PluginExportMissing")),
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
interface Metadata {
	readonly environment: Context.Context<never>
	readonly plugin: Plugin.Plugin
	readonly contract: Option.Option<Contract.RunnerContract>
	readonly description: Kernel.Description
	readonly input: Schema.Json
}
interface UnitRuntime {
	readonly calls: Owned.Owner
	readonly initial: Ref.Ref<Option.Option<Wire.Command>>
	readonly metadata: Ref.Ref<Option.Option<Metadata>>
	readonly member: Ref.Ref<Option.Option<Fork.Fork>>
	readonly support: Ref.Ref<HashMap.HashMap<string, Fork.Fork>>
	readonly provider: Ref.Ref<Option.Option<Network.Provider>>
	readonly router: Ref.Ref<Option.Option<Routing.Router>>
	readonly scope: Scope.Closeable
	readonly views: Ref.Ref<HashMap.HashMap<string, Wire.Token>>
	readonly stopped: Deferred.Deferred<void>
	readonly commands: FiberMap.FiberMap<string, void, never>
	readonly replies: Ref.Ref<HashMap.HashMap<string, Wire.Report>>
	readonly emit: (frame: Wire.Outgoing) => Effect.Effect<void>
}
const transmitUnchecked = (frame: Wire.Outgoing): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		if (parentPort !== null) {
			parentPort.postMessage(frame)
			resume(Effect.void)
			return
		}
		if (process.send === undefined) {
			resume(Effect.die("Unit control is unavailable"))
			return
		}
		process.send(frame, (error) =>
			resume(error === null ? Effect.void : Effect.die(error)),
		)
	})
const transmit = (frame: Wire.Outgoing): Effect.Effect<void> =>
	EncodedLimit.check(frame).pipe(
		Effect.orDie,
		Effect.andThen(transmitUnchecked(frame)),
	)
const input = Effect.fnUntraced(function* () {
	const queue = yield* Queue.bounded<unknown>(256)
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const receive = (value: unknown) => {
		run(Queue.offer(queue, value))
	}
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			if (parentPort !== null) parentPort.on("message", receive)
			else process.on("message", receive)
		}),
		() =>
			Effect.sync(() => {
				if (parentPort !== null) {
					parentPort.off("message", receive)
					parentPort.close()
				} else {
					process.off("message", receive)
					if (process.connected) process.disconnect?.()
				}
			}),
	)
	return queue
})
const importModule = (specifier: string) =>
	Effect.tryPromise({
		try: () => import(specifier),
		catch: (cause) =>
			UnitFault.make({ detail: "Unit import failed", cause: Cause.die(cause) }),
	})
const serviceDescription = (
	service: Contract.Service,
	provenance: string,
): Kernel.BindingDeclaration => ({
	key: service.key.key,
	unary: service.unary,
	operations: Array.flatMap(
		Array.fromIterable(service.group.requests.values()),
		(rpc) =>
			Option.toArray(
				Option.map(Operations.identity(rpc), (identity) => ({
					identity: `${identity.name}@${identity.version}`,
					tag: rpc._tag,
					provenance,
				})),
			),
	),
})

const loadContract = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	deployment: Kernel.DeploymentData,
) {
	if (deployment.contract === undefined)
		return Option.none<Contract.RunnerContract>()
	const artifact = deployment.contractArtifact ?? deployment.artifact
	yield* Artifact.verify(artifact)
	const path = yield* Path.Path
	const location = path.resolveWithin(artifact.directory, deployment.contract)
	if (Option.isNone(location))
		return yield* UnitFault.make({
			detail: "Contract export escapes its immutable artifact",
		})
	yield* runtime.emit({ _tag: "Progress", stage: "DescribeImport" })
	const module = yield* importModule(pathToFileURL(location.value).href)
	const contract = yield* Effect.fromOption(Contract.fromModule(module), () =>
		UnitFault.make({ detail: "Expected a unit contract export" }),
	)
	const invalid = Contract.check(contract)
	if (Option.isSome(invalid))
		return yield* UnitFault.make({
			detail: "Unit contract declarations are invalid",
			cause: Cause.fail(invalid.value),
		})
	return Option.some(contract)
})

interface ConfigurationContext {
	readonly input: Context.Context<never>
	readonly output: Context.Context<never>
}
const constructConfiguration = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	context: ConfigurationContext,
	descriptor: Kernel.ConfigurationModule,
) {
	yield* Artifact.verify(descriptor.artifact)
	yield* runtime.emit({ _tag: "Progress", stage: "DescribeEnvironment" })
	const location = yield* Artifact.implementation(descriptor.artifact)
	const module = yield* importModule(location)
	const layer = Predicate.hasProperty(module, descriptor.export)
		? module[descriptor.export]
		: undefined
	if (!Layer.isLayer(layer))
		return yield* UnitFault.make({
			detail: "Expected an environment Layer export",
		})
	const supplied = Context.add(
		context.input,
		Configuration.Options,
		descriptor.options,
	)
	const dynamic = Context.makeUnsafe<unknown>(supplied.mapUnsafe)
	const built = yield* Effect.updateContext<
		Context.Context<unknown>,
		UnitFault,
		unknown,
		never
	>(
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- A unit-loaded Layer has a dynamic environment; its complete Cause is reported by the unit protocol.
		Layer.buildWithScope(Layer.fresh(layer), runtime.scope).pipe(
			Effect.catchCause((cause) =>
				UnitFault.make({ detail: "Unit configuration failed", cause }),
			),
		),
		() => dynamic,
	)
	return {
		input: Context.makeUnsafe<never>(
			Context.merge(context.input, built).mapUnsafe,
		),
		output: Context.makeUnsafe<never>(
			Context.merge(context.output, built).mapUnsafe,
		),
	}
})
const configurationEnvironment = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	modules: ReadonlyArray<Kernel.ConfigurationModule>,
) {
	const input = yield* Effect.context<never>()
	const constructed = yield* Effect.reduce(
		modules,
		(): ConfigurationContext => ({ input, output: Context.empty() }),
		(context, descriptor) =>
			constructConfiguration(runtime, context, descriptor),
	)
	return constructed.output
})
const decodeInput = Effect.fnUntraced(function* (
	plugin: Plugin.Plugin,
	input: Schema.Json,
	environment: Context.Context<never>,
) {
	if (plugin.config === undefined) return
	const infrastructure = yield* Effect.context<never>()
	const context = Context.makeUnsafe<unknown>(
		Context.merge(infrastructure, environment).mapUnsafe,
	)
	yield* Effect.updateContext<unknown, Schema.SchemaError, unknown, never>(
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- The inspection unit supplies the dynamic schema environment and reports its complete Exit.
		Schema.decodeEffect(plugin.config)(input),
		() => context,
	)
})
const grantedDeployment = Effect.fnUntraced(function* (command: Wire.Command) {
	const deployment = command.target.deployment
	const resolution = command.resolution
	if (deployment === undefined || resolution === undefined)
		return yield* UnitFault.make({
			detail: "Unit deployment or resolution is missing",
		})
	const fingerprint = yield* Resolution.fingerprint(resolution.input)
	if (
		fingerprint !== resolution.identity ||
		(yield* Resolution.validationEnvironment(
			command.target.placement,
			resolution.environmentModules,
		)) !== resolution.environment
	)
		return yield* UnitFault.make({
			detail:
				"Unit resolution or validation environment differs from its grant",
		})
	yield* Artifact.verify(deployment.artifact)
	return { deployment, resolution }
})
const load = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const { deployment, resolution } = yield* grantedDeployment(command)
	const environment = yield* configurationEnvironment(
		runtime,
		resolution.environmentModules ?? [],
	)
	const contractArtifact = deployment.contractArtifact ?? deployment.artifact
	const contract = yield* loadContract(runtime, deployment)

	yield* runtime.emit({ _tag: "Progress", stage: "DescribeDecode" })
	if (Option.isSome(contract) && deployment.inspection !== "Module")
		yield* Schema.decodeEffect(contract.value.config)(resolution.input)
	const implementation = yield* Artifact.implementation(deployment.artifact)
	yield* runtime.emit({ _tag: "Progress", stage: "DescribeImport" })
	const module = yield* importModule(
		implementation + (deployment.moduleSuffix ?? ""),
	)
	const plugin = yield* Effect.fromOption(Plugin.fromModule(module), () =>
		UnitFault.make({
			detail: "Expected a plugin export",
			reason: "PluginExportMissing",
		}),
	)
	yield* runtime.emit({ _tag: "Progress", stage: "DescribeDecode" })
	if (deployment.inspection !== "Module")
		yield* decodeInput(plugin, resolution.input, environment)
	const descriptor: Kernel.Description = {
		moduleExport:
			Predicate.hasProperty(module, "default") &&
			Plugin.isPlugin(module.default)
				? "default"
				: "plugin",
		artifact: deployment.artifact.identity.digest,
		configuration: resolution.identity,
		environment: resolution.environment,
		protocol: 1,
		overlap: plugin.overlap && Option.isSome(contract),
		members: 1,
		requires: Array.map(
			Option.isSome(contract) ? contract.value.inject : [],
			(s) => serviceDescription(s, contractArtifact.identity.digest),
		),
		provides: Array.map(
			Option.isSome(contract) ? contract.value.provides : [],
			(s) => serviceDescription(s, contractArtifact.identity.digest),
		),
		probes: [],
	}
	yield* Schema.decodeEffect(Wire.Description)(descriptor)
	return {
		plugin,
		contract,
		description: descriptor,
		input: resolution.input,
		environment,
	}
})
const resolverResult = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	exported: unknown,
	input: Schema.Json,
) {
	if (!Effect.isEffect(exported))
		return yield* UnitFault.make({
			detail: "Expected a default resolver Effect export",
		})
	const services = yield* Effect.context<never>().pipe(
		Scope.provide(runtime.scope),
	)
	const dynamic = Context.makeUnsafe<unknown>(
		Context.add(services, Configuration.Options, input).mapUnsafe,
	)
	const value = yield* Effect.updateContext<unknown, UnitFault, unknown, never>(
		// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- The disposable resolver supplies a dynamic Effect; its entire Cause is reported before its owning scope settles.
		exported.pipe(
			Effect.catchCause((cause) =>
				UnitFault.make({ detail: "Custom resolution failed", cause }),
			),
		),
		() => dynamic,
	)
	return yield* Schema.decodeUnknownEffect(Schema.Json)(value)
})
const describeModule = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const { deployment, resolution } = yield* grantedDeployment(command)
	if (deployment.inspection !== "Module")
		return yield* UnitFault.make({
			detail: "Metadata inspection requires a module-only grant",
		})
	yield* runtime.emit({ _tag: "Progress", stage: "DescribeImport" })
	const location = yield* Artifact.implementation(deployment.artifact)
	const module = yield* importModule(location + (deployment.moduleSuffix ?? ""))
	if (!Predicate.hasProperty(module, "default"))
		return yield* UnitFault.make({
			detail: "Expected a default inspection export",
		})
	if (deployment.moduleKind === "Environment" && !Layer.isLayer(module.default))
		return yield* UnitFault.make({
			detail: "Expected a default environment Layer export",
		})
	const inspectionData =
		deployment.moduleKind === "Resolver"
			? yield* resolverResult(runtime, module.default, resolution.input)
			: undefined
	const description: Kernel.Description = {
		...(inspectionData === undefined ? {} : { inspectionData }),
		moduleExport: "default",
		artifact: deployment.artifact.identity.digest,
		configuration: resolution.identity,
		environment: resolution.environment,
		protocol: 1,
		overlap: false,
		members: 0,
		requires: [],
		provides: [],
		probes: [],
	}
	return description
})
const metadata = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const loaded = yield* load(runtime, command)
	yield* Ref.set(runtime.metadata, Option.some(loaded))
	return loaded
})
const diagnostic = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	cause: Cause.Cause<unknown>,
) {
	const encoded = yield* Schema.encodeEffect(Wire.Cause)(cause)
	yield* runtime.emit({ _tag: "Diagnostic", cause: encoded })
}, Effect.orDie)
const startNetwork = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	loaded: Metadata,
) {
	if (Option.isNone(loaded.contract)) return Option.none<Wire.Endpoint>()
	const contract = loaded.contract.value
	const router = yield* Routing.make(contract.inject, (message) =>
		runtime.emit({ _tag: "Call", message }),
	).pipe(Scope.provide(runtime.scope))
	yield* Ref.set(runtime.router, Option.some(router))
	if (contract.provides.length === 0) return Option.none<Wire.Endpoint>()
	const server = yield* Network.provider(
		contract.provides,
		(cause) => diagnostic(runtime, cause),
		runtime.calls,
	).pipe(Scope.provide(runtime.scope))
	yield* Ref.set(runtime.provider, Option.some(server))
	return Option.some(server.endpoint)
})
const imports = (contract: Contract.RunnerContract, router: Routing.Router) =>
	Plugin.make({
		name: contract.name + "/imports",
		apply: () =>
			Effect.forEach(contract.inject, (service) => service.publish(router), {
				discard: true,
			}),
	})
const dependencyKey = (value: Plugin.Dependency): string =>
	value instanceof Plugin.Optional ? value.key.key : value.key
const exports = (
	loaded: Metadata,
	contract: Contract.RunnerContract,
	provider: Network.Provider,
) =>
	Plugin.make({
		name: contract.name + "/exports",
		inject: Array.dedupeWith<Plugin.Dependency>(
			[
				...loaded.plugin.inject,
				...Array.map(loaded.plugin.provides, (p) =>
					"operations" in p ? p.key : p,
				),
				...Array.map(contract.provides, (s) => s.key),
			],
			(a, b) => dependencyKey(a) === dependencyKey(b),
		),
		apply: () => Plugin.fork(provider.serve).pipe(Effect.asVoid),
	})
const support = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	services: Context.Context<Graft.Graft>,
	plugin: Plugin.Plugin,
) {
	const member = yield* Graft.plugin(plugin, undefined).pipe(
		Effect.provideContext(services),
		Scope.provide(runtime.scope),
	)
	yield* Ref.update(
		runtime.support,
		HashMap.set(plugin.name ?? "transport", member),
	)
	return member
})
const serve = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const loaded = yield* Ref.get(runtime.metadata).pipe(
		Effect.flatMap(Effect.fromOption),
	)
	const platform = Graft.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
		),
		Layer.provideMerge(
			Layer.succeed(Transition.UnitMember, Option.some(command.token.unit)),
		),
		Layer.provideMerge(
			Layer.succeed(Plugin.UnitTerm, Option.some(command.token.term)),
		),
	)
	const built = yield* Layer.buildWithScope(platform, runtime.scope)
	const services = Context.merge(built, loaded.environment)
	if (Option.isSome(loaded.contract)) {
		const router = yield* Ref.get(runtime.router).pipe(
			Effect.flatMap(Effect.fromOption),
		)
		yield* router.install(command.token, command.view ?? { routes: [] })
		yield* router.activate(command.token)
		if (loaded.contract.value.inject.length > 0) {
			const importer = yield* support(
				runtime,
				services,
				imports(loaded.contract.value, router),
			)
			yield* active(importer)
		}
	}
	const member = yield* Graft.plugin(loaded.plugin, loaded.input).pipe(
		Effect.provideContext(services),
		Scope.provide(runtime.scope),
	)
	const provider = yield* Ref.get(runtime.provider)
	if (Option.isSome(provider) && Option.isSome(loaded.contract))
		yield* support(
			runtime,
			services,
			exports(loaded, loaded.contract.value, provider.value),
		)

	yield* Ref.set(runtime.member, Option.some(member))
	yield* Stream.runForEach(member.state, (state) =>
		state._tag === "Failed"
			? Schema.encodeEffect(Wire.Cause)(state.cause).pipe(
					Effect.flatMap((cause) => runtime.emit({ _tag: "Failure", cause })),
				)
			: Effect.void,
	).pipe(Effect.forkIn(runtime.scope))
})
const active = Effect.fnUntraced(function* (member: Fork.Fork) {
	const state = yield* Stream.runHead(
		member.state.pipe(
			Stream.filter(
				(state) => state._tag === "Active" || state._tag === "Failed",
			),
		),
	)
	if (Option.isNone(state))
		return yield* UnitFault.make({
			detail: "Unit member ended before readiness",
		})
	if (state.value._tag === "Failed")
		return yield* UnitFault.make({
			detail: "Unit member failed",
			cause: state.value.cause,
		})
})
const ready = Effect.fnUntraced(function* (runtime: UnitRuntime) {
	const member = yield* Ref.get(runtime.member).pipe(
		Effect.flatMap(Effect.fromOption),
	)
	yield* active(member)
	const components = yield* Ref.get(runtime.support)
	yield* Effect.forEach(HashMap.values(components), active, { discard: true })
})
const stop = Effect.fnUntraced(function* (runtime: UnitRuntime) {
	yield* runtime.emit({ _tag: "Progress", stage: "StopScope" })
	const closed = yield* Effect.exit(Scope.close(runtime.scope, Exit.void))
	if (Exit.isFailure(closed)) {
		const cause = yield* Schema.encodeEffect(Wire.Cause)(closed.cause)
		yield* runtime.emit({ _tag: "Cleanup", cause })
		return yield* Effect.failCause(closed.cause)
	}
	yield* runtime.emit({ _tag: "Cleanup" })
})
const perform = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
): Effect.fn.Return<
	Wire.Report,
	| UnitFault
	| Schema.SchemaError
	| Artifact.ArtifactError
	| Cause.NoSuchElementError
	| Fork.ProbeError
	| Socket.SocketError,
	FileSystem.FileSystem | Path.Path | Digest.Digest | SecureRandom.SecureRandom
> {
	if (
		(command.token.term === 0 ||
			command.target.deployment?.inspection === "Module") &&
		["Start", "Serve", "Install", "Activate"].includes(command.kind)
	)
		return yield* UnitFault.make({
			detail: "Inspection has no serving authority",
		})
	switch (command.kind) {
		case "RetireRoute": {
			const router = yield* Ref.get(runtime.router).pipe(
				Effect.flatMap(Effect.fromOption),
			)
			if (command.call !== undefined) yield* router.retire(command.call.key)
			return { _tag: "Succeeded" }
		}
		case "CallRegister":
			if (command.call !== undefined)
				yield* runtime.calls.register(command.call)
			return { _tag: "Succeeded" }
		case "CallCancel":
			if (command.call !== undefined)
				yield* runtime.calls.cancel(command.call.key)
			return { _tag: "Succeeded" }
		case "CallCompleteAck":
			if (command.call !== undefined) yield* runtime.calls.ack(command.call.key)
			return { _tag: "Succeeded" }
		case "CallGrant":
		case "CallReject": {
			const router = yield* Ref.get(runtime.router).pipe(
				Effect.flatMap(Effect.fromOption),
			)
			yield* router.decide(command)
			return { _tag: "Succeeded" }
		}
		case "Describe":
			return {
				_tag: "Described",
				value:
					command.target.deployment?.moduleKind !== undefined
						? yield* describeModule(runtime, command)
						: (yield* metadata(runtime, command)).description,
			}
		case "Start": {
			const loaded = yield* metadata(runtime, command)
			const endpoint = yield* startNetwork(runtime, loaded)
			return {
				_tag: "Started",
				value: loaded.description,
				...(Option.isSome(endpoint) ? { endpoint: endpoint.value } : {}),
			}
		}
		case "Serve":
			yield* serve(runtime, command)
			return { _tag: "Succeeded" }
		case "Ready":
			yield* ready(runtime)
			return { _tag: "Succeeded" }
		case "Probe": {
			const member = yield* Ref.get(runtime.member).pipe(
				Effect.flatMap(Effect.fromOption),
			)
			yield* Effect.forEach(
				command.probes ?? [],
				(name) => member.probe(name),
				{ discard: true },
			)
			return { _tag: "Succeeded" }
		}
		case "Install":
			yield* ready(runtime)
			const router = yield* Ref.get(runtime.router)
			if (Option.isSome(router))
				yield* router.value.install(
					command.token,
					command.view ?? { routes: [] },
				)
			yield* Ref.update(
				runtime.views,
				HashMap.set(
					`${command.token.change}/${command.token.view}`,
					command.token,
				),
			)
			return { _tag: "Succeeded" }
		case "Activate": {
			const installed = yield* Ref.get(runtime.views)
			if (
				!HashMap.has(installed, `${command.token.change}/${command.token.view}`)
			)
				return yield* UnitFault.make({ detail: "View was not installed" })
			const router = yield* Ref.get(runtime.router)
			if (Option.isSome(router)) yield* router.value.activate(command.token)
			return { _tag: "Succeeded" }
		}
		case "Discard": {
			const router = yield* Ref.get(runtime.router)
			if (Option.isSome(router)) yield* router.value.discard(command.token)
			return { _tag: "Succeeded" }
		}
		case "Stop":
			yield* stop(runtime)
			return { _tag: "Succeeded" }
		default:
			return yield* UnitFault.make({
				detail: "Unsupported unit control operation",
			})
	}
})
const execute = Effect.fnUntraced(
	function* (runtime: UnitRuntime, command: Wire.Command) {
		const existing = yield* Ref.get(runtime.replies).pipe(
			Effect.map((replies) => HashMap.get(replies, command.id)),
		)
		if (Option.isSome(existing))
			return yield* runtime.emit({
				_tag: "Result",
				command: command.id,
				result: existing.value,
			})
		const exit = yield* Effect.exit(perform(runtime, command))
		const result: Wire.Report = Exit.isSuccess(exit)
			? exit.value
			: {
					_tag: "Failed",
					...(Array.some(
						exit.cause.reasons,
						(reason) =>
							reason._tag === "Fail" &&
							Schema.is(UnitFault)(reason.error) &&
							reason.error.reason === "PluginExportMissing",
					)
						? { reason: "PluginExportMissing" }
						: {}),
					cause: yield* Schema.encodeEffect(Wire.Cause)(exit.cause),
					creation: "Unknown",
				}
		yield* Ref.update(runtime.replies, HashMap.set(command.id, result))
		yield* runtime.emit({ _tag: "Result", command: command.id, result })
		if (command.kind === "Stop")
			yield* Deferred.succeed(runtime.stopped, undefined)
	},
	(effect, runtime: UnitRuntime) =>
		effect.pipe(
			Effect.catchCause((cause) =>
				Schema.encodeEffect(Wire.Cause)(cause).pipe(
					Effect.flatMap((encoded) =>
						runtime.emit({ _tag: "Failure", cause: encoded }),
					),
					Effect.orDie,
				),
			),
		),
)
const dispatch = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	message: Wire.Incoming,
) {
	if (message._tag === "Init") {
		yield* Ref.set(runtime.initial, Option.some(message.command))
		return yield* runtime.emit({ _tag: "Initialized" })
	}
	const initial = yield* Ref.get(runtime.initial)
	if (
		Option.isNone(initial) ||
		initial.value.token.incarnation !== message.command.token.incarnation
	)
		return yield* UnitFault.make({
			detail: "Command does not name this unit incarnation",
		})
	yield* FiberMap.run(
		runtime.commands,
		message.command.id,
		execute(runtime, message.command),
		{ onlyIfMissing: true },
	)
})
const main = Effect.gen(function* () {
	const queue = yield* input()
	const owner = yield* Effect.scope
	const unitScope = yield* Scope.fork(owner)
	const calls = yield* Owned.make((message) =>
		transmit({ _tag: "Call", message }),
	).pipe(Scope.provide(unitScope))
	yield* Stream.runForEach(calls.failures, (cause) =>
		Schema.encodeEffect(Wire.Cause)(cause).pipe(
			Effect.flatMap((encoded) =>
				transmit({ _tag: "Failure", cause: encoded }),
			),
			Effect.catchCause((report) =>
				Effect.logError(
					"Unit completion reporting failed",
					Cause.combine(cause, report),
				),
			),
		),
	).pipe(Effect.forkScoped)
	yield* calls.reconcile.pipe(
		Effect.andThen(Effect.sleep("1 second")),
		Effect.forever,
		Effect.forkScoped,
	)
	const runtime: UnitRuntime = {
		calls,
		initial: yield* Ref.make(Option.none<Wire.Command>()),
		metadata: yield* Ref.make(Option.none<Metadata>()),
		member: yield* Ref.make(Option.none<Fork.Fork>()),
		support: yield* Ref.make(HashMap.empty<string, Fork.Fork>()),
		provider: yield* Ref.make(Option.none<Network.Provider>()),
		router: yield* Ref.make(Option.none<Routing.Router>()),
		scope: unitScope,
		views: yield* Ref.make(HashMap.empty<string, Wire.Token>()),
		stopped: yield* Deferred.make<void>(),
		commands: yield* FiberMap.make<string, void, never>(),
		replies: yield* Ref.make(HashMap.empty<string, Wire.Report>()),
		emit: transmit,
	}
	yield* runtime.emit({ _tag: "Online" })
	yield* Queue.take(queue).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Wire.Incoming)),
		Effect.flatMap((message) => dispatch(runtime, message)),
		Effect.forever,
		Effect.raceFirst(Deferred.await(runtime.stopped)),
	)
}).pipe(Effect.scoped)
/** Called explicitly by the fixed Worker/process launcher. */
export const run = () =>
	NodeRuntime.runMain(
		main.pipe(
			Effect.provide([
				NodeServices.layer,
				FetchHttpClient.layer,
				Digest.layerWebCrypto,
				SecureRandom.layerWebCrypto,
			]),
		),
	)
