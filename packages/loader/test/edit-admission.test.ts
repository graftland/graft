import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Ref,
	Stream,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { Entry, Loader, Tree } from "../src/index.ts"
import { loaderService, run } from "./utils.ts"

const setup = Effect.gen(function* () {
	const entered = yield* Deferred.make<void>()
	const release = yield* Deferred.make<void>()
	const current = yield* Ref.make<ReadonlyArray<Entry.Entry>>([])
	const fork = yield* Graft.plugin(
		Plugin.make({
			name: "stored",
			apply: () =>
				Loader.start({
					initial: [],
					apply: (op) =>
						Effect.gen(function* () {
							if (op._tag === "Create" && op.entry.id === "first") {
								yield* Deferred.succeed(entered, undefined)
								yield* Deferred.await(release)
							}
							const previous = yield* Ref.get(current)
							const next = yield* Effect.fromResult(Tree.apply(previous, op))
							yield* Ref.set(current, next)
							return next
						}),
					refresh: Effect.succeedNone,
					external: Stream.never,
				}),
		}),
	)
	const loader = yield* loaderService
	yield* loader.ready
	const create = (id: string) =>
		loader.create({ id, name: "unused", disabled: true })
	const first = yield* create("first").pipe(
		Effect.forkChild({ startImmediately: true }),
	)
	yield* Deferred.await(entered)
	return { fork, loader, create, first, release, current }
})

describe("loader edit admission", () => {
	it.effect(
		"finishes removing an entry whose apply is waiting for that edit",
		() =>
			run(() => ({
				self: Plugin.make({
					name: "self",
					inject: [Loader.Loader],
					apply: () =>
						Effect.flatMap(Loader.Loader, (loader) => loader.remove("self")),
				}),
			}))(() =>
				Effect.gen(function* () {
					yield* Graft.plugin(Loader.plugin, [{ id: "self", name: "self" }])
					const loader = yield* loaderService
					const removed = yield* loader.changes.pipe(
						Stream.filter((entries) => entries.length === 0),
						Stream.runHead,
					)
					assert.deepStrictEqual(Option.getOrThrow(removed), [])
					yield* loader.ready
				}),
			),
	)
	it.effect(
		"cancels a blocked offer without cancelling an already queued edit",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { loader, create, first, release, current } = yield* setup
					// The worker holds the first edit; the single queue slot accepts the second.
					const accepted = yield* create("accepted").pipe(
						Effect.forkChild({ startImmediately: true }),
					)
					const waiting = yield* create("cancelled").pipe(
						Effect.forkChild({ startImmediately: true }),
					)
					yield* Fiber.interrupt(waiting)
					yield* Fiber.interrupt(accepted)
					yield* Deferred.succeed(release, undefined)
					yield* Fiber.join(first)
					// A later accepted edit is a barrier for all earlier queue entries.
					yield* create("last")
					const entries = yield* loader.entries
					const stored = yield* Ref.get(current)
					assert.deepStrictEqual(
						Array.map(entries, (entry) => entry.id),
						["first", "accepted", "last"],
					)
					assert.deepStrictEqual(entries, stored)
				}),
			),
	)

	it.effect(
		"settles active and queued callers when the owning scope closes",
		() =>
			run(() => ({}))(() =>
				Effect.gen(function* () {
					const { fork, create, first, current } = yield* setup
					const queued = yield* create("queued").pipe(
						Effect.forkChild({ startImmediately: true }),
					)
					const waiting = yield* create("waiting").pipe(
						Effect.forkChild({ startImmediately: true }),
					)
					yield* fork.dispose
					const activeExit = yield* Fiber.await(first)
					const queuedExit = yield* Fiber.await(queued)
					const waitingExit = yield* Fiber.await(waiting)
					assert(Exit.isFailure(activeExit))
					assert(Exit.isFailure(queuedExit))
					assert(Exit.isFailure(waitingExit))
					assert.strictEqual(
						Option.getOrThrow(Cause.findErrorOption(queuedExit.cause))._tag,
						"LoaderClosed",
					)
					assert.strictEqual(
						Option.getOrThrow(Cause.findErrorOption(waitingExit.cause))._tag,
						"LoaderClosed",
					)
					const closed = yield* Effect.flip(create("closed"))
					assert.strictEqual(closed._tag, "LoaderClosed")
					const stored = yield* Ref.get(current)
					assert.deepStrictEqual(stored, [])
				}),
			),
	)

	it.effect("logs an abandoned edit's cause and keeps the worker usable", () =>
		run(() => ({}))(() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const error = Tree.InvalidOperation.make({
					reason: "The store rejected the edit",
				})
				yield* Graft.plugin(
					Plugin.make({
						name: "stored",
						apply: () =>
							Loader.start({
								initial: [],
								apply: (op) =>
									op._tag === "Remove"
										? Effect.gen(function* () {
												yield* Deferred.succeed(entered, undefined)
												yield* Deferred.await(release)
												return yield* error
											})
										: Effect.fromResult(Tree.apply([], op)),
								refresh: Effect.succeedNone,
								external: Stream.never,
							}),
					}),
				)
				const loader = yield* loaderService
				const removing = yield* loader.remove("missing").pipe(Effect.forkChild)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(removing)
				yield* Deferred.succeed(release, undefined)
				const result = yield* Graft.logs.pipe(
					Stream.filter(
						(log) =>
							Array.isArray(log.message) &&
							Array.contains(log.message, "Applying a loader edit failed"),
					),
					Stream.runHead,
				)
				assert.strictEqual(Cause.squash(Option.getOrThrow(result).cause), error)
				yield* loader.create({ id: "next", name: "unused", disabled: true })
				const entries = yield* loader.entries
				assert.strictEqual(entries[0]?.id, "next")
			}),
		),
	)
})
