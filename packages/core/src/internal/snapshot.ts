import { Cause, Effect, Option, Stream, TxRef, type Scope } from "effect"

// Graft's runtime service is shared across bundled copies, so its opaque keys must agree too.
const Value: unique symbol = Symbol.for(
	"@graftland/graft/internal/Snapshot/value",
)
const JournalState: unique symbol = Symbol.for(
	"@graftland/graft/internal/Snapshot/journal",
)

interface Cursor<A> {
	readonly value: A
	readonly tail: TxRef.TxRef<Option.Option<Cursor<A>>>
}
interface Journal<A> {
	readonly readers: number
	readonly tail: Cursor<A>["tail"]
}

/** Opaque state and a shared transactional journal, allocated only while observed. */
export interface Snapshot<A> {
	readonly [Value]: TxRef.TxRef<A>
	readonly [JournalState]: TxRef.TxRef<Journal<A> | undefined>
}

export const make = <A>(value: A): Effect.Effect<Snapshot<A>> =>
	Effect.sync(() => ({
		[Value]: TxRef.makeUnsafe(value),
		[JournalState]: TxRef.makeUnsafe<Journal<A> | undefined>(undefined),
	}))

const publish = <A>(self: Snapshot<A>, value: A) =>
	Effect.flatMap(TxRef.get(self[JournalState]), (journal) =>
		journal === undefined
			? Effect.void
			: Effect.suspend(() => {
					const tail = TxRef.makeUnsafe<Option.Option<Cursor<A>>>(Option.none())
					return TxRef.set(journal.tail, Option.some({ value, tail })).pipe(
						Effect.andThen(
							TxRef.set(self[JournalState], { readers: journal.readers, tail }),
						),
					)
				}),
	)

export const get = <A>(self: Snapshot<A>) => TxRef.get(self[Value])

/** Inspect observation lifetime without exposing the journal's mutable cell. */
export const getJournal = <A>(self: Snapshot<A>) =>
	TxRef.get(self[JournalState])

export const set = <A>(self: Snapshot<A>, value: A): Effect.Effect<void> =>
	Effect.tx(Effect.andThen(TxRef.set(self[Value], value), publish(self, value)))

export const update = <A>(
	self: Snapshot<A>,
	f: (value: A) => A,
): Effect.Effect<void> =>
	Effect.tx(
		Effect.flatMap(
			TxRef.modify(self[Value], (current) => {
				const next = f(current)
				return [next, next]
			}),
			(next) => publish(self, next),
		),
	)

type ReaderState<A> =
	| { readonly _tag: "First"; readonly cursor: Cursor<A> }
	| { readonly _tag: "Next"; readonly tail: Cursor<A>["tail"] }
	| { readonly _tag: "Closed"; readonly cause: Cause.Cause<never> }

type Reader<A> = TxRef.TxRef<ReaderState<A>>

export const changes = <A>(
	self: Snapshot<A>,
): Effect.Effect<Reader<A>, never, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.tx(
			Effect.flatMap(TxRef.get(self[JournalState]), (previous) => {
				const journal = previous ?? {
					readers: 0,
					tail: TxRef.makeUnsafe<Option.Option<Cursor<A>>>(Option.none()),
				}
				return TxRef.set(self[JournalState], {
					readers: journal.readers + 1,
					tail: journal.tail,
				}).pipe(
					Effect.andThen(TxRef.get(self[Value])),
					Effect.map((value) =>
						TxRef.makeUnsafe<ReaderState<A>>({
							_tag: "First",
							cursor: { value, tail: journal.tail },
						}),
					),
				)
			}),
		),
		(reader) =>
			Effect.withFiber((fiber) =>
				Effect.tx(
					TxRef.set(reader, {
						_tag: "Closed",
						cause: Cause.interrupt(fiber.id),
					}).pipe(
						Effect.andThen(
							TxRef.update(self[JournalState], (current) =>
								current === undefined || current.readers === 1
									? undefined
									: { ...current, readers: current.readers - 1 },
							),
						),
					),
				),
			),
	)

// The resource retained by Scope is the advancing reader cell, never its initial cursor.
// Keeping an immutable initial cursor in a finalizer would retain the entire observed history.
export const take = <A>(reader: Reader<A>): Effect.Effect<A> =>
	Effect.tx(
		Effect.flatMap(TxRef.get(reader), (state) => {
			switch (state._tag) {
				case "Closed":
					return Effect.failCause(state.cause)
				case "First":
					return Effect.as(
						TxRef.set(reader, { _tag: "Next", tail: state.cursor.tail }),
						state.cursor.value,
					)
				case "Next":
					return Effect.flatMap(TxRef.get(state.tail), (next) =>
						Option.isNone(next)
							? Effect.txRetry
							: Effect.as(
									TxRef.set(reader, { _tag: "Next", tail: next.value.tail }),
									next.value.value,
								),
					)
			}
		}),
	)

export const poll = <A>(reader: Reader<A>): Effect.Effect<Option.Option<A>> =>
	Effect.tx(
		Effect.flatMap(TxRef.get(reader), (state) =>
			state._tag !== "Next"
				? Effect.asSome(take(reader))
				: Effect.flatMap(TxRef.get(state.tail), (next) =>
						Option.isNone(next)
							? Effect.succeedNone
							: Effect.asSome(take(reader)),
					),
		),
	)

export const changesStream = <A>(self: Snapshot<A>): Stream.Stream<A> =>
	Stream.unwrap(
		Effect.map(changes(self), (reader) =>
			Stream.fromEffectRepeat(take(reader)),
		),
	)

export const waitFor = <A>(
	self: Snapshot<A>,
	accept: (value: A) => boolean,
): Effect.Effect<A> =>
	Effect.scoped(
		Effect.flatMap(changes(self), (reader) => {
			const next = take(reader)
			const loop: Effect.Effect<A> = Effect.filterOrElse(
				next,
				accept,
				() => loop,
			)
			return loop
		}),
	)
