/**
 * Typed events. Handlers are registered for the lifetime of the current
 * scope and run with the registration context and a fresh invocation scope.
 */
import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	HashMap,
	Option,
	Ref,
	Scope,
	TxRef,
} from "effect"
import { identity } from "effect/Function"

import { Graft } from "./Graft"
import { realmOf, Realms, type Handler } from "./internal/runtime"
import { RuntimeContext } from "./internal/runtimeContext"
import * as Release from "./Release"

const TypeId = "~@graftland/graft/Event"

export interface Event<
	in out Args extends ReadonlyArray<unknown>,
	in out Out = void,
	in out E = never,
> {
	readonly [TypeId]: {
		readonly Args: (_: Args) => Args
		readonly Out: (_: Out) => Out
		readonly E: (_: E) => E
	}
	readonly key: string
}

/** Continues a middleware chain with the next handler. */
export type Next<I, O, E = never> = (input: I) => Effect.Effect<O, E>

/** An event dispatched with `waterfall`: each handler may transform the input or short-circuit. */
export type Middleware<I, O, E = never> = Event<
	[input: I, next: Next<I, O, E>],
	O,
	E
>

const variance = { Args: identity, Out: identity, E: identity }

export const make = <
	Args extends ReadonlyArray<unknown>,
	Out = void,
	E = never,
>(
	key: string,
): Event<Args, Out, E> => ({ [TypeId]: variance, key })

export const middleware = <I, O, E = never>(key: string): Middleware<I, O, E> =>
	make(key)

export interface HandlerOptions {
	/** Runs before handlers registered earlier. */
	readonly prepend?: boolean | undefined
	/** Receives dispatches from every realm, bypassing isolation and filters. */
	readonly global?: boolean | undefined
}

/**
 * Narrows which handlers a dispatch reaches. The filter sees the context the
 * handler was registered in, so it can read any service or reference there.
 */
const Filter = Context.Reference<(owner: Context.Context<never>) => boolean>(
	"@graftland/graft/Event/Filter",
	{
		defaultValue: () => () => true,
	},
)

export const filtered =
	(filter: (owner: Context.Context<never>) => boolean) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.provideService(effect, Filter, filter)

const setHandlers = (
	events: HashMap.HashMap<string, ReadonlyArray<Handler>>,
	key: string,
	handlers: ReadonlyArray<Handler>,
) =>
	handlers.length === 0
		? HashMap.remove(events, key)
		: HashMap.set(events, key, handlers)

const register = Effect.fnUntraced(function* <
	Args extends ReadonlyArray<unknown>,
	Out,
	E,
	R,
>(
	event: Event<Args, Out, E>,
	handler: (
		...args: NoInfer<Args>
	) => Effect.Effect<NoInfer<Out>, NoInfer<E>, R>,
	options: HandlerOptions & { readonly once: boolean },
): Effect.fn.Return<void, never, Graft | Scope.Scope | R> {
	const { runtime } = yield* RuntimeContext
	const realms = yield* Realms
	const context = yield* Effect.context<R>()
	const owner = yield* Effect.scope
	const scope = yield* Scope.fork(owner)
	const closing = yield* Deferred.make<number>()
	const active = yield* Ref.make(true)
	const fibers = yield* FiberSet.make<Out, E>().pipe(Scope.provide(scope))
	// This finalizer runs before FiberSet interrupts the group's invocations.
	yield* Scope.addFinalizer(
		scope,
		Effect.withFiber((fiber) => Deferred.succeed(closing, fiber.id)),
	)
	// A once handler leaves the map in the same transaction that claims it, so
	// re-entrant and concurrent dispatches never see it again. Other handlers
	// only read a flag; unregistration clears it before leaving the map.
	const claimOnce: Effect.Effect<boolean> = Effect.tx(
		Effect.flatMap(TxRef.get(runtime.events), (events) => {
			const handlers = Option.getOrElse(
				HashMap.get(events, event.key),
				() => [],
			)
			return Array.some(handlers, (current) => current === entry)
				? Effect.as(
						TxRef.set(
							runtime.events,
							setHandlers(
								events,
								event.key,
								Array.filter(handlers, (other) => other !== entry),
							),
						),
						true,
					)
				: Effect.succeed(false)
		}),
	)
	const entry: Handler<Args, Out, E> = {
		realm: realmOf(realms, event.key),
		global: options.global === true,
		once: options.once,
		context,
		fibers,
		scope,
		closing,
		claim: options.once ? claimOnce : Ref.get(active),
		run: (args) =>
			Effect.updateContext(
				// Restore services first; the invocation then supplies its own Scope.
				Release.scoped(Effect.suspend(() => handler(...args))),
				(_: Context.Context<never>) => context,
			),
	}
	const update = (
		f: (handlers: ReadonlyArray<Handler>) => ReadonlyArray<Handler>,
	) =>
		TxRef.update(runtime.events, (events) =>
			setHandlers(
				events,
				event.key,
				f(Option.getOrElse(HashMap.get(events, event.key), () => [])),
			),
		)
	yield* Effect.acquireRelease(
		update((handlers) =>
			options.prepend === true
				? Array.prepend(handlers, entry)
				: Array.append(handlers, entry),
		),
		// Deactivating first means no dispatch can claim a handler that is leaving.
		() =>
			Effect.andThen(
				Ref.set(active, false),
				update(Array.filter((handler) => handler !== entry)),
			),
	).pipe(Scope.provide(scope))
}, Effect.uninterruptible)

/** Registers a handler until the current scope closes. */
export const on = <Args extends ReadonlyArray<unknown>, Out, E, R>(
	event: Event<Args, Out, E>,
	handler: (
		...args: NoInfer<Args>
	) => Effect.Effect<NoInfer<Out>, NoInfer<E>, R>,
	options: HandlerOptions = {},
): Effect.Effect<void, never, Graft | Scope.Scope | R> =>
	register(event, handler, { ...options, once: false })

/**
 * Registers a handler that runs at most once, even if it dispatches the event again.
 * Its registration detaches from the owner after execution and cancellation cleanup.
 */
export const once = <Args extends ReadonlyArray<unknown>, Out, E, R>(
	event: Event<Args, Out, E>,
	handler: (
		...args: NoInfer<Args>
	) => Effect.Effect<NoInfer<Out>, NoInfer<E>, R>,
	options: HandlerOptions = {},
): Effect.Effect<void, never, Graft | Scope.Scope | R> =>
	register(event, handler, { ...options, once: true })

/** The handlers a dispatch from the current context reaches, in order. */
// Runs once per dispatch; combinators avoid a generator on this path.
const handlersFor = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
): Effect.Effect<ReadonlyArray<Handler<Args, Out, E>>, never, Graft> =>
	Effect.flatMap(RuntimeContext, ({ runtime }) =>
		Effect.flatMap(Realms, (realms) =>
			Effect.flatMap(Filter, (filter) =>
				Effect.map(TxRef.get(runtime.events), (events) => {
					const realm = realmOf(realms, event.key)
					const handlers = Option.getOrElse(
						HashMap.get(events, event.key),
						() => [],
					) as ReadonlyArray<Handler<Args, Out, E>>
					return Array.filter(
						handlers,
						(handler) =>
							handler.global ||
							(handler.realm === realm && filter(handler.context)),
					)
				}),
			),
		),
	)

const skipped = Effect.succeedNone

/**
 * Settles an invocation that did not succeed. Only interruption by the owner's
 * teardown skips the handler; every other cause, including a release failure, propagates.
 */
const settle = Effect.fnUntraced(function* <Out, E>(
	handler: Handler<never, Out, E>,
	started: Deferred.Deferred<void>,
	cause: Cause.Cause<E>,
) {
	if (
		Cause.hasInterruptsOnly(cause) &&
		(yield* Deferred.isDone(handler.closing))
	) {
		const ran = yield* Deferred.isDone(started)
		// A closed FiberSet can refuse to start the invocation.
		if (!ran) return Option.none<Out>()
		const closer = yield* Deferred.await(handler.closing)
		// Without dispatcher cancellation, only the owner's interruption permits skipping a handler.
		if (
			Array.every(
				cause.reasons,
				(reason) => reason._tag === "Interrupt" && reason.fiberId === closer,
			)
		)
			return Option.none<Out>()
	}
	return yield* Effect.failCause(cause)
})

/** Interrupts a cancelled invocation and waits for it; release interruptions are defects, bare body cancellation is quiet. */
const cancel = <Out, E>(fiber: Fiber.Fiber<Out, E>) =>
	Effect.andThen(
		Fiber.interrupt(fiber),
		Effect.flatMap(Fiber.await(fiber), (stopped) =>
			Exit.isFailure(stopped) && !Cause.hasInterruptsOnly(stopped.cause)
				? Effect.failCause(stopped.cause)
				: Effect.void,
		),
	)

/**
 * Runs one handler in its owner's fiber set. Resolves to `None` if the
 * handler was unregistered before it could run, or its owner was torn down
 * while it ran.
 */
// Runs once per handler per dispatch: the success path chains combinators instead of generators.
const invoke = <Args extends ReadonlyArray<unknown>, Out, E>(
	handler: Handler<Args, Out, E>,
	args: Args,
): Effect.Effect<Option.Option<Out>, E> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.flatMap(handler.claim, (claimed) => {
			if (!claimed) return skipped
			const run = Effect.flatMap(Deferred.make<void>(), (started) =>
				Effect.flatMap(
					// Starting the handler and installing its cancellation cleanup are atomic.
					FiberSet.run(
						handler.fibers,
						Effect.uninterruptible(
							Effect.withFiber((self) =>
								// FiberSet.run registers after starting; register here before any user code.
								// This is the invocation fiber whose result has the handler's exact bounds.
								FiberSet.add(handler.fibers, self as Fiber.Fiber<Out, E>),
							).pipe(
								Effect.andThen(Deferred.succeed(started, undefined)),
								Effect.andThen(
									restore(Effect.suspend(() => handler.run(args))),
								),
							),
						),
						{ startImmediately: true },
					),
					(fiber) =>
						Effect.flatMap(
							Effect.onInterrupt(restore(Fiber.await(fiber)), () =>
								cancel(fiber),
							),
							(exit) =>
								Exit.isSuccess(exit)
									? Effect.succeedSome(exit.value)
									: settle(handler, started, exit.cause),
						),
				),
			)
			return handler.once
				? Effect.onExit(run, (exit) => Release.close(handler.scope, exit))
				: run
		}),
	)

/** Calls every handler in order and stops at the first failure. */
export const emit = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
	...args: Args
): Effect.Effect<void, E, Graft> =>
	Effect.flatMap(handlersFor(event), (handlers) =>
		Effect.forEach(handlers, (handler) => invoke(handler, args), {
			discard: true,
		}),
	)

/** Calls every handler concurrently. All failures are combined into one cause. */
export const parallel = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
	...args: Args
): Effect.Effect<ReadonlyArray<Out>, E, Graft> => dispatchParallel(event, args)

// fnUntraced cannot carry a readonly variadic tuple, so the public entry point collects the arguments.
const dispatchParallel = Effect.fnUntraced(function* <
	Args extends ReadonlyArray<unknown>,
	Out,
	E,
>(event: Event<Args, Out, E>, args: Args) {
	const handlers = yield* handlersFor(event)
	return yield* Effect.acquireUseRelease(
		Effect.forEach(handlers, (handler) =>
			Effect.forkScoped(invoke(handler, args)),
		),
		(fibers) =>
			Effect.forEach(fibers, Fiber.await).pipe(
				Effect.map((exits) =>
					Array.getSomes(
						Array.map(
							Array.filter(exits, Exit.isSuccess),
							(exit) => exit.value,
						),
					),
				),
			),
		(fibers, used) =>
			Effect.gen(function* () {
				// Wait for every invocation; marked release failures survive cancellation of this dispatch.
				yield* Fiber.interruptAll(fibers)
				const exits = yield* Effect.forEach(fibers, Fiber.await)
				const empty: Cause.Cause<E> = Cause.empty
				const cause = Array.reduce(exits, empty, (cause, exit) =>
					Exit.isFailure(exit) &&
					(Exit.isSuccess(used) || !Cause.hasInterruptsOnly(exit.cause))
						? Cause.combine(cause, exit.cause)
						: cause,
				)
				if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
			}),
	)
}, Release.scoped)

/** Calls handlers in order until one returns `Some`. */
export const bail = <Args extends ReadonlyArray<unknown>, A, E>(
	event: Event<Args, Option.Option<A>, E>,
	...args: Args
): Effect.Effect<Option.Option<A>, E, Graft> => dispatchBail(event, args)

const dispatchBail = Effect.fnUntraced(function* <
	Args extends ReadonlyArray<unknown>,
	A,
	E,
>(event: Event<Args, Option.Option<A>, E>, args: Args) {
	const handlers = yield* handlersFor(event)
	for (const handler of handlers) {
		const result = yield* invoke(handler, args)
		if (Option.isSome(result) && Option.isSome(result.value))
			return result.value
	}
	return Option.none<A>()
})

/** Shares the first execution, including its failure or interruption, with all callers. */
// Built per handler per waterfall dispatch, so it chains combinators instead of generators.
const shareNext = <I, O, E>(run: Next<I, O, E>): Effect.Effect<Next<I, O, E>> =>
	Effect.flatMap(Deferred.make<void>(), (started) =>
		Effect.map(
			Deferred.make<O, E>(),
			(result) =>
				(input: I): Effect.Effect<O, E> =>
					Effect.uninterruptibleMask((restore) =>
						Effect.flatMap(Deferred.succeed(started, undefined), (first) =>
							first
								? Effect.andThen(
										Deferred.complete(
											result,
											restore(Effect.suspend(() => run(input))),
										),
										// Completion guarantees this cannot suspend. Observe its full
										// Cause before a pending interrupt can replace it.
										Deferred.await(result),
									)
								: restore(Deferred.await(result)),
						),
					),
		),
	)

/**
 * Passes `input` through every handler as middleware, ending with `last`.
 * Handlers use their registration context; `last` uses the dispatch context.
 * Each invocation, including `last`, owns a scope that closes after its cleanup.
 * Other services required by `last` remain requirements of the dispatch effect.
 * Each handler's `next` runs the downstream chain once. The first execution
 * selects its input; later executions share the same success, failure, or
 * interruption. Cancelling that first execution does not retry downstream.
 */
export const waterfall: <I, O, E, R>(
	event: Middleware<I, O, E>,
	input: I,
	last: (input: I) => Effect.Effect<O, E, R>,
) => Effect.Effect<O, E, Graft | Exclude<R, Scope.Scope>> = Effect.fnUntraced(
	function* <I, O, E, R>(
		event: Middleware<I, O, E>,
		input: I,
		last: (input: I) => Effect.Effect<O, E, R>,
	) {
		const handlers = yield* handlersFor(event)
		const context = yield* Effect.context<Exclude<R, Scope.Scope>>()
		const step = (index: number, input: I): Effect.Effect<O, E> => {
			const handler = handlers[index]
			if (handler === undefined)
				return Effect.suspend(() => last(input)).pipe(
					Release.scoped,
					Effect.updateContext<never, Exclude<R, Scope.Scope>>(() => context),
				)
			return Effect.flatMap(
				shareNext((input: I) => step(index + 1, input)),
				(next) =>
					Effect.flatMap(invoke(handler, [input, next]), (result) =>
						Option.isSome(result) ? Effect.succeed(result.value) : next(input),
					),
			)
		}
		return yield* step(0, input)
	},
)
