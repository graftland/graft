/**
 * A group loads a list of entries and reconciles it in place when the list
 * changes: untouched entries keep running, configuration changes are applied
 * through `Fork.update`, and anything else is unloaded and loaded again.
 */
import { Select } from "./Entry"

import { Graft, Plugin, Fork } from "@graftland/graft"
import {
	Array,
	Cause,
	Context,
	Effect,
	Equal,
	Deferred,
	Exit,
	Queue,
	FiberMap,
	HashMap,
	Option,
	Record,
	Ref,
	Schema,
	Stream,
	Scope,
	ScopedRef,
	type Config,
} from "effect"
import { equalConfig } from "./internal/equalConfig"
import { PendingRefreshes, track } from "./internal/pending"
import { CurrentId, Entry, resolveEnv, type CyclicConfig } from "./Entry"
import { ModuleResolver } from "./ModuleResolver"
import * as Intercept from "./Intercept"
import { GroupEntries, validateGroup, type InvalidOperation } from "./Tree"

import {
	epochOf,
	nextEpoch,
	preserveEpoch,
	withEpoch,
} from "./internal/refresh"
import { copyGroup, groups } from "./internal/validated"
import { snapshot } from "./internal/snapshot"

interface Child {
	readonly entry: Entry
	readonly fork: Fork.Fork
	readonly identity: symbol
	readonly generation: number
	readonly epoch: number
	readonly failed: Effect.Effect<boolean>
}

type Request =
	| {
			readonly _tag: "Reconcile"
			readonly entries: ReadonlyArray<Entry>
			readonly reply: Deferred.Deferred<void>
	  }
	| {
			readonly _tag: "Refresh"
			readonly id: string
			readonly identity: symbol
			readonly generation: number
			readonly source: Fork.Fork
			readonly reply: Deferred.Deferred<void>
	  }

/** Everything about an entry except its configuration: changing any of it means loading it again. */
const shape = (entry: Entry) => [
	entry.name,
	entry.group === true,
	entry.inject ?? [],
	entry.isolate ?? {},
	entry.intercept ?? {},
]

/** Waiters observe state only; the group executor owns every submitted update. */
const onceActive = (fork: Fork.Fork, request: Effect.Effect<void>) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag !== "Loading"),
		Stream.runHead,
		Effect.flatMap((state) =>
			Option.exists(state, (state) => state._tag === "Active")
				? request
				: Effect.void,
		),
	)

/** Keep the actual plugin handle in its activation, including behind an injection gate. */
const updateTarget = Effect.fnUntraced(function* (
	fork: Fork.Fork,
	initial: unknown,
	forward: boolean,
	refresh: (source: Fork.Fork) => Effect.Effect<void>,
) {
	const previous = yield* Ref.make(initial)
	return Effect.fnUntraced(function* (next: unknown) {
		const before = yield* Ref.get(previous)
		const changed = !equalConfig(before, next)
		const state = yield* Stream.runHead(fork.state)
		if (changed) yield* fork.update(next)
		else if (Option.exists(state, (state) => state._tag === "Failed"))
			yield* fork.restart
		else if (
			forward &&
			Option.exists(state, (state) => state._tag === "Active")
		)
			yield* fork.update(next)
		// A group that is still loading has children that may have started with
		// the old environment.
		else if (
			forward &&
			Option.exists(state, (state) => state._tag === "Loading")
		)
			yield* refresh(fork)
		yield* Ref.set(previous, next)
		return true
	})
})

/** Waits for services named by string key before loading the plugin. */
const waitingFor = (
	keys: ReadonlyArray<string>,
	plugin: Plugin.Plugin,
	group: boolean,
	refresh: (source: Fork.Fork) => Effect.Effect<void>,
	observe: (fork: Fork.Fork) => Effect.Effect<void>,
) =>
	Plugin.make({
		name: plugin.name,
		config: Schema.Unknown,
		inject: Array.map(keys, (key) => Context.Service<unknown>(key)),
		apply: (input) =>
			Effect.flatMap(Graft.plugin(plugin, input), (fork) =>
				observe(fork).pipe(
					Effect.andThen(updateTarget(fork, input, group, refresh)),
				),
			),
	})

const isolationOf = (entry: Entry): Graft.PluginOptions => ({
	isolate: Array.map(Record.toEntries(entry.isolate ?? {}), ([key, realm]) =>
		realm === true ? { key } : ([{ key }, realm] as const),
	),
})

/** Group config describes children; each active leaf resolves its own environment. */
const inputOf = (
	entry: Entry,
): Effect.Effect<
	unknown,
	Config.ConfigError | CyclicConfig | InvalidOperation
> =>
	entry.group === true
		? Effect.fromResult(
				validateGroup(entry.config === undefined ? [] : entry.config),
			).pipe(
				Effect.map((entries) =>
					withEpoch(copyGroup(entries), epochOf(entry) ?? nextEpoch()),
				),
			)
		: resolveEnv(entry.config).pipe(Effect.map(snapshot))

/** The entry's own intercept patches with their environment resolved. */
const patchesOf = (entry: Entry) =>
	resolveEnv(entry.intercept ?? {}).pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown)),
		),
		Effect.map(snapshot),
	)

/** Prepare only this activation; group descendants keep their raw descriptions. */
const prepare = Effect.fnUntraced(function* (
	entry: Entry,
	registry: Context.Service.Shape<typeof Intercept.Registry>,
) {
	const input = yield* inputOf(entry)
	const patches = yield* patchesOf(entry)
	const intercept = yield* Intercept.resolve(registry, patches)
	return { input, patches, intercept }
})

/** Both owned cleanup phases finish before caller interruption is restored. */
const disposeEntry = (fork: Fork.Fork, owner: Scope.Closeable) =>
	Effect.uninterruptible(
		Effect.gen(function* () {
			const lifecycle = yield* Effect.exit(fork.dispose)
			const observation = yield* Effect.exit(Scope.close(owner, lifecycle))
			const lifecycleCause = Exit.isFailure(lifecycle)
				? Array.reduce(
						lifecycle.cause.reasons,
						Cause.empty,
						(acc: Cause.Cause<unknown>, reason) =>
							Cause.combine(
								acc,
								Cause.isFailReason(reason)
									? reason.error.cause
									: Cause.fromReasons([reason]),
							),
					)
				: Cause.empty
			const cause = Exit.isFailure(observation)
				? Cause.combine(lifecycleCause, observation.cause)
				: lifecycleCause
			if (cause.reasons.length > 0)
				return yield* Fork.CleanupError.make({ cause })
		}),
	)

/** A disposed fork is gone even when its cleanup failed; the remaining target must still reconcile. */
const disposeChild = (child: Child) =>
	child.fork.dispose.pipe(
		Effect.catchCause((cause) => {
			const reported = Array.reduce(
				cause.reasons,
				Cause.empty,
				(acc: Cause.Cause<unknown>, reason) =>
					Cause.combine(
						acc,
						Cause.isFailReason(reason)
							? reason.error.cause
							: Cause.fromReasons([reason]),
					),
			)
			// CleanupError owns the cleanup failure. Outer defects/interruption belong
			// to this call, so logging them must not turn cancellation into success.
			const unhandled = Cause.fromReasons<never>(
				Array.filter(cause.reasons, (reason) => !Cause.isFailReason(reason)),
			)
			return Effect.logError("Disposing a loader entry failed", reported).pipe(
				Effect.annotateLogs({
					"loader.entry": child.entry.id,
					"loader.plugin": child.entry.name,
					"graft.fork": child.fork.id,
				}),
				Effect.andThen(
					unhandled.reasons.length > 0
						? Effect.failCause(unhandled)
						: Effect.void,
				),
			)
		}),
	)

const definition = Plugin.make({
	name: "group",
	config: GroupEntries,
	inject: [ModuleResolver],
	apply: (entries) =>
		Effect.gen(function* () {
			const select = yield* Select
			const resolver = yield* ModuleResolver
			const registry = yield* Intercept.Registry
			const context = yield* Effect.context<Graft.Graft | Scope.Scope>()
			const children = yield* Ref.make(HashMap.empty<string, Child>())
			const settling = yield* FiberMap.make<string>()
			const pending = yield* PendingRefreshes

			const requests = yield* Queue.bounded<Request, Cause.Done>(1)
			yield* Effect.addFinalizer(() =>
				Queue.end(requests).pipe(
					Effect.andThen(Queue.collect(requests)),
					Effect.flatMap((queued) =>
						Effect.forEach(
							queued,
							(request) => Deferred.done(request.reply, Exit.interrupt()),
							{ discard: true },
						),
					),
				),
			)
			const submit = (request: Request) =>
				Queue.offer(requests, request).pipe(
					Effect.flatMap((accepted) =>
						accepted ? Deferred.await(request.reply) : Effect.interrupt,
					),
				)

			const refresh = (id: string, identity: symbol, source: Fork.Fork) =>
				Effect.gen(function* () {
					const current = yield* Ref.get(children)
					const child = HashMap.get(current, id)
					if (Option.isNone(child) || child.value.identity !== identity) return
					const reply = yield* Deferred.make<void>()
					const request: Request = {
						_tag: "Refresh",
						id,
						identity,
						generation: child.value.generation,
						source,
						reply,
					}
					yield* FiberMap.run(
						settling,
						id,
						track(pending, onceActive(source, submit(request))).pipe(
							Effect.catchCauseIf(
								(cause) => !Cause.hasInterruptsOnly(cause),
								(cause) =>
									Effect.logError("Scheduling an entry refresh failed", cause),
							),
						),
					)
				})

			// Register the lifecycle before any resolution can suspend. Core owns its
			// activation generation, so interruption closes the resolver scope and
			// a late result cannot publish a child into a removed activation.
			const load = Effect.fnUntraced(function* (entry: Entry, epoch: number) {
				entry = withEpoch({ ...entry }, epoch)
				const targetFork = yield* Ref.make(Option.none<Fork.Fork>())
				const gatedFork = yield* Ref.make(Option.none<Fork.Fork>())
				const identity = Symbol(entry.id)
				const refreshEntry = (source: Fork.Fork) =>
					refresh(entry.id, identity, source)
				const parent = yield* Effect.scope
				const owner = yield* Scope.fork(parent)
				// Observation generations survive failed activations until retry or entry disposal.
				const observations = yield* ScopedRef.fromAcquire(Effect.scope).pipe(
					Scope.provide(owner),
				)
				const lifecycle = Plugin.make({
					name: entry.name,
					config: Entry,
					apply: (entry) =>
						Effect.gen(function* () {
							yield* Ref.set(gatedFork, Option.none())
							yield* ScopedRef.set(observations, Effect.scope)
							const observationScope = yield* ScopedRef.get(observations)
							const plugin: Plugin.Plugin =
								entry.group === true
									? Group
									: yield* resolver.resolve(entry.name, { observationScope })
							// Read the environment once the module is ready. Retry leaves a
							// loading entry alone, so values read before a long import would
							// otherwise start the plugin stale.
							const { input, patches, intercept } = yield* prepare(
								entry,
								registry,
							)
							const target = Array.isReadonlyArrayNonEmpty(entry.inject ?? [])
								? waitingFor(
										entry.inject ?? [],
										plugin,
										entry.group === true,
										refreshEntry,
										(fork) => Ref.set(gatedFork, Option.some(fork)),
									)
								: plugin
							const fork = yield* Graft.plugin(target, input, {
								intercept: [
									...intercept,
									Graft.intercept(CurrentId, () => Option.some(entry.id)),
								],
							})
							yield* Ref.set(targetFork, Option.some(fork))

							const update = yield* updateTarget(
								fork,
								input,
								entry.group === true || target !== plugin,
								refreshEntry,
							)
							return (next: Entry) =>
								Effect.gen(function* () {
									// Intercepts are fixed when the plugin is forked, so a
									// changed value has to start the entry again.
									const nextPatches = yield* patchesOf(next)
									if (!equalConfig(nextPatches, patches)) return false
									const input = yield* inputOf(next)
									return yield* update(input)
								}).pipe(
									Effect.catchCause((cause) => {
										// All typed preparation errors request a restart. Record every
										// reason, and propagate accompanying defects or interruption.
										const unhandled = Cause.fromReasons<never>(
											Array.filter(
												cause.reasons,
												(reason) => !Cause.isFailReason(reason),
											),
										)
										return Effect.logWarning(
											"Preparing an entry update failed",
											cause,
										).pipe(
											Effect.andThen(
												unhandled.reasons.length > 0
													? Effect.failCause(unhandled)
													: Effect.succeed(false),
											),
										)
									}),
								)
						}),
				})
				const fork = yield* Graft.plugin(
					Equal.byReference({
						...lifecycle,
						decode: preserveEpoch(lifecycle.decode),
					}),
					entry,
					isolationOf(entry),
				).pipe(Scope.provide(owner))
				return {
					entry,
					identity,
					generation: 0,
					epoch,
					failed: Effect.gen(function* () {
						const targets = [
							yield* Ref.get(gatedFork),
							yield* Ref.get(targetFork),
						]
						for (const target of targets) {
							if (Option.isNone(target)) continue
							const state = yield* Stream.runHead(target.value.state)
							if (Option.exists(state, (state) => state._tag === "Failed"))
								return true
						}
						return false
					}),
					fork: {
						...fork,
						dispose: disposeEntry(fork, owner),
					},
				} satisfies Child
			}, Effect.uninterruptible)

			const reconcile = Effect.fnUntraced(function* (
				next: ReadonlyArray<Entry>,
			) {
				const epoch = epochOf(next) ?? nextEpoch()
				const wanted = Array.filter(
					snapshot(next),
					(entry) => entry.disabled !== true && select(entry),
				)
				const byId = HashMap.fromIterable(
					Array.map(wanted, (entry) => [entry.id, entry] as const),
				)
				let current = yield* Ref.get(children)
				const removed = Array.filter(
					Array.fromIterable(current),
					([id, child]) => {
						const entry = HashMap.get(byId, id)
						return (
							Option.isNone(entry) ||
							!equalConfig(shape(entry.value), shape(child.entry))
						)
					},
				)
				// Start every close: a provider may be draining a consumer later in this list.
				yield* Effect.forEach(
					removed,
					([id, child]) =>
						FiberMap.remove(settling, id).pipe(
							Effect.andThen(disposeChild(child)),
						),
					{ concurrency: "unbounded", discard: true },
				)
				for (const [id] of removed) current = HashMap.remove(current, id)
				// One coordinator publishes all identities and generations before workers start.
				const jobs = yield* Effect.forEach(wanted, (description) =>
					Effect.gen(function* () {
						const entry = withEpoch({ ...description }, epoch)
						const existing = HashMap.get(current, entry.id)
						if (Option.isNone(existing)) {
							const child = yield* load(entry, epoch)
							current = HashMap.set(current, entry.id, child)
							return { run: Effect.void }
						}
						const before = existing.value
						const child = {
							...before,
							entry,
							epoch: Math.max(before.epoch, epoch),
							generation: before.generation + 1,
						}
						yield* FiberMap.remove(settling, entry.id)
						current = HashMap.set(current, entry.id, child)
						return {
							run: Effect.gen(function* () {
								const state = yield* Stream.runHead(child.fork.state)
								const unchanged = equalConfig(before.entry.config, entry.config)
								if (
									unchanged &&
									Option.exists(state, (state) => state._tag === "Failed")
								)
									yield* child.fork.restart
								else if (
									!unchanged ||
									(Option.exists(state, (state) => state._tag === "Active") &&
										(before.epoch < epoch || (yield* child.failed)))
								)
									yield* child.fork.update(entry)
								else if (
									Option.exists(state, (state) => state._tag === "Loading")
								)
									yield* refresh(entry.id, child.identity, child.fork)
							}),
						}
					}),
				)
				yield* Ref.set(children, current)
				yield* Effect.all(
					Array.map(jobs, (job) => job.run),
					{ concurrency: "unbounded", discard: true },
				)
			})

			const applyRequest = (request: Request) =>
				Effect.gen(function* () {
					if (request._tag === "Reconcile")
						return yield* reconcile(request.entries)
					const current = yield* Ref.get(children)
					const child = HashMap.get(current, request.id)
					if (
						Option.isNone(child) ||
						child.value.identity !== request.identity ||
						child.value.generation !== request.generation
					)
						return
					const source = yield* Stream.runHead(request.source.state)
					if (!Option.exists(source, (state) => state._tag === "Active")) return
					yield* child.value.fork.update(child.value.entry)
				})
			yield* Stream.fromQueue(requests).pipe(
				Stream.runForEach((request) =>
					(request._tag === "Refresh"
						? track(pending, applyRequest(request))
						: applyRequest(request)
					).pipe(
						Effect.provideContext(context),
						Effect.onExit((exit) => Deferred.done(request.reply, exit)),
						Effect.catchCauseIf(
							(cause) => !Cause.hasInterruptsOnly(cause),
							(cause) =>
								Effect.logError("Reconciling a group request failed", cause),
						),
					),
				),
				Effect.forkScoped,
			)
			const update = (entries: ReadonlyArray<Entry>) =>
				Effect.gen(function* () {
					const reply = yield* Deferred.make<void>()
					yield* submit({
						_tag: "Reconcile",
						entries: withEpoch(
							copyGroup(entries),
							epochOf(entries) ?? nextEpoch(),
						),
						reply,
					})
					return true
				})
			yield* update(entries)
			return update
		}),
})

/** Public arrays request a full refresh; internal requests retain their explicit epoch. */
export const Group = Equal.byReference({
	...definition,
	decode: preserveEpoch((input: ReadonlyArray<Entry>) =>
		groups.has(input)
			? Effect.succeed(input)
			: Schema.decodeEffect(GroupEntries)(input),
	),
})
