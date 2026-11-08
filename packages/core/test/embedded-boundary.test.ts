import { Context, Effect, Layer, Option } from "effect"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Kernel, Plugin, Transition } from "../src/index.ts"

it.effect(
	"embedded composition does not install a kernel Change service (I4, I12)",
	() =>
		Effect.gen(function* () {
			const services = yield* Layer.build(Graft.layer)
			assert.isTrue(Option.isNone(Context.getOption(services, Kernel.Kernel)))
		}),
)

it("deletes closure registration and Context-returning driver APIs (I4, I12)", () => {
	for (const name of [
		"registerDriver",
		"facade",
		"Driver",
		"Unit",
		"Prepared",
		"Registration",
		"Allocation",
		"Invoke",
		"Facade",
	])
		assert.notProperty(Transition, name)
})

const request: Change.Request = {
	operations: [
		{
			_tag: "Deploy",
			instance: "integration",
			target: { identity: "next", placement: "Worker", overlap: true },
		},
	],
	budget: {
		total: 1000,
		startup: 50,
		probe: 50,
		drain: 50,
		stop: 50,
		terminate: 50,
	},
}
const needsKernel: Effect.Effect<
	Change.Handle,
	Change.ChangeRejected,
	Kernel.Kernel
> = Change.submit(request)
it("requires the kernel service for public Change submission", () =>
	assert.isTrue(Effect.isEffect(needsKernel)))

it.effect(
	"captures unit membership before an embedded caller overrides its reference (I12)",
	() =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(
				Plugin.make({ name: "unit-member", apply: () => Effect.void }),
			).pipe(Effect.provideService(Transition.UnitMember, Option.none()))
			yield* fork.await
			const error = yield* fork.restart.pipe(Effect.flip)
			assert.equal(error._tag, "ManagedFork")
		}).pipe(
			Effect.provide(
				Graft.layer.pipe(
					Layer.provide(
						Layer.succeed(Transition.UnitMember, Option.some("unit-1")),
					),
				),
			),
		),
)
