/**
 * Several tenants, one set of layers.
 *
 * `isolate` gives a service its own realm below the mount, so two mounts can
 * publish the same service key without colliding. `intercept` adjusts a
 * reference for one mount and everything below it.
 */
import { Array, Context, Effect, Layer, Ref, type Scope } from "effect"

import { Graft, Mount } from "@graftland/graft"

/** Which tenant a mount serves. A reference has a default and can be intercepted. */
const Tenant = Context.Reference<string>(
	"@graftland-samples/04-tenants/program/Tenant",
	{
		defaultValue: () => "unknown",
	},
)

class Notes extends Context.Service<
	Notes,
	{
		readonly add: (text: string) => Effect.Effect<void>
		readonly list: Effect.Effect<ReadonlyArray<string>>
	}
>()("@graftland-samples/04-tenants/program/Notes") {}

/** The same layer serves every tenant; only the intercepted reference differs. */
const notes = Layer.effect(
	Notes,
	Effect.gen(function* () {
		const tenant = yield* Tenant
		const saved = yield* Ref.make<ReadonlyArray<string>>([])
		yield* Effect.log(`Opening notes for "${tenant}"`)
		return yield* Effect.acquireRelease(
			Effect.succeed({
				add: (text: string) =>
					Ref.update(saved, Array.append(text)).pipe(
						Effect.andThen(Effect.log(`Saving "${text}" for "${tenant}"`)),
					),
				list: Ref.get(saved),
			}),
			() => Effect.log(`Closing notes for "${tenant}"`),
		)
	}),
)

/** A consumer with no outputs. It joins the realm of the notes it requires. */
const reader = Layer.effectDiscard(
	Effect.gen(function* () {
		const store = yield* Notes
		yield* store.add("launch checklist")
		const texts = yield* store.list
		yield* Effect.log(`Reading notes`, { texts })
		yield* Effect.acquireRelease(Effect.void, () =>
			Effect.log("The reader stopped"),
		)
	}),
)

export const program: Effect.Effect<
	void,
	Graft.ServiceConflict | Mount.CleanupError,
	Graft.Graft | Scope.Scope
> = Effect.gen(function* () {
	const acorn = yield* Graft.mount(notes, {
		name: "acorn notes",
		isolate: [[Notes, "acorn"]],
		intercept: [Graft.intercept(Tenant, () => "acorn")],
	})
	const northstar = yield* Graft.mount(notes, {
		name: "northstar notes",
		isolate: [[Notes, "northstar"]],
		intercept: [Graft.intercept(Tenant, () => "northstar")],
	})
	yield* acorn.await
	yield* northstar.await

	const acornReader = yield* Graft.mount(reader, {
		name: "acorn reader",
		requires: [Notes],
		isolate: [[Notes, "acorn"]],
	})
	yield* acornReader.await

	// The reader is torn down first, then Acorn's notes are released.
	yield* acorn.unmount
	yield* Effect.log("Acorn left; Northstar still has its own notes")

	const northstarReader = yield* Graft.mount(reader, {
		name: "northstar reader",
		requires: [Notes],
		isolate: [[Notes, "northstar"]],
	})
	yield* northstarReader.await
})
