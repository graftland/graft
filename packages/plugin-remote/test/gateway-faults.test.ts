import { Array, Cause, Effect, Fiber, HashMap, HashSet, Option } from "effect"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Control from "../src/Control"
import * as Units from "../src/Units"
import { budget, gateway } from "./gateway-fixture"
import { stage } from "./native-unit-fixture"
import { consistent, phase } from "./public-control-assertions"

const boot = Effect.fnUntraced(function* (
	f: Effect.Success<ReturnType<typeof gateway>>,
	client: Control.Client,
	mode: string = "normal",
) {
	const provider = yield* client.submit({
		instance: "integration",
		target: f.target(1, mode),
		budget,
	})
	yield* consistent(client, provider.id, "Accepted")
	const consumer = yield* client.submit({
		instance: "gateway",
		target: f.consumer,
		budget,
	})
	yield* consistent(client, consumer.id, "Accepted")
	return yield* f.session
})
for (const placement of ["Worker", "Process"] as const)
	for (const fault of ["import", "decode"] as const)
		it.live(
			`exposes ${placement} stalled ${fault} rejection and native cleanup while the gateway and unrelated B remain usable (I2, I4, I5, I11, I12)`,
			() =>
				Effect.gen(function* () {
					const f = yield* gateway(placement)
					const artifact = yield* stage(fault)
					const blocked = Units.target({
						artifact,
						contract: "contract.js",
						input: { mode: "test" },
						placement,
					})
					yield* Effect.gen(function* () {
						const address = yield* Control.serve()
						const client = yield* Control.connect(address)
						const session = yield* boot(f, client)
						const stalled = yield* client
							.submit({
								instance: "integration",
								target: blocked,
								budget: { ...budget, startup: 3000 },
							})
							.pipe(Effect.flip, Effect.forkScoped)
						const describing = yield* client.preparations.pipe(
							Effect.repeat({
								until: (values) =>
									Array.some(values, (p) => p.phase === "Describing"),
							}),
						)
						const unrelated = yield* client.submit({
							instance: "unrelated",
							realm: "other",
							realms: [
								{
									id: "other",
									parent: Option.none(),
									isolated: HashSet.empty(),
								},
							],
							target: f.target(3),
							strategy: "Overlap",
							budget,
						})
						yield* consistent(client, unrelated.id, "Accepted")
						const pending = Option.getOrThrow(
							Array.findFirst(describing, (p) => p.phase === "Describing"),
						)
						const concurrent = yield* client
							.getPreparation(pending.id)
							.pipe(Effect.flatMap(Effect.fromOption))
						assert.isTrue(Option.isNone(concurrent.result))

						const rejection = yield* Fiber.join(stalled)
						assert.equal(
							rejection.reason,
							"DescriptionFailed",
							Cause.pretty(rejection.cause),
						)
						if (rejection.preparation === undefined)
							return yield* Effect.die(
								"Rejected inspection has no public preparation id",
							)
						const preparation = yield* client
							.getPreparation(rejection.preparation)
							.pipe(Effect.flatMap(Effect.fromOption))
						assert.equal(preparation.exitEvidence, "Exited")
						assert.equal(HashSet.size(preparation.unconfirmedUnits), 0)
						const units = yield* client.units
						assert.isTrue(
							Array.some(
								units,
								(u) =>
									u.progress ===
										(fault === "import"
											? "DescribeImport"
											: "DescribeDecode") && u.evidence === "Exited",
							),
						)
						const reply = yield* f.call("still-serving")
						assert.equal(reply.version, 1)
						assert.equal(reply.session, session)
					}).pipe(Effect.provide(f.layer))
				}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
			30000,
		)
it.effect(
	"reauthorizes fresh recovery against current policy and reports RecoveryFailed after denial (I2, I4, I10)",
	() =>
		Effect.gen(function* () {
			const f = yield* gateway("Process")
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				yield* Effect.addFinalizer(() => TestClock.adjust(100000))
				yield* boot(f, client)
				const trial = yield* client.submit({
					instance: "integration",
					target: f.target(2, "trial"),
					strategy: "Overlap",
					budget,
					requirements: { trial: 1000 },
				})
				yield* phase(client, trial.id, "Trial")
				yield* client.setPolicy({
					instance: "integration",
					allowed: [],
					values: {},
				})
				const crashing = yield* f.call("crash").pipe(Effect.forkScoped)
				const result = yield* consistent(client, trial.id, "RecoveryFailed")
				assert.isFalse(
					Option.getOrThrow(HashMap.get(result.members, "integration")).healthy,
				)
				assert.isAbove(result.cause.reasons.length, 0)
				yield* Fiber.interrupt(crashing)
				const units = yield* client.units
				assert.isTrue(
					Array.every(
						Array.filter(
							units,
							(u) => u.instance === "integration" && u.kind === "Execution",
						),
						(u) => u.evidence === "Exited",
					),
				)
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
for (const fault of ["handler", "finalizer"] as const)
	it.effect(
		`terminates an integration with stalled ${fault} and settles its own credits without changing the gateway session (I2, I5, I6, I7, I8)`,
		() =>
			Effect.gen(function* () {
				const f = yield* gateway("Worker")
				yield* Effect.gen(function* () {
					const address = yield* Control.serve()
					const client = yield* Control.connect(address)
					yield* Effect.addFinalizer(() => TestClock.adjust(100000))
					const session = yield* boot(f, client, fault)
					const blocked =
						fault === "handler"
							? yield* f.call("held").pipe(Effect.forkScoped)
							: undefined
					if (blocked !== undefined) {
						yield* f.held
						yield* f.release
					}
					const change = yield* client.submit({
						instance: "integration",
						target: f.target(2),
						strategy: "Overlap",
						budget,
						requirements: { trial: 1000 },
					})
					yield* phase(client, change.id, "Trial")
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
					yield* TestClock.adjust(1000)
					if (fault === "finalizer") yield* f.held
					const draining = yield* phase(
						client,
						change.id,
						fault === "handler" ? "Draining" : "Retiring",
					)
					assert.isAbove(HashSet.size(draining.unconfirmedUnits), 0)
					yield* TestClock.adjust(fault === "handler" ? 2000 : 1000)
					yield* consistent(client, change.id, "Accepted")
					const units = yield* client.units
					const old = Option.getOrThrow(
						Array.findFirst(
							units,
							(u) =>
								u.instance === "integration" &&
								u.kind === "Execution" &&
								u.term === 1,
						),
					)
					assert.equal(old.evidence, "Exited")
					assert.equal(old.cleanup._tag, "Unknown")
					const calls = yield* client.calls
					assert.isTrue(Array.every(calls, (c) => !c.credit))
					if (blocked !== undefined) yield* Fiber.interrupt(blocked)
				}).pipe(Effect.provide(f.layer))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		30000,
	)

it.effect(
	"retains Stuck reservations after runner disconnect while unrelated Worker B completes through public control (I2, I3, I5, I6, I10)",
	() =>
		Effect.gen(function* () {
			const f = yield* gateway("Runner")
			yield* Effect.gen(function* () {
				const address = yield* Control.serve()
				const client = yield* Control.connect(address)
				yield* Effect.addFinalizer(() => TestClock.adjust(100000))
				yield* boot(f, client)
				const change = yield* client.submit({
					instance: "integration",
					target: f.target(2),
					strategy: "Restart",
					budget,
					requirements: { trial: 1000 },
				})
				yield* phase(client, change.id, "Trial")
				yield* f.disconnect
				yield* client.units.pipe(
					Effect.repeat({
						until: (units) =>
							Array.some(
								units,
								(u) =>
									u.instance === "integration" &&
									u.term === 2 &&
									u.cause.reasons.length > 0,
							),
					}),
				)
				yield* TestClock.adjust(30000)
				const result = yield* change.await
				assert.equal(result.outcome, "Stuck", Cause.pretty(result.cause))
				const status = yield* client
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.isAbove(HashSet.size(status.unconfirmedUnits), 0)
				assert.equal(HashSet.size(status.leaseHolders), 0)
				const busy = yield* client
					.submit({
						instance: "integration",
						target: f.target(2),
						strategy: "Restart",
						budget,
					})
					.pipe(Effect.flip)
				assert.equal(busy.reason, "Busy")
				assert.isTrue(Array.contains(busy.conflicts ?? [], "integration"))
				assert.deepEqual(Option.getOrThrow(status.conclusion), result)
				const b = yield* client.submit({
					instance: "unrelated",
					realm: "other",
					realms: [
						{ id: "other", parent: Option.none(), isolated: HashSet.empty() },
					],
					target: f.unrelated,
					budget,
				})
				yield* consistent(client, b.id, "Accepted")
				const repeated = yield* client.handle(change.id).await
				assert.deepEqual(repeated, result)
				const units = yield* client.units
				const residual = Option.getOrThrow(
					Array.findFirst(
						units,
						(u) =>
							u.instance === "integration" &&
							u.term === 2 &&
							u.evidence === "Missing",
					),
				)
				assert.equal(residual.owner, change.id)
				assert.isNotEmpty(residual.claim)

				assert.isTrue(
					Array.some(
						units,
						(u) =>
							u.instance === "integration" &&
							u.term === 2 &&
							u.evidence === "Missing",
					),
				)
			}).pipe(Effect.provide(f.layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)
