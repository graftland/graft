/** The only native bootstrap that imports plugin and contract modules. Importing it performs no I/O. */
import process from "node:process"
import { pathToFileURL } from "node:url"
import { parentPort } from "node:worker_threads"

import {
	Array,
	Cause,
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
	Queue,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { Digest } from "effect/crypto"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Fork, Graft, Plugin, Transition, type Kernel } from "@graftland/graft"

import * as Artifact from "../Artifact"
import * as Contract from "../Contract"
import * as Operations from "./operations"
import * as Wire from "./unitProtocol"
import * as Resolution from "./unitResolution"

class UnitFault extends Schema.TaggedError<
	UnitFault,
	{ readonly brand: unique symbol }
>()("UnitFault", {
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}
interface Metadata {
	readonly plugin: Plugin.Plugin
	readonly contract: Contract.RunnerContract
	readonly description: Kernel.Description
	readonly input: Schema.Json
}
interface UnitRuntime {
	readonly initial: Ref.Ref<Option.Option<Wire.Command>>
	readonly metadata: Ref.Ref<Option.Option<Metadata>>
	readonly member: Ref.Ref<Option.Option<Fork.Fork>>
	readonly scope: Scope.Closeable
	readonly views: Ref.Ref<HashMap.HashMap<number, Wire.Token>>
	readonly active: Ref.Ref<Option.Option<Wire.Token>>
	readonly stopped: Deferred.Deferred<void>
	readonly commands: FiberMap.FiberMap<string, void, never>
	readonly replies: Ref.Ref<HashMap.HashMap<string, Wire.Report>>
	readonly emit: (frame: Wire.Outgoing) => Effect.Effect<void>
}
const transmit = (frame: Wire.Outgoing): Effect.Effect<void> =>
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
const input = Effect.fnUntraced(function* () {
	const queue = yield* Queue.unbounded<unknown>()
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
const load = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const deployment = command.target.deployment
	const resolution = command.resolution
	if (deployment === undefined || resolution === undefined)
		return yield* UnitFault.make({
			detail: "Unit deployment or resolution is missing",
		})
	const fingerprint = yield* Resolution.fingerprint(resolution.input)
	if (
		fingerprint !== resolution.identity ||
		Resolution.environment(command.target.placement) !== resolution.environment
	)
		return yield* UnitFault.make({
			detail:
				"Unit resolution or validation environment differs from its grant",
		})
	yield* Artifact.verify(deployment.artifact)
	const path = yield* Path.Path
	const contractPath = path.resolveWithin(
		deployment.artifact.directory,
		deployment.contract,
	)
	if (Option.isNone(contractPath))
		return yield* UnitFault.make({
			detail: "Contract export escapes its immutable artifact",
		})
	yield* runtime.emit({ _tag: "Progress", stage: "DescribeImport" })
	const contractModule = yield* importModule(
		pathToFileURL(contractPath.value).href,
	)
	const contract = yield* Effect.fromOption(
		Contract.fromModule(contractModule),
		() => UnitFault.make({ detail: "Expected a unit contract export" }),
	)
	yield* runtime.emit({ _tag: "Progress", stage: "DescribeDecode" })
	yield* Schema.decodeEffect(contract.config)(resolution.input)
	const implementation = yield* Artifact.implementation(deployment.artifact)
	const module = yield* importModule(implementation)
	const plugin = yield* Effect.fromOption(Plugin.fromModule(module), () =>
		UnitFault.make({ detail: "Expected a plugin export" }),
	)
	const descriptor: Kernel.Description = {
		artifact: deployment.artifact.identity.digest,
		configuration: resolution.identity,
		environment: resolution.environment,
		protocol: 1,
		overlap: plugin.overlap,
		members: 1,
		requires: Array.map(contract.inject, (s) =>
			serviceDescription(s, deployment.artifact.identity.digest),
		),
		provides: Array.map(contract.provides, (s) =>
			serviceDescription(s, deployment.artifact.identity.digest),
		),
		probes: [],
	}
	yield* Schema.decodeEffect(Wire.Description)(descriptor)
	return { plugin, contract, description: descriptor, input: resolution.input }
}, Effect.scoped)
const metadata = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const loaded = yield* load(runtime, command)
	yield* Ref.set(runtime.metadata, Option.some(loaded))
	return loaded
})
const serve = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
) {
	const loaded = yield* Ref.get(runtime.metadata).pipe(
		Effect.flatMap(Effect.fromOption),
	)
	const platform = Graft.layer.pipe(
		Layer.provideMerge(NodeServices.layer),
		Layer.provideMerge(
			Layer.succeed(Transition.UnitMember, Option.some(command.token.unit)),
		),
		Layer.provideMerge(
			Layer.succeed(Plugin.UnitTerm, Option.some(command.token.term)),
		),
	)
	const services = yield* Layer.buildWithScope(platform, runtime.scope)
	const member = yield* Graft.plugin(loaded.plugin, loaded.input).pipe(
		Effect.provideContext(services),
		Scope.provide(runtime.scope),
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
const ready = Effect.fnUntraced(function* (runtime: UnitRuntime) {
	const member = yield* Ref.get(runtime.member).pipe(
		Effect.flatMap(Effect.fromOption),
	)
	yield* Stream.runHead(
		member.state.pipe(
			Stream.filter(
				(state) => state._tag === "Active" || state._tag === "Failed",
			),
			Stream.mapEffect((state) =>
				state._tag === "Failed"
					? UnitFault.make({ detail: "Unit member failed", cause: state.cause })
					: Effect.void,
			),
		),
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
const perform = Effect.fnUntraced(function* (
	runtime: UnitRuntime,
	command: Wire.Command,
): Effect.fn.Return<
	Wire.Report,
	| UnitFault
	| Schema.SchemaError
	| Artifact.ArtifactError
	| Cause.NoSuchElementError
	| Fork.ProbeError,
	FileSystem.FileSystem | Path.Path | Digest.Digest
> {
	if (
		command.token.term === 0 &&
		["Start", "Serve", "Install", "Activate"].includes(command.kind)
	)
		return yield* UnitFault.make({
			detail: "Inspection has no serving authority",
		})
	switch (command.kind) {
		case "Describe":
			return {
				_tag: "Described",
				value: (yield* metadata(runtime, command)).description,
			}
		case "Start":
			return {
				_tag: "Started",
				value: (yield* metadata(runtime, command)).description,
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
			yield* Ref.update(
				runtime.views,
				HashMap.set(command.token.view, command.token),
			)
			return { _tag: "Succeeded" }
		case "Activate": {
			const installed = yield* Ref.get(runtime.views)
			if (!HashMap.has(installed, command.token.view))
				return yield* UnitFault.make({ detail: "View was not installed" })
			yield* Ref.set(runtime.active, Option.some(command.token))
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
	const runtime: UnitRuntime = {
		initial: yield* Ref.make(Option.none<Wire.Command>()),
		metadata: yield* Ref.make(Option.none<Metadata>()),
		member: yield* Ref.make(Option.none<Fork.Fork>()),
		scope: yield* Scope.fork(owner),
		views: yield* Ref.make(HashMap.empty<number, Wire.Token>()),
		active: yield* Ref.make(Option.none<Wire.Token>()),
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
			Effect.provide(Layer.merge(NodeServices.layer, Digest.layerWebCrypto)),
		),
	)
