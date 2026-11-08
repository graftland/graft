import {
	Array,
	Cause,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel, Plugin } from "@graftland/graft"

import * as Wire from "../src/internal/unitProtocol"
import * as Units from "../src/Units"
import { budget, stage } from "./native-unit-fixture"

const runtime = (target: Kernel.Target, maxUnits = 3) =>
	Kernel.layer({
		authority: "native-test",
		maxUnits,
		instances: [{ id: "a", target }],
	}).pipe(Layer.provide(Units.layer), Layer.provideMerge(NodeServices.layer))

it.effect(
	"serializes a local-only deployment descriptor without importing its module (F2)",
	() =>
		Effect.gen(function* () {
			const target = Units.target({
				artifact: {
					directory: "/fixtures/not-imported",
					identity: {
						version: 1,
						algorithm: "sha256",
						digest:
							"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						module: "plugin.js",
					},
				},
				input: { mode: "test" },
				placement: "Worker",
			})
			const codec = Schema.fromJsonString(Wire.Target)
			const encoded = yield* Schema.encodeEffect(codec)(target)
			const decoded = yield* Schema.decodeEffect(codec)(encoded)
			assert.deepEqual(decoded, target)
			assert.isUndefined(decoded.deployment?.contract)
		}),
)
for (const placement of ["Worker", "Process"] as const) {
	it.live(
		`describes and serves a local-only plugin in a real ${placement} without a contract (F2)`,
		() =>
			Effect.gen(function* () {
				const artifact = yield* stage("none")
				const target = Units.target({
					artifact,
					input: { mode: "test" },
					placement,
				})
				yield* Effect.gen(function* () {
					const kernel = yield* Kernel.Kernel
					const inspected = yield* kernel.inspect({
						instance: "a",
						target,
						budget,
					})
					assert.equal(inspected.exitEvidence, "Exited")
					assert.isTrue(Option.isSome(inspected.result))
					assert.isTrue(
						Option.isSome(inspected.result) &&
							inspected.result.value._tag === "Described",
					)
					if (
						Option.isNone(inspected.result) ||
						inspected.result.value._tag !== "Described"
					)
						return
					assert.deepEqual(
						inspected.result.value.description.members[0]?.requires,
						[],
					)
					assert.deepEqual(
						inspected.result.value.description.members[0]?.provides,
						[],
					)
					const accepted = yield* Change.run({
						operations: [{ _tag: "Deploy", instance: "a", target }],
						strategy: "Restart",
						budget,
					})
					assert.equal(
						accepted.outcome,
						"Accepted",
						Cause.pretty(accepted.cause),
					)
					const units = yield* kernel.units
					assert.equal(
						Array.filter(
							units,
							(u) => u.kind === "Execution" && u.evidence === "Missing",
						).length,
						1,
					)
				}).pipe(Effect.provide(runtime(target)))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		15000,
	)
	for (const fault of ["import", "decode"] as const) {
		it.live(
			`terminates a local-only ${placement} blocked in ${fault} and retains preparation evidence (F2)`,
			() =>
				Effect.gen(function* () {
					const artifact = yield* stage(fault)
					const target = Units.target({
						artifact,
						input: { mode: "test" },
						placement,
					})
					yield* Effect.gen(function* () {
						const kernel = yield* Kernel.Kernel
						const submission = yield* kernel
							.inspect({
								instance: "a",
								target,
								budget: { ...budget, startup: 1500 },
							})
							.pipe(Effect.exit, Effect.forkScoped)
						const inspected = yield* Stream.runHead(kernel.preparations)
						assert.isTrue(Option.isSome(inspected))
						const unknown = yield* kernel.get("not-a-change")
						assert.isTrue(Option.isNone(unknown))
						const result = yield* Fiber.join(submission)
						assert.equal(result._tag, "Failure")
						const facts = yield* kernel.inspections
						assert.isTrue(
							Array.every(
								facts,
								(p) =>
									p.exitEvidence === "Exited" &&
									HashSet.size(p.unconfirmedUnits) === 0,
							),
						)
						const units = yield* kernel.units
						assert.isTrue(
							Array.some(
								units,
								(u) =>
									u.progress ===
									(fault === "import" ? "DescribeImport" : "DescribeDecode"),
							),
						)
					}).pipe(Effect.provide(runtime(target)))
				}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
			15000,
		)
		it.live(
			`terminates a real ${placement} blocked in ${fault} before admission and keeps the kernel responsive (I2, I4, I5, I11)`,
			() =>
				Effect.gen(function* () {
					const artifact = yield* stage(fault)
					const target = Units.target({
						artifact,
						contract: "contract.js",
						input: { mode: "test" },
						placement,
					})
					yield* Effect.gen(function* () {
						const kernel = yield* Kernel.Kernel
						const submission = yield* Change.submit({
							operations: [{ _tag: "Deploy", instance: "a", target }],
							budget: { ...budget, startup: 1500 },
						}).pipe(Effect.exit, Effect.forkScoped)
						const inspected = yield* Stream.runHead(kernel.preparations)
						assert.isTrue(Option.isSome(inspected))
						const missing = yield* Change.get("not-a-change")
						assert.isTrue(Option.isNone(missing))
						const result = yield* Fiber.join(submission)
						assert.isTrue(result._tag === "Failure")
						if (result._tag !== "Failure") return
						const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
						assert.equal(error.reason, "DescriptionFailed")
						const facts = yield* kernel.inspections
						const units = yield* kernel.units
						assert.isTrue(
							Array.some(
								units,
								(u) =>
									u.progress ===
									(fault === "import" ? "DescribeImport" : "DescribeDecode"),
							),
						)
						assert.isTrue(Array.some(facts, (p) => p.exitEvidence === "Exited"))
						assert.isTrue(
							Array.every(facts, (p) => HashSet.size(p.unconfirmedUnits) === 0),
						)
					}).pipe(Effect.provide(runtime(target)))
				}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
			15000,
		)
	}
	it.live(
		`a real ${placement} describes without activation and exposes a granted execution term (I2, I4, I11)`,
		() =>
			Effect.gen(function* () {
				const artifact = yield* stage("none")
				const target = Units.target({
					artifact,
					contract: "contract.js",
					input: { mode: "test" },
					placement,
				})
				yield* Effect.gen(function* () {
					const kernel = yield* Kernel.Kernel
					const inspected = yield* kernel.inspect({
						instance: "a",
						target,
						budget,
					})
					assert.equal(inspected.exitEvidence, "Exited")
					const handle = yield* Change.submit({
						operations: [{ _tag: "Deploy", instance: "a", target }],
						strategy: "Restart",
						budget,
					})
					const outcome = yield* handle.await
					assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
					const current = yield* Change.get(handle.id)
					const status = Option.getOrThrow(current)
					assert.isTrue(
						Option.getOrThrow(HashMap.get(status.members, "a")).healthy,
					)
					const units = yield* kernel.units
					assert.isTrue(
						Array.some(
							units,
							(u) =>
								Option.exists(
									HashMap.get(u.members, "a"),
									(member) => member.term === 1,
								) && u.evidence === "Missing",
						),
					)
				}).pipe(Effect.provide(runtime(target)))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		15000,
	)
	it.live(
		`terminates a real ${placement} whose embedded finalizer cannot finish (I5, I6, I7)`,
		() =>
			Effect.gen(function* () {
				const old = yield* stage("finalizer")
				const next = yield* stage("none")
				const original = Units.target({
					artifact: old,
					contract: "contract.js",
					input: { mode: "test" },
					placement,
				})
				const target = Units.target({
					artifact: next,
					contract: "contract.js",
					input: { mode: "test" },
					placement,
				})
				yield* Effect.gen(function* () {
					const initial = yield* Change.run({
						operations: [{ _tag: "Deploy", instance: "a", target: original }],
						strategy: "Restart",
						budget,
					})
					assert.equal(initial.outcome, "Accepted", Cause.pretty(initial.cause))
					const result = yield* Change.run({
						operations: [{ _tag: "Deploy", instance: "a", target }],
						strategy: "Overlap",
						budget: { ...budget, stop: 100 },
					})
					assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
					const kernel = yield* Kernel.Kernel
					const units = yield* kernel.units
					assert.isTrue(
						Array.some(
							units,
							(u) =>
								Option.exists(
									HashMap.get(u.members, "a"),
									(member) => member.term === 1,
								) &&
								u.evidence === "Exited" &&
								u.cleanup._tag === "Unknown",
						),
					)
					assert.equal(
						Option.getOrThrow(HashMap.get(result.members, "a")).actual.pipe(
							Option.map((t) => t.identity),
							Option.getOrElse(() => "Missing"),
						),
						target.identity,
					)
				}).pipe(Effect.provide(runtime(original)))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		15000,
	)
}
it.effect("embedded callers cannot manufacture a kernel term (I12)", () =>
	Effect.gen(function* () {
		const error = yield* Plugin.term.pipe(Effect.flip)
		assert.equal(error._tag, "UnitOnly")
	}),
)

it.live(
	"runner disconnect is not native exit and retains execution ownership (I5, I6)",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage("none")
			const owner = yield* Units.serveRunner({
				socket: new URL("../.cache/native-tests/runner.sock", import.meta.url)
					.pathname,
				owner: "test-runner",
			})
			const target = Units.target({
				artifact,
				contract: "contract.js",
				input: { mode: "test" },
				placement: "Runner",
				runner: owner.address,
			})
			yield* Effect.gen(function* () {
				const kernel = yield* Kernel.Kernel
				const accepted = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "a", target }],
					strategy: "Restart",
					budget,
				})
				assert.equal(accepted.outcome, "Accepted", Cause.pretty(accepted.cause))
				yield* owner.disconnect
				while (true) {
					const units = yield* kernel.units
					if (
						Array.some(
							units,
							(u) => u.kind === "Execution" && u.cause.reasons.length > 0,
						)
					) {
						assert.isTrue(
							Array.some(
								units,
								(u) => u.kind === "Execution" && u.evidence === "Missing",
							),
						)
						break
					}
					yield* Effect.yieldNow
				}
			}).pipe(Effect.provide(runtime(target)))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"reuses a verified description for Restart at full native capacity (I2, I11)",
	() =>
		Effect.gen(function* () {
			const artifact = yield* stage("none")
			const target = Units.target({
				artifact,
				contract: "contract.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			yield* Effect.gen(function* () {
				const first = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "a", target }],
					strategy: "Restart",
					budget,
				})
				assert.equal(first.outcome, "Accepted", Cause.pretty(first.cause))
				const second = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "a", target }],
					strategy: "Restart",
					budget,
				})
				assert.equal(second.outcome, "Accepted", Cause.pretty(second.cause))
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				assert.equal(
					Array.filter(units, (u) => u.evidence === "Missing").length,
					1,
				)
				assert.equal(
					Array.filter(units, (u) => u.kind === "Inspection").length,
					1,
				)
			}).pipe(Effect.provide(runtime(target, 1)))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)
