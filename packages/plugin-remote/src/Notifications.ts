/**
 * Notifications between units as unary deliveries. A subscriber pulls each
 * notification with an ordinary contract call; its next call acknowledges the
 * previous one only after the subscriber's handler finished. Delivery is at
 * most once: a notification whose result is unknown is reported as `Lost`,
 * never sent again, and a full queue reports `Dropped` instead of growing.
 */
import {
	Clock,
	Duration,
	Effect,
	HashMap,
	Option,
	Ref,
	Schema,
	Semaphore,
	Stream,
	SubscriptionRef,
	type Context,
} from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { operation } from "./internal/operations"
import { service as contractService } from "./internal/services"

/** What one pull returns. `after` acknowledges every sequence number up to it. */
export type Delivery<A> =
	| { readonly _tag: "Delivered"; readonly seq: number; readonly payload: A }
	| { readonly _tag: "Lost"; readonly seq: number }
	| { readonly _tag: "Dropped"; readonly count: number }
	| { readonly _tag: "Idle" }
/** The emitter's side of a channel, published as a unary contract service. */
export interface Channel<A> {
	/** Opens a delivery session that starts with the next published notification. */
	readonly subscribe: Effect.Effect<string>
	/** Acknowledges `after` and waits briefly for the next notification. */
	readonly next: (session: string, after: number) => Effect.Effect<Delivery<A>>
}

const Delivered = <A, I>(payload: Schema.Codec<A, I>) =>
	Schema.Union([
		Schema.TaggedStruct("Delivered", { seq: Schema.Int, payload }),
		Schema.TaggedStruct("Lost", { seq: Schema.Int }),
		Schema.TaggedStruct("Dropped", { count: Schema.Int }),
		Schema.TaggedStruct("Idle", {}),
	])

/** A contract service for one channel; `name` versions its two operations. */
export const service = <K, A, I extends Schema.Json>(
	key: Context.Key<K, Channel<A>>,
	name: string,
	payload: Schema.Codec<A, I>,
) =>
	contractService(
		key,
		RpcGroup.make(
			operation(
				`${name}/subscribe`,
				1,
				Rpc.make("Subscribe", { success: Schema.String }),
			),
			operation(
				`${name}/next`,
				1,
				Rpc.make("Next", {
					payload: { session: Schema.String, after: Schema.Int },
					success: Delivered(payload),
				}),
			),
		),
		{
			toHandlers: (channel) => ({
				Subscribe: () => channel.subscribe,
				Next: ({ session, after }) => channel.next(session, after),
			}),
			fromClient: (client) => ({
				subscribe: Effect.orDie(client.Subscribe()),
				next: (session, after) => Effect.orDie(client.Next({ session, after })),
			}),
		},
	)

interface Session<A> {
	readonly queue: ReadonlyArray<{ readonly seq: number; readonly payload: A }>
	/** The delivery handed out but not yet acknowledged. */
	readonly outstanding: Option.Option<number>
	readonly dropped: number
	/** Sessions not pulled for a while belong to a subscriber that is gone. */
	readonly seen: number
}
export interface EmitterOptions {
	/** Notifications kept per session before the oldest is dropped. Default 256. */
	readonly capacity?: number
	/** How long one pull waits for a notification. Default 5 seconds. */
	readonly wait?: Duration.Input
}
/** The emitter: publish fans out to every live session, each with its own bounded, ordered queue. */
export const emitter = Effect.fnUntraced(function* <A>(
	options: EmitterOptions = {},
) {
	const capacity = Math.max(1, options.capacity ?? 256)
	const wait = options.wait ?? "5 seconds"
	const sessions = yield* SubscriptionRef.make(
		HashMap.empty<string, Session<A>>(),
	)
	const counter = yield* Ref.make(0)
	const sessionCount = yield* Ref.make(0)
	const lock = yield* Semaphore.make(1)
	const idleLimit = Duration.toMillis(
		Duration.times(Duration.fromInputUnsafe(wait), 12),
	)
	const publish = (payload: A) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const seq = yield* Ref.updateAndGet(counter, (n) => n + 1)
				const now = yield* Clock.currentTimeMillis
				yield* SubscriptionRef.update(sessions, (all) =>
					HashMap.map(
						HashMap.filter(all, (session) => now - session.seen < idleLimit),
						(session) => {
							const queue = [...session.queue, { seq, payload }]
							const overflow = Math.max(0, queue.length - capacity)
							return {
								...session,
								queue: queue.slice(overflow),
								dropped: session.dropped + overflow,
							}
						},
					),
				)
			}),
		)
	const settle = (id: string, after: number, now: number) =>
		SubscriptionRef.modify(sessions, (all) => {
			const session = HashMap.get(all, id)
			if (Option.isNone(session))
				return [Option.none<Delivery<A>>(), all] as const
			const current = session.value
			/** An outstanding delivery the subscriber did not acknowledge has an unknown result: report it, never resend. */
			const lost = Option.filter(current.outstanding, (seq) => seq > after)
			const next: Session<A> = {
				...current,
				seen: now,
				outstanding: Option.none(),
				dropped: Option.isSome(lost) ? current.dropped : 0,
			}
			if (Option.isSome(lost))
				return [
					Option.some<Delivery<A>>({ _tag: "Lost", seq: lost.value }),
					HashMap.set(all, id, next),
				] as const
			if (current.dropped > 0)
				return [
					Option.some<Delivery<A>>({ _tag: "Dropped", count: current.dropped }),
					HashMap.set(all, id, next),
				] as const
			const head = current.queue[0]
			if (head === undefined)
				return [Option.none<Delivery<A>>(), HashMap.set(all, id, next)] as const
			return [
				Option.some<Delivery<A>>({ _tag: "Delivered", ...head }),
				HashMap.set(all, id, {
					...next,
					queue: current.queue.slice(1),
					outstanding: Option.some(head.seq),
				}),
			] as const
		})
	const channel: Channel<A> = {
		subscribe: Effect.gen(function* () {
			const n = yield* Ref.updateAndGet(sessionCount, (k) => k + 1)
			const seen = yield* Clock.currentTimeMillis
			const id = `session-${n}`
			const fresh: Session<A> = {
				queue: [],
				outstanding: Option.none(),
				dropped: 0,
				seen,
			}
			yield* SubscriptionRef.update(sessions, HashMap.set(id, fresh))
			return id
		}),
		next: (id, after) =>
			Clock.currentTimeMillis.pipe(
				Effect.flatMap((now) => settle(id, after, now)),
				Effect.flatMap(
					Option.match({
						onSome: Effect.succeed,
						onNone: () =>
							SubscriptionRef.changes(sessions).pipe(
								Stream.filter((all) =>
									Option.exists(
										HashMap.get(all, id),
										(s) => s.queue.length > 0 || s.dropped > 0,
									),
								),
								Stream.runHead,
								Effect.timeoutOption(wait),
								Effect.flatMap(() => Clock.currentTimeMillis),
								Effect.flatMap((now) => settle(id, after, now)),
								Effect.map(
									Option.getOrElse((): Delivery<A> => ({ _tag: "Idle" })),
								),
							),
					}),
				),
			),
	}
	return { publish, channel }
})

/**
 * The subscriber loop: pulls, runs the handler to completion, then acknowledges
 * with the next pull. Runs until interrupted; fork it into the plugin's scope.
 */
export const subscribe = <A, E, R>(
	channel: Channel<A>,
	handle: (
		delivery: Exclude<Delivery<A>, { readonly _tag: "Idle" }>,
	) => Effect.Effect<void, E, R>,
): Effect.Effect<never, E, R> =>
	Effect.gen(function* () {
		const session = yield* channel.subscribe
		const loop = (after: number): Effect.Effect<never, E, R> =>
			channel
				.next(session, after)
				.pipe(
					Effect.flatMap((delivery) =>
						delivery._tag === "Idle"
							? loop(after)
							: handle(delivery).pipe(
									Effect.andThen(
										loop(
											delivery._tag === "Delivered" || delivery._tag === "Lost"
												? delivery.seq
												: after,
										),
									),
								),
					),
				)
		return yield* loop(0)
	})
