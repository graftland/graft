import { Array, Effect, Fiber, HashMap, HashSet, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Control from "../src/Control"
import { budget, gateway } from "./gateway-fixture"
import { consistent, phase } from "./public-control-assertions"

for (const placement of ["Worker", "Process", "Runner"] as const)
	it.effect(
		`keeps the gateway session during ${placement} Restart and dispatches bounded waiters to the new generation (I1, I4, I8, I10)`,
		() =>
			Effect.gen(function* () {
				const f = yield* gateway(placement)
				yield* Effect.gen(function* () {
					const address = yield* Control.serve()
					const client = yield* Control.connect(address)
					yield* Effect.addFinalizer(() => TestClock.adjust(100000))
					const first = yield* client.submit({
						instance: "integration",
						target: f.target(1),
						budget,
					})
					yield* consistent(client, first.id, "Accepted")
					const gateway = yield* client.submit({
						instance: "gateway",
						target: f.consumer,
						budget,
					})
					yield* consistent(client, gateway.id, "Accepted")
					const session = yield* f.session
					assert.equal((yield* f.call("before")).version, 1)
					const held = yield* f.call("held").pipe(Effect.forkScoped)
					yield* f.held
					const upgrade = yield* client.submit({
						instance: "integration",
						target: f.target(2),
						strategy: "Restart",
						budget,
						requirements: { trial: 1000 },
					})
					yield* phase(client, upgrade.id, "Draining")
					const queued = yield* f.call("queued").pipe(Effect.forkScoped)
					const waiters = yield* client.waiters.pipe(
						Effect.repeat({ until: (values) => values.length === 1 }),
					)
					assert.equal(waiters.length, 1)
					assert.isFalse("provider" in (waiters[0] ?? {}))
					yield* f.release
					assert.equal((yield* Fiber.join(held)).version, 1)
					yield* phase(client, upgrade.id, "Retiring")
					yield* phase(client, upgrade.id, "Trial")
					assert.equal((yield* Fiber.join(queued)).version, 2)
					const current = yield* f.call("after")
					assert.equal(current.version, 2)
					assert.equal(current.session, session)
					yield* TestClock.adjust(1000)
					yield* consistent(client, upgrade.id, "Accepted")
					const units = yield* client.units
					const old = Array.findFirst(
						units,
						(u) =>
							u.instance === "integration" &&
							u.kind === "Execution" &&
							u.term === 1,
					)
					assert.equal(Option.getOrThrow(old).evidence, "Exited")
					const gateways = Array.filter(
						units,
						(u) => u.instance === "gateway" && u.kind === "Execution",
					)
					assert.equal(gateways.length, 1)
					assert.equal(gateways[0]?.evidence, "Missing")
				}).pipe(Effect.provide(f.layer))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30000,
	)
it.effect(
	"pins an old admitted call while Overlap routes new calls to new code and unrelated B completes during A trial (I2, I4, I8, I10)",
	() =>
		Effect.gen(function* () {
			const f = yield* gateway("Worker")
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				yield* Effect.addFinalizer(() => TestClock.adjust(100000))
				const first = yield* client.submit({
					instance: "integration",
					target: f.target(1),
					budget,
				})
				yield* consistent(client, first.id, "Accepted")
				const consumer = yield* client.submit({
					instance: "gateway",
					target: f.consumer,
					budget,
				})
				yield* consistent(client, consumer.id, "Accepted")
				const session = yield* f.session
				const oldCall = yield* f.call("held").pipe(Effect.forkScoped)
				yield* Effect.raceFirst(
					f.held,
					Fiber.join(oldCall).pipe(
						Effect.andThen(Effect.die("Held call returned before release")),
					),
				)
				const upgrade = yield* client.submit({
					instance: "integration",
					target: f.target(2),
					strategy: "Overlap",
					requirements: { trial: 10000 },
					budget: { ...budget, total: 60000 },
				})
				yield* phase(client, upgrade.id, "Trial")
				const unrelated = yield* client.submit({
					instance: "unrelated",
					realm: "other",
					realms: [
						{ id: "other", parent: Option.none(), isolated: HashSet.empty() },
					],
					target: f.target(3),
					strategy: "Overlap",
					budget,
				})
				yield* consistent(client, unrelated.id, "Accepted")
				const current = yield* f.call("new")
				assert.equal(current.version, 2)
				assert.equal(current.session, session)
				yield* f.release
				assert.equal((yield* Fiber.join(oldCall)).version, 1)
				yield* TestClock.adjust(10000)
				yield* phase(client, upgrade.id, "Retiring")
				yield* TestClock.adjust(1000)
				yield* consistent(client, upgrade.id, "Accepted")
				const calls = yield* client.calls
				assert.isTrue(Array.every(calls, (c) => !c.credit))
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
it.effect(
	"settles failed startup as Aborted and failed trial as fresh Recovered with public native evidence (I1, I2, I7, I10)",
	() =>
		Effect.gen(function* () {
			const f = yield* gateway("Process")
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				yield* Effect.addFinalizer(() => TestClock.adjust(100000))
				const first = yield* client.submit({
					instance: "integration",
					target: f.target(1),
					budget,
				})
				yield* consistent(client, first.id, "Accepted")
				const consumer = yield* client.submit({
					instance: "gateway",
					target: f.consumer,
					budget,
				})
				yield* consistent(client, consumer.id, "Accepted")
				const bad = yield* client.submit({
					instance: "integration",
					target: f.target(2, "startup"),
					strategy: "Overlap",
					budget,
				})
				yield* consistent(client, bad.id, "Aborted")
				assert.equal((yield* f.call("still-old")).version, 1)
				const trial = yield* client.submit({
					instance: "integration",
					target: f.target(2, "trial"),
					strategy: "Overlap",
					budget,
					requirements: { trial: 1000 },
				})
				yield* phase(client, trial.id, "Trial")
				const crashing = yield* f.call("crash").pipe(Effect.forkScoped)
				yield* client.observe(trial.id).pipe(
					Stream.filter((s) => s.recovering && s.phase === "Trial"),
					Stream.runHead,
				)
				yield* TestClock.adjust(1000)
				const recovered = yield* consistent(client, trial.id, "Recovered")
				yield* Fiber.interrupt(crashing)
				assert.equal(
					Option.getOrThrow(HashMap.get(recovered.members, "integration"))
						.matchesTarget,
					false,
				)
				const reply = yield* f.call("recovered")
				assert.equal(reply.version, 1)
				assert.isAbove(reply.term, 2)
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
