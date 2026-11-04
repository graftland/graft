/**
 * Typed events. Handlers are registered for the lifetime of the current
 * scope and run with the registration context and a fresh invocation scope.
 */
import { identity } from "effect/Function"
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
import { Graft } from "./Graft"
import { Realms, realmOf, type Handler } from "./internal/runtime"

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

const register = <Args extends ReadonlyArray<unknown>, Out, E, R>(
	event: Event<Args, Out, E>,
	handler: (
		...args: NoInfer<Args>
	) => Effect.Effect<NoInfer<Out>, NoInfer<E>, R>,
	options: HandlerOptions & { readonly once: boolean },
): Effect.Effect<void, never, Graft | Scope.Scope | R> =>
	Effect.gen(function* () {
		const { runtime } = yield* Graft
		const realms = yield* Realms
		const context = yield* Effect.context<R>()
		const owner = yield* Effect.scope
		const scope = yield* Scope.fork(owner)
		const closing = yield* Deferred.make<number>()
		const fibers = yield* FiberSet.make<Out, E>().pipe(Scope.provide(scope))
		// This finalizer runs before FiberSet interrupts the group's invocations.
		yield* Scope.addFinalizer(
			scope,
			Effect.withFiber((fiber) => Deferred.succeed(closing, fiber.id)),
		)
		const entry: Handler<Args, Out, E> = {
			realm: realmOf(realms, event.key),
			global: options.global === true,
			once: options.once,
			context,
			fibers,
			scope,
			closing,
			run: (args, invocationScope) =>
				Effect.updateContext(
					// Restore services first; the invocation then supplies its own Scope.
					Scope.provide(invocationScope)(
						Effect.suspend(() => handler(...args)),
					),
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
			() => update(Array.filter((handler) => handler !== entry)),
		).pipe(Scope.provide(scope))
	}).pipe(Effect.uninterruptible)

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
const handlersFor = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
) =>
	Effect.gen(function* () {
		const { runtime } = yield* Graft
		const realms = yield* Realms
		const filter = yield* Filter
		const realm = realmOf(realms, event.key)
		const events = yield* TxRef.get(runtime.events)
		const handlers = Option.getOrElse(
			HashMap.get(events, event.key),
			() => [],
		) as ReadonlyArray<Handler<Args, Out, E>>
		return Array.filter(
			handlers,
			(handler) =>
				handler.global || (handler.realm === realm && filter(handler.context)),
		)
	})

// The owner waits for both execution and release; cancellation cleanup observes release independently.
const runInvocation = <Args extends ReadonlyArray<unknown>, Out, E>(
	handler: Handler<Args, Out, E>,
	args: Args,
	released: Ref.Ref<Cause.Cause<never>>,
) =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			// Nested scopes and ensuring belong to the body; only this invocation Scope has a separately observed release.
			const body = yield* Effect.exit(restore(handler.run(args, scope)))
			const closed = yield* Effect.exit(Scope.close(scope, body))
			yield* Ref.set(
				released,
				Exit.isFailure(closed) ? closed.cause : Cause.empty,
			)
			if (Exit.isFailure(closed))
				return yield* Effect.failCause(
					Exit.isFailure(body)
						? Cause.combine(body.cause, closed.cause)
						: closed.cause,
				)
			return yield* body
		}),
	)

// Bare body cancellation is quiet during teardown; the invocation Scope's release is never filtered.
const cancellationCause = <A, E>(
	exit: Exit.Exit<A, E>,
	released: Ref.Ref<Cause.Cause<never>>,
) =>
	Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
		? Effect.succeed(exit.cause)
		: Ref.get(released)

/**
 * Runs one handler in its owner's fiber set. Resolves to `None` if the
 * handler was unregistered before it could run, or its owner was torn down
 * while it ran.
 */
const invoke = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
	handler: Handler<Args, Out, E>,
	args: Args,
	releaseResult?: Ref.Ref<Cause.Cause<never>>,
): Effect.Effect<Option.Option<Out>, E, Graft> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const { runtime } = yield* Graft
			const claimed = yield* Effect.tx(
				Effect.gen(function* () {
					const events = yield* TxRef.get(runtime.events)
					const handlers = Option.getOrElse(
						HashMap.get(events, event.key),
						() => [],
					)
					if (!Array.some(handlers, (current) => current === handler))
						return false
					if (handler.once) {
						yield* TxRef.set(
							runtime.events,
							setHandlers(
								events,
								event.key,
								Array.filter(handlers, (other) => other !== handler),
							),
						)
					}
					return true
				}),
			)
			if (!claimed) return Option.none()
			return yield* Effect.gen(function* () {
				const released =
					releaseResult ?? (yield* Ref.make<Cause.Cause<never>>(Cause.empty))
				// Starting the handler and installing its cancellation cleanup are atomic.
				const started = yield* Deferred.make<void>()
				const fiber = yield* FiberSet.run(
					handler.fibers,
					Effect.uninterruptible(
						Effect.withFiber((self) =>
							// FiberSet.run registers after starting; register here before any user code.
							// This is the invocation fiber whose result has the handler's exact bounds.
							FiberSet.add(handler.fibers, self as Fiber.Fiber<Out, E>),
						).pipe(
							Effect.andThen(Deferred.succeed(started, undefined)),
							Effect.andThen(restore(runInvocation(handler, args, released))),
						),
					),
					{ startImmediately: true },
				)
				const exit = yield* Effect.onInterrupt(
					restore(Fiber.await(fiber)),
					() =>
						Effect.gen(function* () {
							yield* Fiber.interrupt(fiber)
							const stopped = yield* Fiber.await(fiber)
							const cause = yield* cancellationCause(stopped, released)
							if (cause.reasons.length > 0)
								return yield* Effect.failCause(cause)
						}),
				)
				if (exit._tag === "Success") return Option.some(exit.value)
				if (
					Cause.hasInterruptsOnly(exit.cause) &&
					(yield* Deferred.isDone(handler.closing))
				) {
					const ran = yield* Deferred.isDone(started)
					// A closed FiberSet can refuse to start the invocation.
					if (!ran) return Option.none()
					const closer = yield* Deferred.await(handler.closing)
					const releaseCause = yield* Ref.get(released)
					// Without dispatcher cancellation, only the owner's interruption permits skipping a handler.
					if (
						releaseCause.reasons.length === 0 &&
						Array.every(
							exit.cause.reasons,
							(reason) =>
								reason._tag === "Interrupt" && reason.fiberId === closer,
						)
					)
						return Option.none()
				}
				return yield* Effect.failCause(exit.cause)
			}).pipe(
				Effect.onExit((exit) =>
					handler.once ? Scope.close(handler.scope, exit) : Effect.void,
				),
			)
		}),
	)

/** Calls every handler in order and stops at the first failure. */
export const emit = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
	...args: Args
): Effect.Effect<void, E, Graft> =>
	Effect.flatMap(handlersFor(event), (handlers) =>
		Effect.forEach(handlers, (handler) => invoke(event, handler, args), {
			discard: true,
		}),
	)

/** Calls every handler concurrently. All failures are combined into one cause. */
export const parallel = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
	...args: Args
): Effect.Effect<ReadonlyArray<Out>, E, Graft> =>
	Effect.gen(function* () {
		const handlers = yield* handlersFor(event)
		return yield* Effect.acquireUseRelease(
			Effect.forEach(handlers, (handler) =>
				Effect.gen(function* () {
					const released = yield* Ref.make<Cause.Cause<never>>(Cause.empty)
					const fiber = yield* Effect.forkScoped(
						invoke(event, handler, args, released),
					)
					return { fiber, released }
				}),
			),
			(fibers) =>
				Effect.forEach(fibers, ({ fiber }) => Fiber.await(fiber)).pipe(
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
					// Join every invocation before reading its release result, even when dispatch was cancelled.
					yield* Fiber.interruptAll(Array.map(fibers, ({ fiber }) => fiber))
					const causes = yield* Effect.forEach(fibers, ({ fiber, released }) =>
						Effect.gen(function* () {
							const exit = yield* Fiber.await(fiber)
							return Exit.isFailure(used)
								? yield* cancellationCause(exit, released)
								: Exit.isFailure(exit)
									? exit.cause
									: Cause.empty
						}),
					)
					const empty: Cause.Cause<E> = Cause.empty
					const cause = Array.reduce(causes, empty, (cause, next) =>
						Cause.combine(cause, next),
					)
					if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
				}),
		)
	}).pipe(Effect.scoped)

/** Calls handlers in order until one returns `Some`. */
export const bail = <Args extends ReadonlyArray<unknown>, A, E>(
	event: Event<Args, Option.Option<A>, E>,
	...args: Args
): Effect.Effect<Option.Option<A>, E, Graft> =>
	Effect.gen(function* () {
		const handlers = yield* handlersFor(event)
		for (const handler of handlers) {
			const result = yield* invoke(event, handler, args)
			if (Option.isSome(result) && Option.isSome(result.value))
				return result.value
		}
		return Option.none()
	})

/** Shares the first execution, including its failure or interruption, with all callers. */
const shareNext = <I, O, E>(run: Next<I, O, E>) =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const result = yield* Deferred.make<O, E>()
		return (input: I): Effect.Effect<O, E> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (yield* Deferred.succeed(started, undefined)) {
						yield* Deferred.complete(
							result,
							restore(Effect.suspend(() => run(input))),
						)
						// Completion guarantees this cannot suspend. Observe its full
						// Cause before a pending interrupt can replace it.
						return yield* Deferred.await(result)
					}
					return yield* restore(Deferred.await(result))
				}),
			)
	})

/**
 * Passes `input` through every handler as middleware, ending with `last`.
 * Handlers use their registration context; `last` uses the dispatch context.
 * Each invocation, including `last`, owns a scope that closes after its cleanup.
 * Other services required by `last` remain requirements of the dispatch effect.
 * Each handler's `next` runs the downstream chain once. The first execution
 * selects its input; later executions share the same success, failure, or
 * interruption. Cancelling that first execution does not retry downstream.
 */
export const waterfall = <I, O, E, R>(
	event: Middleware<I, O, E>,
	input: I,
	last: (input: I) => Effect.Effect<O, E, R>,
): Effect.Effect<O, E, Graft | Exclude<R, Scope.Scope>> =>
	Effect.gen(function* () {
		const handlers = yield* handlersFor(event)
		const context = yield* Effect.context<Graft | Exclude<R, Scope.Scope>>()
		const step = (index: number, input: I): Effect.Effect<O, E> =>
			Effect.gen(function* () {
				const handler = handlers[index]
				if (handler === undefined)
					return yield* Effect.suspend(() => last(input)).pipe(
						Effect.scoped,
						Effect.updateContext<never, Exclude<R, Scope.Scope>>(() => context),
					)
				const next = yield* shareNext((input: I) => step(index + 1, input))
				const result = yield* invoke(event, handler, [input, next]).pipe(
					Effect.updateContext<never, Graft>(() => context),
				)
				return Option.isSome(result) ? result.value : yield* next(input)
			})
		return yield* step(0, input)
	})
