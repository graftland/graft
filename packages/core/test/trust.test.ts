import { Context, Effect, Exit, Option, Scope, TxRef } from "effect"
import { assert, it } from "@effect/vitest"

import { Trust } from "../src/index"
import { run } from "./utils"

class Reviewer extends Context.Service<Reviewer, { readonly name: string }>()(
	"@graftland/graft/test/trust.test/Reviewer",
) {}
it.effect(
	"uses an ordinary registered policy service and compares opaque immutable values",
	() =>
		Effect.gen(function* () {
			const input = { protocol: "mail", verbs: ["read"] }
			const approved = Trust.immutable(input)
			const current = yield* TxRef.make<import("effect").Schema.Json>(approved)
			const owner = yield* Scope.make()
			yield* Trust.register({
				services: Context.make(Reviewer, { name: "Operator" }),
				compare: () =>
					TxRef.get(current).pipe(
						Effect.map((value) => ({
							current: value,
							approved: Option.some(approved),
							missing: "NotReviewed",
						})),
					),
				publish: (values) => TxRef.set(current, Trust.immutable(values)),
			}).pipe(Scope.provide(owner))
			input.verbs[0] = "write"
			assert.deepEqual(approved, { protocol: "mail", verbs: ["read"] })
			assert.isTrue(Object.isFrozen(approved.verbs))
			assert.equal((yield* Trust.service(Reviewer)).name, "Operator")
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
			services: Context.empty(),
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
