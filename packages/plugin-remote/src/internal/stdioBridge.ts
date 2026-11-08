/** Kernel-owned process stdio, lent to at most one live unit incarnation at a time. */
import {
	Context,
	Deferred,
	Effect,
	FiberSet,
	Layer,
	Option,
	Queue,
	Stdio,
	Stream,
	SubscriptionRef,
	type Cause,
} from "effect"

/** The unit incarnation that currently holds the process stdio. */
export interface Holder {
	readonly unit: string
	readonly incarnation: string
	readonly deliver: (input: Input) => Effect.Effect<void>
	readonly ended: Effect.Effect<void>
}
/** Bytes read from the kernel's stdin, or its end. */
export type Input =
	| { readonly _tag: "Bytes"; readonly bytes: Uint8Array }
	| { readonly _tag: "End" }
export interface Bridge {
	/** Grants the stdio to `holder` unless another live incarnation holds it. */
	readonly claim: (holder: Holder) => Effect.Effect<boolean>
	readonly write: (
		unit: string,
		incarnation: string,
		bytes: Uint8Array,
	) => Effect.Effect<void>
	/** The holder ended its output; the kernel's stdout ends with it. */
	readonly close: (unit: string, incarnation: string) => Effect.Effect<void>
	readonly release: (unit: string, incarnation: string) => Effect.Effect<void>
	/** Completes once the holder has ended the kernel's stdout. */
	readonly closed: Effect.Effect<void, Cause.Cause<unknown>>
}
/** Present only in kernels started with protocol stdio; otherwise every claim is denied. */
export const StdioBridge = Context.Reference<Option.Option<Bridge>>(
	"@graftland/plugin-remote/StdioBridge",
	{ defaultValue: Option.none },
)

const holds = (
	current: Option.Option<Holder>,
	unit: string,
	incarnation: string,
) =>
	Option.exists(
		current,
		(h) => h.unit === unit && h.incarnation === incarnation,
	)

/** Reads stdin once into a queue that survives holder restarts; output goes through one stdout sink. */
export const layer: Layer.Layer<never, never, Stdio.Stdio> =
	Layer.effectContext(
		Effect.gen(function* () {
			const stdio = yield* Stdio.Stdio
			const holder = yield* SubscriptionRef.make(Option.none<Holder>())
			const input = yield* Queue.unbounded<Input>()
			const output = yield* Queue.unbounded<Uint8Array, Cause.Done>()
			const closed = yield* Deferred.make<void, Cause.Cause<unknown>>()
			const fibers = yield* FiberSet.make<void, never>()
			yield* stdio.stdin.pipe(
				Stream.runForEach((bytes) =>
					Queue.offer(input, { _tag: "Bytes", bytes }),
				),
				Effect.catchCause((cause) =>
					Effect.logError("Reading the kernel's stdin failed", cause),
				),
				Effect.andThen(Queue.offer(input, { _tag: "End" })),
				FiberSet.run(fibers),
			)
			/** Each input waits for a live holder, so bytes sent before a claim or across a restart are kept. */
			const current = SubscriptionRef.changes(holder).pipe(
				Stream.filter(Option.isSome),
				Stream.runHead,
				Effect.map(Option.flatten),
				Effect.flatMap(Effect.fromOption),
				Effect.orDie,
			)
			yield* Queue.take(input).pipe(
				Effect.flatMap((next) =>
					Effect.flatMap(current, (h) => h.deliver(next)),
				),
				Effect.forever,
				FiberSet.run(fibers),
			)
			yield* Stream.fromQueue(output).pipe(
				Stream.run(stdio.stdout({ endOnDone: true })),
				Effect.exit,
				Effect.flatMap((exit) =>
					exit._tag === "Success"
						? Deferred.succeed(closed, undefined)
						: Deferred.fail(closed, exit.cause),
				),
				Effect.asVoid,
				FiberSet.run(fibers),
			)
			const release = (unit: string, incarnation: string) =>
				SubscriptionRef.update(holder, (h) =>
					holds(h, unit, incarnation) ? Option.none() : h,
				)
			const bridge: Bridge = {
				claim: (next) =>
					SubscriptionRef.modify(holder, (h) =>
						Option.isSome(h) && !holds(h, next.unit, next.incarnation)
							? [false, h]
							: [true, Option.some(next)],
					).pipe(
						Effect.tap((granted) =>
							granted
								? next.ended.pipe(
										Effect.andThen(release(next.unit, next.incarnation)),
										FiberSet.run(fibers),
									)
								: Effect.void,
						),
					),
				write: (unit, incarnation, bytes) =>
					SubscriptionRef.get(holder).pipe(
						Effect.flatMap((h) =>
							holds(h, unit, incarnation)
								? Queue.offer(output, bytes).pipe(Effect.asVoid)
								: Effect.void,
						),
					),
				close: (unit, incarnation) =>
					SubscriptionRef.get(holder).pipe(
						Effect.flatMap((h) =>
							holds(h, unit, incarnation) ? Queue.end(output) : Effect.void,
						),
						Effect.asVoid,
					),
				release,
				closed: Deferred.await(closed),
			}
			return Context.make(StdioBridge, Option.some(bridge))
		}),
	)
