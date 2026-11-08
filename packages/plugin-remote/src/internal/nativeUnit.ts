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
	Equal,
	Exit,
	FiberMap,
	FiberSet,
	FileSystem,
	HashMap,
	HashSet,
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

import { Fork, Graft, Kernel, Plugin, Transition } from "@graftland/graft"

import * as Artifact from "../Artifact"
import * as Configuration from "../Configuration"
import * as Contract from "../Contract"
import { Recorder } from "../Recording"
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
}) {
	override get message(): string {
		return this.detail
	}
}
interface Metadata {
	readonly children: NonNullable<
		(typeof Wire.DeclarationOptions.Type)["children"]
	>
	readonly environment: Context.Context<never>
	readonly plugin: Plugin.Plugin
	readonly contract: Option.Option<Contract.RunnerContract>
	readonly description: Kernel.Description
	readonly input: Schema.Json
}
interface NativeMember {
	readonly executionContext: Ref.Ref<Option.Option<Context.Context<unknown>>>
	readonly configurationScope: Scope.Closeable
	readonly metadata: Metadata
	readonly grant: Ref.Ref<typeof Wire.UnitMember.Type>
	readonly permits: Queue.Queue<typeof Wire.UnitMember.Type>
	readonly consumed: Ref.Ref<Option.Option<typeof Wire.UnitMember.Type>>
	readonly offered: Ref.Ref<number>
	readonly fork: Ref.Ref<Option.Option<Fork.Fork>>
	readonly provider: Option.Option<Network.Provider>
	readonly router: Option.Option<Routing.Router>
}
interface UnitRuntime {
	readonly digest: Digest.Digest["Service"]
	readonly calls: Owned.Owner
	readonly initial: Ref.Ref<Option.Option<Wire.Command>>
	readonly members: Ref.Ref<HashMap.HashMap<string, NativeMember>>
	readonly services: Ref.Ref<Option.Option<Context.Context<Graft.Graft>>>
	readonly support: Ref.Ref<HashMap.HashMap<string, Fork.Fork>>
	readonly scope: Scope.Closeable
	readonly views: Ref.Ref<HashMap.HashMap<string, Wire.Token>>
	readonly stopped: Deferred.Deferred<void>
	readonly commands: FiberMap.FiberMap<string, void, never>
	readonly replies: Ref.Ref<HashMap.HashMap<string, Wire.Report>>
	readonly records: Queue.Queue<Wire.RecordDuty>
	readonly emit: (frame: Wire.Outgoing) => Effect.Effect<void>
}

const transmitUnchecked = (frame: Schema.JsonObject): Effect.Effect<void> =>
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
	Wire.encodeOutgoing(frame).pipe(
		Effect.flatMap((encoded) =>
			EncodedLimit.check(encoded).pipe(
				Effect.andThen(transmitUnchecked(encoded)),
			),
		),
		Effect.orDie,
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
			command.placement.kind,
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
const describePlugin = Effect.fnUntraced(function* (
	command: Wire.Command,
	plugin: Plugin.Plugin,
	contract: Metadata["contract"],
	contractArtifact: Kernel.ArtifactData,
	environment: Context.Context<never>,
	module: unknown,
): Effect.fn.Return<Kernel.MemberDeclaration, UnitFault | Schema.SchemaError> {
	const grant = Array.findFirst(HashMap.values(command.members), (member) =>
		Equal.equals(member.target, command.target),
	)
	if (Option.isNone(grant))
		return yield* UnitFault.make({
			detail: "The command has no matching identified member grant",
		})
	const options = yield* Schema.decodeUnknownEffect(Wire.DeclarationOptions)(
		Predicate.hasProperty(module, "deployment") ? module.deployment : {},
	)
	const infrastructure = yield* Effect.context<never>()
	const context = Context.merge(infrastructure, environment)
	const contracts = Option.isSome(contract) ? contract.value : undefined
	const localRequires = Array.flatMap(plugin.inject, (dependency) => {
		const key = Plugin.isOptional(dependency) ? dependency.key : dependency
		if (
			HashSet.has(unitInfrastructure, key.key) ||
			(contracts !== undefined &&
				Array.some(contracts.inject, (service) => service.key.key === key.key))
		)
			return []
		return [
			{
				key: key.key,
				optional:
					Plugin.isOptional(dependency) ||
					Option.isSome(Context.getOption(context, key)),
			},
		]
	})
	const localProvides = Array.flatMap(plugin.provides, (provided) => {
		const key = "operations" in provided ? provided.key.key : provided.key
		return contracts !== undefined &&
			Array.some(contracts.provides, (service) => service.key.key === key)
			? []
			: [key]
	})
	return {
		...grant.value,
		placement:
			options.placement === undefined
				? grant.value.placement
				: Option.some(options.placement),
		localRequires,
		localProvides,
		requires: Array.map(contracts?.inject ?? [], (service) => ({
			...serviceDescription(service, contractArtifact.identity.digest),
			optional: Array.some(
				plugin.inject,
				(dependency) =>
					Plugin.isOptional(dependency) &&
					dependency.key.key === service.key.key,
			),
		})),
		provides: Array.map(contracts?.provides ?? [], (service) =>
			serviceDescription(service, contractArtifact.identity.digest),
		),
		resources: options.resources ?? [],
		overlap: plugin.overlap && Option.isSome(contract),
		probes: options.probes ?? [],
	}
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
	const path = yield* Path.Path
	const selected =
		deployment.module === undefined
			? Option.some(
					path.join(
						deployment.artifact.directory,
						deployment.artifact.identity.entry,
					),
				)
			: path.resolveWithin(deployment.artifact.directory, deployment.module)
	if (Option.isNone(selected))
		return yield* UnitFault.make({
			detail: "The selected module escapes its captured artifact",
		})
	const implementation = pathToFileURL(selected.value).href
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
		members: [
			yield* describePlugin(
				command,
				plugin,
				contract,
				contractArtifact,
				environment,
				module,
			),
		],
	}
	const description = yield* Schema.decodeEffect(
		Schema.toType(Wire.Description),
	)(descriptor)
	return {
		children:
			(yield* Schema.decodeUnknownEffect(Wire.DeclarationOptions)(
				Predicate.hasProperty(module, "deployment") ? module.deployment : {},
			)).children ?? [],
		plugin,
		contract,
		description,
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
const describeTree = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
	ancestors: HashSet.HashSet<string> = HashSet.empty(),
): Effect.fn.Return<
	Kernel.Description,
	| UnitFault
	| Schema.SchemaError
	| Artifact.ArtifactError
	| Cause.NoSuchElementError,
	FileSystem.FileSystem | Path.Path | Digest.Digest
> {
	const loaded = yield* load(runtime, command)
	const root = yield* Effect.fromOption(Array.head(loaded.description.members))
	const deployment = command.target.deployment
	if (deployment === undefined)
		return yield* UnitFault.make({
			detail: "Description requires a captured deployment",
		})
	const selected = deployment.module ?? deployment.artifact.identity.entry
	const identity = `${deployment.artifact.identity.digest}/${selected}`
	if (HashSet.has(ancestors, identity))
		return yield* UnitFault.make({
			detail: "Static child declarations contain a recursive module cycle",
		})
	const path = yield* Path.Path
	const children = yield* Effect.forEach(loaded.children, (child) =>
		Effect.gen(function* () {
			const module = path.normalize(
				path.join(path.dirname(selected), child.module),
			)
			const input =
				child.input._tag === "Parent" ? loaded.input : child.input.value
			const data = {
				...deployment,
				module,
				input:
					child.input._tag === "Parent" ? deployment.input : child.input.value,
			}
			const target: Kernel.Target = {
				...command.target,
				identity: Kernel.deploymentIdentity(data),
				deployment: data,
			}
			const grant: Kernel.UnitMember = {
				instance: `${root.instance}/${child.name}`,
				declaration: child.name,
				parent: Option.some(root.instance),
				realm: child.realm ?? root.realm,
				placement:
					child.placement === undefined
						? Option.none()
						: Option.some(child.placement),
				colocate: [],
				target,
				term: 0,
				generation: 0,
				dependencies: [],
			}
			const resolution = {
				input,
				identity: yield* Resolution.fingerprint(input),
				environment: command.resolution?.environment ?? "",
				...(command.resolution?.environmentModules === undefined
					? {}
					: { environmentModules: command.resolution.environmentModules }),
			}
			return yield* describeTree(
				runtime,
				{
					...command,
					target,
					resolution,
					members: HashMap.make([grant.instance, grant]),
				},
				HashSet.add(ancestors, identity),
			)
		}),
	)
	return {
		...loaded.description,
		members: [root, ...Array.flatMap(children, (child) => child.members)],
	}
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
		members: [],
	}
	return description
})
const diagnostic = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	cause: Cause.Cause<unknown>,
) {
	const encoded = yield* Schema.encodeEffect(Wire.Cause)(cause)
	yield* runtime.emit({ _tag: "Diagnostic", cause: encoded })
}, Effect.orDie)
const identified = (
	command: Wire.Command,
	grant: typeof Wire.UnitMember.Type,
): Wire.Command => ({
	...command,
	target: grant.target,
	...Option.match(HashMap.get(command.resolutions, grant.instance), {
		onNone: () => ({}),
		onSome: (resolution) => ({ resolution }),
	}),
})
const openMember = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
	grant: typeof Wire.UnitMember.Type,
) {
	const configurationScope = yield* Scope.fork(runtime.scope)
	const loaded = yield* load(
		{ ...runtime, scope: configurationScope },
		identified(command, grant),
	)
	const previous = yield* Ref.get(runtime.members).pipe(
		Effect.map((members) => HashMap.get(members, grant.instance)),
	)
	if (
		Option.isSome(previous) &&
		!Equal.equals(
			previous.value.metadata.description.members,
			loaded.description.members,
		)
	)
		return yield* UnitFault.make({
			detail:
				"Cooperative declarations differ from the granted member footprint",
		})
	const router = yield* Option.isSome(loaded.contract)
		? Routing.make(loaded.contract.value.inject, (message) =>
				runtime.emit({
					_tag: "Call",
					message: {
						...message,
						member: grant.instance,
						term: grant.term,
						generation: grant.generation,
					},
				}),
			).pipe(Scope.provide(runtime.scope), Effect.asSome)
		: Effect.succeed(Option.none<Routing.Router>())
	const provider = yield* Option.isSome(loaded.contract) &&
	loaded.contract.value.provides.length > 0
		? Network.provider(
				loaded.contract.value.provides,
				(cause) => diagnostic(runtime, cause),
				runtime.calls,
				{
					member: grant.instance,
					term: grant.term,
					generation: grant.generation,
				},
			).pipe(Scope.provide(runtime.scope), Effect.asSome)
		: Effect.succeed(Option.none<Network.Provider>())
	const member: NativeMember = {
		executionContext: yield* Ref.make(Option.none<Context.Context<unknown>>()),
		configurationScope,
		metadata: loaded,
		grant: yield* Ref.make(grant),
		permits: yield* Queue.unbounded<typeof Wire.UnitMember.Type>(),
		consumed: yield* Ref.make(Option.none<typeof Wire.UnitMember.Type>()),
		offered: yield* Ref.make(0),
		fork: yield* Ref.make(Option.none<Fork.Fork>()),
		provider,
		router,
	}
	yield* Ref.update(runtime.members, HashMap.set(grant.instance, member))
	return member
})
const memberEvent = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	grant: typeof Wire.UnitMember.Type,
	exit: Exit.Exit<void, unknown>,
) {
	const cause = yield* Schema.encodeEffect(Wire.Cause)(
		Exit.isFailure(exit) ? exit.cause : Cause.empty,
	)
	yield* runtime.emit({
		_tag: "MemberStopped",
		member: grant.instance,
		term: grant.term,
		generation: grant.generation,
		cause,
		cleanup: Exit.isSuccess(exit) ? "Completed" : "Failed",
	})
}, Effect.orDie)
const lifecycle = (
	runtime: UnitRuntime,
	member: NativeMember,
	instance: string,
	isolate: Graft.PluginOptions["isolate"],
): Transition.MemberLifecycle => ({
	instance,
	isolate,
	environment: member.metadata.environment,
	expose: (context) => Ref.set(member.executionContext, Option.some(context)),
	acquire: Queue.take(member.permits).pipe(
		Effect.tap((grant) => Ref.set(member.consumed, Option.some(grant))),
		Effect.map((grant) => grant.term),
	),
	failed: (cause) =>
		Ref.get(member.consumed).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (grant) =>
						Schema.encodeEffect(Wire.Cause)(cause).pipe(
							Effect.flatMap((cause) =>
								runtime.emit({
									_tag: "MemberFailed",
									member: instance,
									term: grant.term,
									generation: grant.generation,
									cause,
								}),
							),
							Effect.orDie,
						),
				}),
			),
		),
	stopped: (exit) =>
		Ref.getAndSet(member.consumed, Option.none()).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (grant) => memberEvent(runtime, grant, exit),
				}),
			),
		),
	attached: (fork) =>
		Ref.set(member.fork, Option.some(fork)).pipe(
			Effect.andThen(
				Stream.runForEach(fork.state, (state) =>
					state._tag !== "Active"
						? Effect.void
						: Ref.get(member.consumed).pipe(
								Effect.flatMap(
									Option.match({
										onNone: () => Effect.void,
										onSome: (grant) =>
											runtime.emit({
												_tag: "MemberReady",
												member: instance,
												term: grant.term,
												generation: grant.generation,
											}),
									}),
								),
							),
				).pipe(Effect.forkIn(runtime.scope)),
			),
			Effect.asVoid,
		),
})
const registry = (runtime: UnitRuntime): Transition.MemberRegistry => ({
	open: Effect.fnUntraced(function* (plugin, input, declaration, parent) {
		const members = yield* Ref.get(runtime.members)
		const instance = Option.match(parent, {
			onNone: () => Option.getOrElse(declaration, () => ""),
			onSome: (parent) =>
				`${parent}/${Option.getOrElse(declaration, () => "")}`,
		})
		const member = HashMap.get(members, instance)
		if (Option.isNone(member) || member.value.metadata.plugin !== plugin)
			return yield* Effect.die(
				"The fork is outside the statically granted member declarations",
			)
		const encoded = yield* Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
			Effect.orDie,
		)
		const expected = yield* Resolution.fingerprint(
			member.value.metadata.input,
		).pipe(Effect.provideService(Digest.Digest, runtime.digest), Effect.orDie)
		const actual = yield* Resolution.fingerprint(encoded).pipe(
			Effect.provideService(Digest.Digest, runtime.digest),
			Effect.orDie,
		)
		if (actual !== expected)
			return yield* Effect.die(
				"The fork input differs from its statically granted declaration",
			)
		const grant = yield* Ref.get(member.value.grant)
		const grants = yield* Effect.forEach(members, ([id, member]) =>
			Ref.get(member.grant).pipe(
				Effect.map(
					(grant) =>
						[id, grant] satisfies readonly [
							string,
							typeof Wire.UnitMember.Type,
						],
				),
			),
		)
		return lifecycle(
			runtime,
			member.value,
			instance,
			isolation(grant, member.value.metadata, HashMap.fromIterable(grants)),
		)
	}),
})
const platform = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const existing = yield* Ref.get(runtime.services)
	if (Option.isSome(existing)) return existing.value
	const layer = Graft.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
		),
		Layer.provideMerge(
			Layer.succeed(Transition.UnitMember, Option.some(command.token.unit)),
		),
		/** Unit infrastructure every plugin can inject, first- or third-party alike. */
		Layer.provideMerge(Layer.succeed(Recorder, recorder(runtime))),
	)
	const built = yield* Layer.buildWithScope(layer, runtime.scope)
	const services = Context.add(
		built,
		Transition.Registry,
		Option.some(registry(runtime)),
	)
	yield* Ref.set(runtime.services, Option.some(services))
	return services
})
/** Services every execution unit provides itself; they are never deployment dependencies. */
const unitInfrastructure = HashSet.make(Recorder.key)
/** Deliveries are queued for whichever plugin in this unit holds the role; identity comes from the channel. */
const recorder = (runtime: UnitRuntime): Recorder["Service"] => ({
	register: (name) =>
		runtime.emit({ _tag: "RecorderRegister", recorder: name }),
	records: Stream.fromQueue(runtime.records),
	acknowledge: (record) =>
		runtime.emit({
			_tag: "RecordAck",
			record: record.id,
			content: record.content,
		}),
})
const isolation = (
	grant: typeof Wire.UnitMember.Type,
	loaded: Metadata,
	members: HashMap.HashMap<string, typeof Wire.UnitMember.Type>,
): Graft.PluginOptions["isolate"] => {
	const contracts = Option.isSome(loaded.contract)
		? loaded.contract.value
		: undefined
	return Array.dedupeWith(
		[
			...Array.map(
				Array.flatMap(
					loaded.description.members,
					(member) => member.localProvides,
				),
				(key) =>
					[{ key }, grant.realm] satisfies readonly [Graft.Isolatable, string],
			),
			...Array.map(
				Array.filter(
					grant.dependencies,
					(dependency) => dependency.kind === "Local",
				),
				(dependency) =>
					[
						{ key: dependency.service },
						Option.match(dependency.provider, {
							onNone: () => grant.realm,
							onSome: (provider) =>
								Option.getOrElse(
									Option.map(
										HashMap.get(members, provider),
										(member) => member.realm,
									),
									() => grant.realm,
								),
						}),
					] satisfies readonly [Graft.Isolatable, string],
			),
			...Array.map(
				contracts?.provides ?? [],
				(service) =>
					[{ key: service.key.key }, grant.realm] satisfies readonly [
						Graft.Isolatable,
						string,
					],
			),
			...Array.map(
				contracts?.inject ?? [],
				(service) =>
					[
						{ key: service.key.key },
						`rpc:${grant.instance}`,
					] satisfies readonly [Graft.Isolatable, string],
			),
		],
		(left, right) =>
			("key" in left ? left.key : left[0].key) ===
			("key" in right ? right.key : right[0].key),
	)
}
const support = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	services: Context.Context<Graft.Graft>,
	id: string,
	plugin: Plugin.Plugin,
	isolate: Graft.PluginOptions["isolate"],
) {
	const member = yield* Graft.plugin(plugin, undefined, { isolate }).pipe(
		Effect.provideContext(
			Context.add(
				Context.add(services, Transition.Registry, Option.none()),
				Transition.Lifecycle,
				Option.none(),
			),
		),
		Scope.provide(runtime.scope),
	)
	yield* Ref.update(runtime.support, HashMap.set(id, member))
	return member
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
	member: NativeMember,
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
		apply: () =>
			Ref.get(member.executionContext).pipe(
				Effect.flatMap(Effect.fromOption),
				Effect.flatMap((context) =>
					Plugin.fork(provider.serve.pipe(Effect.provideContext(context))),
				),
				Effect.asVoid,
			),
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
const offer = Effect.fnUntraced(function* (
	member: NativeMember,
	grant: typeof Wire.UnitMember.Type,
) {
	const fresh = yield* Ref.modify(member.offered, (previous) => [
		grant.generation > previous,
		Math.max(previous, grant.generation),
	])
	if (!fresh) return
	yield* Ref.set(member.grant, grant)
	yield* Queue.offer(member.permits, grant)
})
const serveMember = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
	instance: string,
) {
	const member = yield* Ref.get(runtime.members).pipe(
		Effect.flatMap((members) =>
			Effect.fromOption(HashMap.get(members, instance)),
		),
	)
	const grant = yield* Effect.fromOption(HashMap.get(command.members, instance))
	const built = yield* platform(runtime, command)
	const services = Context.add(
		built,
		Transition.Environment,
		member.metadata.environment,
	)
	const isolate = isolation(grant, member.metadata, command.members)
	const view = {
		routes: Array.filter(
			command.view?.routes ?? [],
			(route) => route.consumer === instance,
		),
	}
	if (Option.isSome(member.router)) {
		yield* member.router.value.install(command.token, view)
		yield* member.router.value.activate(command.token)
	}
	if (
		Option.isSome(member.metadata.contract) &&
		Option.isSome(member.router) &&
		member.metadata.contract.value.inject.length > 0
	) {
		const importer = yield* support(
			runtime,
			services,
			`${instance}/imports`,
			imports(member.metadata.contract.value, member.router.value),
			isolate,
		)
		yield* active(importer)
	}
	yield* offer(member, grant)
	if (Option.isNone(grant.parent)) {
		const existing = yield* Ref.get(member.fork)
		if (Option.isNone(existing))
			yield* Graft.plugin(member.metadata.plugin, member.metadata.input, {
				declaration: instance,
			}).pipe(Effect.provideContext(services), Scope.provide(runtime.scope))
	}
	if (Option.isSome(member.provider) && Option.isSome(member.metadata.contract))
		yield* support(
			runtime,
			services,
			`${instance}/exports`,
			exports(
				member.metadata,
				member.metadata.contract.value,
				member.provider.value,
				member,
			),
			isolate,
		)
})
const eachMember = (
	runtime: UnitRuntime,
	command: Wire.Command,
	f: (
		member: NativeMember,
		id: string,
	) => Effect.Effect<
		void,
		UnitFault | Fork.CleanupError | Cause.NoSuchElementError
	>,
): Effect.Effect<
	void,
	UnitFault | Fork.CleanupError | Cause.NoSuchElementError
> =>
	Ref.get(runtime.members).pipe(
		Effect.flatMap((members) =>
			Effect.forEach(
				command.subjects,
				(id) =>
					Option.match(HashMap.get(members, id), {
						onNone: () =>
							UnitFault.make({
								detail: "Command subject is not a hosted member",
							}),
						onSome: (member) => f(member, id),
					}),
				{ discard: true, concurrency: "unbounded" },
			),
		),
	)
const ready = (runtime: UnitRuntime, command: Wire.Command) =>
	eachMember(runtime, command, (member) =>
		Ref.get(member.fork).pipe(
			Effect.flatMap(Effect.fromOption),
			Effect.flatMap(active),
		),
	)
const disposeSupport = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
	suffix: string,
) {
	const support = yield* Ref.get(runtime.support)
	yield* Effect.forEach(
		command.subjects,
		(id) =>
			Option.match(HashMap.get(support, `${id}/${suffix}`), {
				onNone: () => Effect.void,
				onSome: (fork) => fork.dispose,
			}),
		{ discard: true, concurrency: "unbounded" },
	)
	yield* Ref.update(runtime.support, (support) =>
		HashSet.reduce(command.subjects, support, (support, id) =>
			HashMap.remove(support, `${id}/${suffix}`),
		),
	)
})
const stopMembers = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	yield* disposeSupport(runtime, command, "exports")
	yield* eachMember(runtime, command, (member) =>
		Ref.get(member.fork).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Ref.get(member.grant).pipe(
							Effect.flatMap((grant) => memberEvent(runtime, grant, Exit.void)),
						),
					onSome: (fork) =>
						fork.dispose.pipe(
							Effect.andThen(Ref.set(member.fork, Option.none())),
						),
				}),
			),
		),
	)
	yield* disposeSupport(runtime, command, "imports")
	yield* eachMember(runtime, command, (member) =>
		Scope.close(member.configurationScope, Exit.void),
	)
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
const startGranted = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const opened = yield* Effect.forEach(command.subjects, (instance) =>
		Effect.fromOption(HashMap.get(command.members, instance)).pipe(
			Effect.flatMap((grant) => openMember(runtime, command, grant)),
		),
	)
	const first = yield* Effect.fromOption(Array.head(opened))
	const value = {
		...first.metadata.description,
		members: Array.flatMap(
			opened,
			(member) => member.metadata.description.members,
		),
	}
	const endpoints = HashMap.fromIterable(
		Array.flatMap(opened, (member) =>
			Option.toArray(
				Option.map(
					member.provider,
					(provider) =>
						[
							member.metadata.description.members[0]?.instance ?? "",
							provider.endpoint,
						] satisfies readonly [string, Wire.Endpoint],
				),
			),
		),
	)
	return { _tag: "Started", value, endpoints } satisfies Wire.Report
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
	| Fork.CleanupError
	| Socket.SocketError,
	FileSystem.FileSystem | Path.Path | Digest.Digest | SecureRandom.SecureRandom
> {
	if (
		(HashMap.every(command.token.members, (member) => member.term === 0) ||
			command.target.deployment?.inspection === "Module") &&
		["Start", "Serve", "Install", "Activate"].includes(command.kind)
	)
		return yield* UnitFault.make({
			detail: "Inspection has no serving authority",
		})
	switch (command.kind) {
		case "RetireRoute": {
			const members = yield* Ref.get(runtime.members)
			if (command.call !== undefined)
				yield* Effect.forEach(
					HashMap.values(members),
					(member) =>
						Option.match(member.router, {
							onNone: () => Effect.void,
							onSome: (router) => router.retire(command.call?.key ?? ""),
						}),
					{ discard: true },
				)
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
			const members = yield* Ref.get(runtime.members)
			yield* Effect.forEach(
				command.subjects,
				(instance) =>
					Option.match(HashMap.get(members, instance), {
						onNone: () => Effect.void,
						onSome: (member) =>
							Option.match(member.router, {
								onNone: () => Effect.void,
								onSome: (router) => router.decide(command),
							}),
					}),
				{ discard: true },
			)
			return { _tag: "Succeeded" }
		}

		case "Describe":
			return {
				_tag: "Described",
				value:
					command.target.deployment?.moduleKind !== undefined
						? yield* describeModule(runtime, command)
						: yield* describeTree(runtime, command),
			}
		case "Start":
		case "RestartMembers":
			return yield* startGranted(runtime, command)

		case "Serve":
		case "ServeMembers":
			yield* Effect.forEach(
				command.subjects,
				(instance) => serveMember(runtime, command, instance),
				{ discard: true },
			)
			return { _tag: "Succeeded" }
		case "StopMembers":
			yield* stopMembers(runtime, command)
			return { _tag: "Succeeded" }
		case "Ready":
		case "ReadyMembers":
			yield* ready(runtime, command)
			return { _tag: "Succeeded" }
		case "Probe": {
			const members = yield* Ref.get(runtime.members)
			yield* Effect.forEach(
				command.subjects,
				(instance) =>
					Effect.gen(function* () {
						const member = yield* Effect.fromOption(
							HashMap.get(members, instance),
						)
						const fork = yield* Ref.get(member.fork).pipe(
							Effect.flatMap(Effect.fromOption),
						)
						yield* Effect.forEach(
							command.probes ?? [],
							(name) => fork.probe(name),
							{ discard: true },
						)
					}),
				{ discard: true },
			)
			return { _tag: "Succeeded" }
		}
		case "Install":
		case "Activate":
		case "Discard": {
			const members = yield* Ref.get(runtime.members)
			if (command.kind === "Install") yield* ready(runtime, command)
			const installed = yield* Ref.get(runtime.views)
			if (
				command.kind === "Activate" &&
				!HashMap.has(installed, `${command.token.change}/${command.token.view}`)
			)
				return yield* UnitFault.make({ detail: "View was not installed" })
			yield* Effect.forEach(
				command.subjects,
				(instance) =>
					Option.match(HashMap.get(members, instance), {
						onNone: () => Effect.void,
						onSome: (member) =>
							Option.match(member.router, {
								onNone: () => Effect.void,
								onSome: (router) =>
									command.kind === "Install"
										? router.install(
												command.token,
												command.view ?? { routes: [] },
											)
										: command.kind === "Activate"
											? router.activate(command.token)
											: router.discard(command.token),
							}),
					}),
				{ discard: true },
			)
			if (command.kind === "Install")
				yield* Ref.update(
					runtime.views,
					HashMap.set(
						`${command.token.change}/${command.token.view}`,
						command.token,
					),
				)
			return { _tag: "Succeeded" }
		}

		case "Stop":
			yield* stop(runtime)
			return { _tag: "Succeeded" }
		case "Record": {
			if (command.record === undefined)
				return yield* UnitFault.make({ detail: "The record delivery is empty" })
			yield* Queue.offer(runtime.records, command.record)
			return { _tag: "Succeeded" }
		}
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
		digest: yield* Digest.Digest,
		calls,
		initial: yield* Ref.make(Option.none<Wire.Command>()),
		members: yield* Ref.make(HashMap.empty<string, NativeMember>()),
		services: yield* Ref.make(Option.none<Context.Context<Graft.Graft>>()),
		support: yield* Ref.make(HashMap.empty<string, Fork.Fork>()),
		scope: unitScope,
		views: yield* Ref.make(HashMap.empty<string, Wire.Token>()),
		stopped: yield* Deferred.make<void>(),
		commands: yield* FiberMap.make<string, void, never>(),
		replies: yield* Ref.make(HashMap.empty<string, Wire.Report>()),
		records: yield* Queue.unbounded<Wire.RecordDuty>(),
		emit: transmit,
	}
	yield* runtime.emit({ _tag: "Online" })
	yield* Queue.take(queue).pipe(
		Effect.flatMap(Wire.decodeIncoming),
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
