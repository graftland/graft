import {
	Array,
	Effect,
	Exit,
	Option,
	Order,
	Ref,
	Semaphore,
	SubscriptionRef,
} from "effect"
import { HttpServerError, HttpServerRequest } from "effect/http"

import { Event, Graft } from "@graftland/graft"

import {
	Mounts,
	MountsChanged,
	Routes,
	Routing,
	type RouteState,
} from "../Http"
import * as Table from "./table"

/** Own the routing table independently of all listeners. */
export const router = Effect.fn("Http.router")(function* () {
	const table = yield* Ref.make(Table.empty())
	const state = yield* SubscriptionRef.make<RouteState>({
		served: [],
		conflicts: [],
	})
	const lock = yield* Semaphore.make(1)
	const sync = lock.withPermits(1)(
		Effect.gen(function* () {
			const outcomes = yield* Event.settle(Mounts)
			for (const outcome of outcomes)
				if (Exit.isFailure(outcome))
					yield* Effect.logError(
						"A plugin failed to say which routes it mounts",
						outcome.cause,
					)
			const next = yield* Table.build(
				Array.flatMap(outcomes, (outcome) =>
					Exit.isSuccess(outcome) ? [outcome.value] : [],
				),
			)
			const previous = yield* Ref.get(table)
			for (const conflict of next.conflicts)
				if (
					!Array.some(
						previous.conflicts,
						(old) =>
							Array.join(Array.sort(old.routes, Order.String), "\n") ===
							Array.join(Array.sort(conflict.routes, Order.String), "\n"),
					)
				)
					yield* Effect.logWarning(conflict)
			yield* Ref.set(table, next)
			yield* SubscriptionRef.set(state, {
				served: next.served,
				conflicts: next.conflicts,
			})
		}).pipe(
			Effect.catchTag("TableError", (error) =>
				Effect.logError("Could not rebuild the route index", error),
			),
		),
	)
	yield* Event.on(MountsChanged, () => sync)
	yield* sync
	yield* Graft.provide(Routes, state)
	const dispatch = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const current = yield* Ref.get(table)
		const mount = Table.lookup(current, request.method, request.url)
		return yield* Option.isSome(mount)
			? // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- HttpServer reports heterogeneous application causes
				mount.value.handle
			: Effect.fail(
					new HttpServerError.HttpServerError({
						reason: new HttpServerError.RouteNotFound({ request }),
					}),
				)
	})
	// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Routing preserves heterogeneous request failures for the listener
	yield* Graft.provide(Routing, { handle: dispatch })
})
