/**
 * Typed events. Handlers are registered for the lifetime of the current
 * scope and run with the context of the code that registered them.
 */
import type { Scope } from "effect"
import { identity } from "effect/Function"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	HashMap,
	Option,
	TxRef,
} from "effect"
import { Graft } from "./Graft"
import { Realms, realmOf, type Handler } from "./internal/runtime"

const TypeId = "~@nmnmcc/graft/Event"

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
	"@nmnmcc/graft/Event/Filter",
	{
		defaultValue: () => () => true,
	},
)

export const filtered =
	(filter: (owner: Context.Context<never>) => boolean) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.provideService(effect, Filter, filter)

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
		const fibers = yield* FiberSet.make<Out, E>()
		const entry: Handler<Args, Out, E> = {
			realm: realmOf(realms, event.key),
			global: options.global === true,
			once: options.once,
			context,
			fibers,
			run: (args) => Effect.provideContext(handler(...args), context),
		}
		const update = (
			f: (handlers: ReadonlyArray<Handler>) => ReadonlyArray<Handler>,
		) =>
			TxRef.update(runtime.events, (events) =>
				HashMap.set(
					events,
					event.key,
					f(Option.getOrElse(HashMap.get(events, event.key), () => [])),
				),
			)
		yield* update((handlers) =>
			options.prepend === true
				? Arr.prepend(handlers, entry)
				: Arr.append(handlers, entry),
		)
		yield* Effect.addFinalizer(() =>
			update(Arr.filter((handler) => handler !== entry)),
		)
	})

/** Registers a handler until the current scope closes. */
export const on = <Args extends ReadonlyArray<unknown>, Out, E, R>(
	event: Event<Args, Out, E>,
	handler: (
		...args: NoInfer<Args>
	) => Effect.Effect<NoInfer<Out>, NoInfer<E>, R>,
	options: HandlerOptions = {},
): Effect.Effect<void, never, Graft | Scope.Scope | R> =>
	register(event, handler, { ...options, once: false })

/** Registers a handler that runs at most once, even if it dispatches the event again. */
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
		return Arr.filter(
			handlers,
			(handler) =>
				handler.global || (handler.realm === realm && filter(handler.context)),
		)
	})

/**
 * Runs one handler in its owner's fiber set. Resolves to `None` if the
 * handler was unregistered before it could run, or its owner was torn down
 * while it ran.
 */
const invoke = <Args extends ReadonlyArray<unknown>, Out, E>(
	event: Event<Args, Out, E>,
	handler: Handler<Args, Out, E>,
	args: Args,
): Effect.Effect<Option.Option<Out>, E, Graft> =>
	Effect.gen(function* () {
		const { runtime } = yield* Graft
		const claimed = yield* Effect.tx(
			Effect.gen(function* () {
				const events = yield* TxRef.get(runtime.events)
				const handlers = Option.getOrElse(
					HashMap.get(events, event.key),
					() => [],
				)
				if (!Arr.contains(handlers, handler)) return false
				if (handler.once) {
					yield* TxRef.set(
						runtime.events,
						HashMap.set(
							events,
							event.key,
							Arr.filter(handlers, (other) => other !== handler),
						),
					)
				}
				return true
			}),
		)
		if (!claimed) return Option.none()
		const fiber = yield* FiberSet.run(handler.fibers, handler.run(args))
		const exit = yield* Effect.onInterrupt(Fiber.await(fiber), () =>
			Fiber.interrupt(fiber),
		)
		if (exit._tag === "Success") return Option.some(exit.value)
		if (Cause.hasInterruptsOnly(exit.cause)) return Option.none()
		return yield* Effect.failCause(exit.cause)
	})

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
		const exits = yield* Effect.forEach(
			handlers,
			(handler) => Effect.exit(invoke(event, handler, args)),
			{
				concurrency: "unbounded",
			},
		)
		const failures = Arr.map(
			Arr.filter(exits, Exit.isFailure),
			(exit) => exit.cause,
		)
		if (Arr.isArrayNonEmpty(failures))
			return yield* Effect.failCause(
				Arr.reduce(failures, Cause.empty as Cause.Cause<E>, (all, cause) =>
					Cause.combine(all, cause),
				),
			)
		return Arr.getSomes(
			Arr.map(Arr.filter(exits, Exit.isSuccess), (exit) => exit.value),
		)
	})

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

/**
 * Passes `input` through every handler as middleware, ending with `last`.
 * Each handler may call `next` at most once.
 */
export const waterfall = <I, O, E>(
	event: Middleware<I, O, E>,
	input: I,
	last: Next<I, O, E>,
): Effect.Effect<O, E, Graft> =>
	Effect.gen(function* () {
		const handlers = yield* handlersFor(event)
		const context = yield* Effect.context<Graft>()
		const step = (index: number): Next<I, O, E> => {
			let called = false
			return (input) =>
				Effect.suspend(() => {
					if (called)
						return Effect.die(
							new Error(`next() was called twice in "${event.key}"`),
						)
					called = true
					const handler = handlers[index]
					if (handler === undefined) return last(input)
					return invoke(event, handler, [input, step(index + 1)]).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => step(index + 1)(input),
								onSome: Effect.succeed,
							}),
						),
						Effect.provideContext(context),
					)
				})
		}
		return yield* step(0)(input)
	})
