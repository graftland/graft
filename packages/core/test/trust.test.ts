import { Effect, Exit, Option, Scope, TxRef } from "effect"
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
			yield* Trust.publish([
				{
					projection: "mail/verbs",
					service: "mail",
					operation: "send@1",
					value: { verb: "send", labels: ["urgent"] },
				},
			])
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
		yield* Trust.publish([])
		const result = yield* Trust.register({
			compare: () =>
				Effect.succeed({
					current: null,
					approved: Option.some(null),
					missing: "Unapproved",
				}),
			publish: () => Effect.void,
		}).pipe(Effect.flip)
		assert.equal(result._tag, "AdmissionRegistrationError")
	}).pipe(run),
)
