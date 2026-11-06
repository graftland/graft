import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	HashMap,
	HashSet,
	Layer,
	MutableRef,
	Option,
	Ref,
} from "effect"
import { McpSchema, McpServer } from "effect/ai"

import { Event, type Graft } from "@graftland/graft"

import * as Catalog from "../Catalog"
import * as Extensions from "../Extensions"
import * as Middleware from "../Middleware"
import { Updated } from "../Resources"
import { Base } from "./base"
import { same, snapshot } from "./extensions"
import * as Liveness from "./liveness"

// Shared across projections so nested fan-out never waits on its originating sync.
const synchronizing = Event.makeOrigin()

const lists = ["tools", "resources", "resourceTemplates", "prompts"] as const
type List = (typeof lists)[number]

/** Pure catalog computation shared by every projection. All parties to a conflict are hidden. */
export const catalog = (offers: ReadonlyArray<Catalog.Offer>) => {
	const counts = Array.reduce(
		offers,
		HashMap.empty<string, number>(),
		(counts, offer) =>
			Array.reduce(offer.kind.identities(offer.item), counts, (counts, id) =>
				HashMap.modifyAt(counts, offer.kind.list + ":" + id, (n) =>
					Option.some(Option.getOrElse(n, () => 0) + 1),
				),
			),
	)
	const conflicts = Array.flatMap(lists, (list) => {
		const identities = Array.dedupe(
			Array.flatMap(
				Array.filter(offers, (offer) => offer.kind.list === list),
				(offer: Catalog.Offer) =>
					Array.filter(
						offer.kind.identities(offer.item),
						(id) =>
							Option.getOrElse(HashMap.get(counts, list + ":" + id), () => 0) >
							1,
					),
			),
		)
		return identities.length === 0
			? []
			: [Catalog.Conflict.make({ list, identities })]
	})
	return {
		conflicts,
		offers: Array.filter(
			offers,
			(offer) =>
				!Array.some(
					conflicts,
					(conflict) =>
						conflict.list === offer.kind.list &&
						Array.some(offer.kind.identities(offer.item), (id) =>
							conflict.identities.includes(id),
						),
				),
		),
	}
}

interface Installed {
	readonly offer: Catalog.Offer
	readonly flag: ReturnType<typeof Liveness.make>
}

const sentinels = Effect.gen(function* () {
	const server = yield* McpServer.McpServer
	const annotations = Context.make(McpSchema.EnabledWhen, () => false)
	yield* server.addTool({
		tool: McpSchema.Tool.make({ name: "", inputSchema: { type: "object" } }),
		annotations,
		handle: () =>
			Effect.succeed(McpSchema.CallToolResult.make({ content: [] })),
	})
	yield* server.addResource({
		resource: McpSchema.Resource.make({ uri: "", name: "" }),
		annotations,
		handle: Effect.succeed({ contents: [] }),
	})
	yield* server.addPrompt({
		prompt: McpSchema.Prompt.make({ name: "" }),
		annotations,
		completions: {},
		handle: () =>
			Effect.succeed(McpSchema.GetPromptResult.make({ messages: [] })),
	})
})

export const projection = (
	extensions: Record<string, unknown>,
): Layer.Layer<never, never, McpServer.McpServer | Graft.Graft> =>
	Layer.unwrap(
		Effect.gen(function* () {
			const server = yield* McpServer.McpServer
			const base = yield* Effect.context<McpServer.McpServer | Graft.Graft>()
			const installed = yield* Ref.make<ReadonlyArray<Installed>>([])
			const failed = yield* Ref.make<ReadonlyArray<Catalog.Offer>>([])
			const warned = yield* Ref.make(false)
			const conflicts = yield* Ref.make(HashSet.empty<string>())
			const extensionStates = yield* Ref.make<ReadonlyArray<unknown>>([])
			const workers = yield* FiberSet.make<void>()
			yield* sentinels

			const notify = (list: List) =>
				list === "tools"
					? server.notifications["notifications/tools/list_changed"]({})
					: list === "prompts"
						? server.notifications["notifications/prompts/list_changed"]({})
						: server.notifications["notifications/resources/list_changed"]({})

			const sync = Effect.gen(function* () {
				const outcomes = yield* Event.settle(Catalog.Offered)
				for (const outcome of outcomes) {
					if (
						Exit.isFailure(outcome) &&
						!Cause.hasInterruptsOnly(outcome.cause)
					)
						yield* Effect.logError("An MCP catalog offer failed", outcome.cause)
				}
				const offered = Array.flatMap(outcomes, (exit) =>
					Exit.isSuccess(exit) ? exit.value : [],
				)
				const next = catalog(offered)
				const previousConflicts = yield* Ref.get(conflicts)
				const conflictKey = (conflict: Catalog.Conflict) =>
					conflict.list +
					Array.join(
						Array.map(conflict.identities, (id) => id.length + ":" + id),
						"",
					)
				for (const conflict of next.conflicts) {
					if (!HashSet.has(previousConflicts, conflictKey(conflict)))
						yield* Effect.logWarning(conflict)
				}
				yield* Ref.set(
					conflicts,
					HashSet.fromIterable(Array.map(next.conflicts, conflictKey)),
				)
				const previous = yield* Ref.get(installed)
				const sameOffer = (a: Catalog.Offer, b: Catalog.Offer) =>
					a.kind === b.kind && a.item === b.item
				const previousFailures = yield* Ref.get(failed)
				const failedOffers = Array.filter(previousFailures, (offer) =>
					Array.some(offered, (item) => sameOffer(offer, item)),
				)
				const kept = Array.filter(previous, ({ offer }) =>
					Array.some(next.offers, (item) => sameOffer(offer, item)),
				)
				const additions = yield* Ref.make<ReadonlyArray<Installed>>([])
				const failures = yield* Ref.make<ReadonlyArray<Catalog.Offer>>([])
				for (const offer of next.offers) {
					if (
						Array.some(kept, (item) => sameOffer(item.offer, offer)) ||
						Array.some(failedOffers, (item) => sameOffer(item, offer))
					)
						continue
					const flag = Liveness.make()
					const exit = yield* Effect.exit(
						// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- kinds erase their error type; the whole cause is logged below
						offer.kind.install(offer.item, flag.annotations),
					)
					if (Exit.isFailure(exit)) {
						yield* Ref.update(failures, (items) => [...items, offer])
						if (!Cause.hasInterruptsOnly(exit.cause))
							yield* Effect.logError(
								"Installing an MCP catalog item failed",
								offer.kind.key,
								exit.cause,
							)
					} else
						yield* Ref.update(additions, (items) => [...items, { offer, flag }])
				}
				const added = yield* Ref.get(additions)
				const rejected = yield* Ref.get(failures)
				const current = [...kept, ...added]
				// No contributor code runs during the atomic publication of a catalog generation.
				const changed = yield* Effect.uninterruptible(
					Effect.gen(function* () {
						for (const item of previous) {
							if (!kept.includes(item)) MutableRef.set(item.flag.live, false)
						}
						for (const item of added) MutableRef.set(item.flag.live, true)
						yield* Ref.set(installed, current)
						yield* Ref.set(failed, [...failedOffers, ...rejected])
						return Array.filter(lists, (list) => {
							const before = Array.filter(
								previous,
								(item) => item.offer.kind.list === list,
							)
							const after = Array.filter(
								current,
								(item) => item.offer.kind.list === list,
							)
							return (
								before.length !== after.length ||
								Array.some(before, (item) => !after.includes(item))
							)
						})
					}),
				)
				// Resource templates share the resources notification in MCP.
				for (const list of HashSet.fromIterable(
					Array.map(changed, (list) =>
						list === "resourceTemplates" ? "resources" : list,
					),
				))
					yield* notify(list)
				const currentExtensions = yield* snapshot
				const priorStates = yield* Ref.get(extensionStates)
				const states = [
					...currentExtensions.conflicts,
					...Array.map(currentExtensions.failures, Cause.pretty),
				]
				for (const conflict of currentExtensions.conflicts) {
					if (!Array.some(priorStates, (state) => same(state, conflict)))
						yield* Effect.logWarning(
							Extensions.Conflict.make({ key: conflict.key }),
						)
				}
				for (const failure of currentExtensions.failures) {
					if (
						!Array.some(priorStates, (state) =>
							same(state, Cause.pretty(failure)),
						)
					)
						yield* Effect.logError("An extension declaration failed", failure)
				}
				yield* Ref.set(extensionStates, states)
				if (
					!(yield* Ref.get(warned)) &&
					!same(extensions, currentExtensions.values)
				) {
					yield* Ref.set(warned, true)
					yield* Effect.logWarning(
						"MCP extensions changed; they apply at this transport's next restart",
					)
				}
			}).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logError("Synchronizing the MCP catalog failed", cause),
				),
			)

			// One projection-owned worker drains coalesced generations. Callers only own their wait.
			const scheduling = yield* Ref.make<{
				readonly pending: Deferred.Deferred<void> | undefined
				readonly running: boolean
				readonly closed: boolean
			}>({ pending: undefined, running: false, closed: false })
			const drain = Effect.uninterruptible(
				Effect.gen(function* () {
					while (true) {
						// Claiming a batch and installing its completion finalizer cannot be interrupted.
						const batch = yield* Ref.modify(scheduling, (state) => [
							state.pending,
							{
								...state,
								pending: undefined,
								running: state.pending !== undefined,
							},
						])
						if (batch === undefined) return
						// Contributor code remains interruptible by the projection's scope.
						yield* Effect.interruptible(sync).pipe(
							Effect.ensuring(Deferred.succeed(batch, undefined)),
						)
					}
				}),
			).pipe(
				Event.within(synchronizing),
				// A worker belongs to the projection, never to the first emitter's dispatch chain.
				Effect.updateContext((_: Context.Context<never>) => base),
			)
			const requestSync = Effect.uninterruptible(
				Effect.gen(function* () {
					const requested = yield* Deferred.make<void>()
					const accepted = yield* Ref.modify(scheduling, (state) => {
						if (state.closed) return [undefined, state]
						const batch = state.pending ?? requested
						return [
							{ batch, start: !state.running },
							{ ...state, pending: batch, running: true },
						]
					})
					if (accepted === undefined) return
					if (accepted.start) yield* FiberSet.run(workers, drain)
					// Re-entrant dispatches enqueue another pass; waiting here would wait on themselves.
					if (!(yield* Event.isWithin(synchronizing)))
						yield* Effect.interruptible(Deferred.await(accepted.batch))
				}),
			)
			yield* Event.on(Catalog.Changed, () => requestSync)
			yield* Event.on(Updated, (uri) =>
				server.notifications["notifications/resources/updated"]({ uri }),
			)
			// Reject new work before interrupting the worker or releasing Changed handlers.
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const pending = yield* Ref.modify(scheduling, (state) => [
						state.pending,
						{ ...state, closed: true, pending: undefined },
					])
					if (pending !== undefined) yield* Deferred.succeed(pending, undefined)
					yield* FiberSet.clear(workers)
					yield* Ref.update(scheduling, (state) => ({
						...state,
						running: false,
					}))
				}),
			)
			yield* requestSync

			const middleware = McpServer.middleware(
				(effect, options) =>
					Effect.gen(function* () {
						const request = yield* Effect.context<never>()
						const services = Context.add(request, Base, base)
						return yield* Event.waterfall(
							Middleware.Middleware,
							{ ...options, services },
							(call) => effect.pipe(Effect.provide(call.services)),
						).pipe(Effect.provide(base))
					}),
				{ global: true },
			)
			const visible = McpServer.visibility(
				(options) =>
					Effect.gen(function* () {
						// Effect retains completion entries; only the live registration owning this reference and argument may run.
						if (options.method === "completion/complete") {
							// McpServer's public middleware receives the normalized completion request
							// (McpServer.ts addPrompt/addResourceTemplate), not the wire Complete payload.
							const payload = options.payload as {
								readonly reference: { readonly type: "prompt" | "resource" }
								readonly argument: (typeof McpSchema.Complete.payloadSchema.Type)["argument"]
							}
							const list =
								payload.reference.type === "prompt"
									? "prompts"
									: "resourceTemplates"
							const live = yield* Ref.get(installed)
							if (
								!Array.some(
									live,
									({ offer, flag }) =>
										MutableRef.get(flag.live) &&
										offer.kind.list === list &&
										offer.kind
											.identities(offer.item)
											.includes(options.target) &&
										(offer.kind
											.completions?.(offer.item)
											.includes(payload.argument.name) ??
											false),
								)
							)
								return false
						}
						const services = yield* Effect.context<never>()
						const results = yield* Event.parallel(Middleware.Visible, {
							...options,
							services,
						}).pipe(Effect.provide(base))
						return Array.every(results, Boolean)
					}),
				{ global: true },
			)
			// Visibility is outermost: list checks never enter the Graft middleware waterfall.
			return visible.pipe(Layer.provideMerge(middleware))
		}),
	)
