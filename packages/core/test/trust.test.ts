import { Deferred, Effect, Exit, Fiber, Option, Scope, TxRef } from "effect"
import { assert, it } from "@effect/vitest"

import { Trust } from "../src/index"
import { run } from "./utils"

it.effect(
	"uses a registered policy authority and compares opaque immutable values",
	() =>
		Effect.gen(function* () {
			const input = { protocol: "mail", verbs: ["read"] }
			const approved = structuredClone(input)
			const current = yield* TxRef.make<import("effect").Schema.Json>(approved)
			const owner = yield* Scope.make()
			yield* Trust.register({
				compare: () =>
					TxRef.get(current).pipe(
						Effect.map((value) => ({
							current: value,
							approved: Option.some(approved),
							revision: 0,
							missing: "NotReviewed",
						})),
					),
				publish: (values) => TxRef.set(current, structuredClone(values)),
			}).pipe(Scope.provide(owner))
			input.verbs[0] = "write"
			assert.deepEqual(approved, { protocol: "mail", verbs: ["read"] })
			assert.equal(
				(yield* Trust.check("entry").pipe(Effect.flip)).reason,
				"UnregisteredAttempt",
			)
			yield* Trust.check("entry", "attempt")
			yield* Trust.publish({
				projection: "mail/verbs",
				view: "forecast-tools",
				values: [
					{
						service: "mail",
						operation: "send@1",
						value: { verb: "send", labels: ["urgent"] },
					},
				],
			})
			assert.equal(
				(yield* Trust.check("entry", "attempt").pipe(Effect.flip)).reason,
				"ChangedStatement",
			)
			yield* Scope.close(owner, Exit.void)
			assert.equal(
				(yield* Trust.check("entry", "attempt").pipe(Effect.flip)).reason,
				"Closed",
			)
		}).pipe(run),
)

it.effect("rejects policy installation after ungoverned publication", () =>
	Effect.gen(function* () {
		yield* Trust.publish({
			projection: "mail/verbs",
			view: "forecast-tools",
			values: [],
		})
		const result = yield* Trust.register({
			compare: () =>
				Effect.succeed({
					current: null,
					approved: Option.some(null),
					revision: 0,
					missing: "Unapproved",
				}),
			publish: () => Effect.void,
		}).pipe(Effect.flip)
		assert.equal(result._tag, "AdmissionRegistrationError")
	}).pipe(run),
)

it.effect(
	"releases a failed initial view claim and rejects stale publishers after remount",
	() =>
		Effect.gen(function* () {
			const reject = yield* TxRef.make(true)
			yield* Trust.register({
				compare: () =>
					Effect.succeed({
						current: null,
						approved: Option.some(null),
						revision: 0,
						missing: "Missing",
					}),
				publish: () =>
					TxRef.get(reject).pipe(
						Effect.flatMap((value) =>
							value
								? Trust.AdmissionRegistrationError.make({
										message: "Audit unavailable",
									})
								: Effect.void,
						),
					),
			})
			const publication = { projection: "test", view: "stable", values: [] }
			const failed = yield* Trust.publish(publication).pipe(Effect.flip)
			assert.equal(failed._tag, "AdmissionRegistrationError")
			yield* TxRef.set(reject, false)
			const owner = yield* Scope.make()
			const old = yield* Trust.publish(publication).pipe(Scope.provide(owner))
			yield* Scope.close(owner, Exit.void)
			const current = yield* Trust.publish(publication)
			const stale = yield* old.update([]).pipe(Effect.flip)
			assert.equal(stale._tag, "AdmissionRegistrationError")
			yield* current.update([])
		}).pipe(run),
)

it.effect(
	"retains exclusive view ownership until an in-flight publication finishes closing",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const finish = yield* Deferred.make<void>()
			yield* Trust.register({
				compare: () =>
					Effect.succeed({
						current: null,
						approved: Option.some(null),
						revision: 0,
						missing: "Missing",
					}),
				publish: (publication) =>
					publication.values.length === 0
						? Effect.void
						: Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
							),
			})
			const publication = { projection: "test", view: "stable", values: [] }
			const owner = yield* Scope.make()
			const publisher = yield* Trust.publish(publication).pipe(
				Scope.provide(owner),
			)
			const updating = yield* publisher
				.update([{ service: "test", operation: "read@1", value: "changed" }])
				.pipe(Effect.forkScoped)
			yield* Deferred.await(started)
			const closing = yield* Scope.close(owner, Exit.void).pipe(
				Effect.forkScoped,
			)
			const conflict = yield* Trust.publish(publication).pipe(Effect.flip)
			assert.equal(conflict._tag, "ProjectionConflict")
			yield* Deferred.succeed(finish, undefined)
			yield* Fiber.join(updating)
			yield* Fiber.join(closing)
			yield* Trust.publish(publication)
		}).pipe(run),
)
