import { createServer, type Socket } from "node:net"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	Fiber,
	FiberSet,
	HashMap,
	HashSet,
	Layer,
	Option,
	Stream,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Units from "../src/Units"
import { budget, fixture } from "./unit-binding-fixture"

it.live(
	"preserves encoded contracts and the provider activation Context between members sharing one native unit (I3, I6, I7)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const provider = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const consumer = Units.target({
				artifact: f.consumer,
				contractArtifact: f.contractArtifact,
				contract: "consumer.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const layer = Kernel.layer({
				authority: "co-resident-contract",
				maxUnits: 4,
				instances: [],
				bindings: [
					{
						provider: "provider",
						consumer: "consumer",
						service: "fixture/Weather",
					},
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				const first = yield* Change.run({
					operations: [
						{ _tag: "Deploy", instance: "provider", target: provider },
					],
					budget,
				})
				assert.equal(first.outcome, "Accepted", Cause.pretty(first.cause))
				const result = yield* Change.run({
					operations: [
						{
							_tag: "Deploy",
							instance: "provider",
							target: provider,
							colocate: ["shared-contract"],
						},
						{
							_tag: "Deploy",
							instance: "consumer",
							target: consumer,
							colocate: ["shared-contract"],
						},
					],
					budget,
				})
				assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				const serving = Array.filter(
					units,
					(unit) => unit.kind === "Execution" && unit.evidence === "Missing",
				)
				assert.equal(serving.length, 1)
				assert.equal(
					HashMap.size(Option.getOrThrow(Array.head(serving)).members),
					2,
				)
				const calls = yield* kernel.calls
				assert.isTrue(
					Array.some(
						calls,
						(call) =>
							call.consumerMember === "consumer" &&
							call.providerMember === "provider" &&
							call.consumer === call.provider &&
							call.result === "Received" &&
							Option.isSome(call.completion),
					),
				)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	30000,
)

for (const placement of ["Worker", "Process", "Runner"] as const)
	it.live(
		`encoded ${placement} dependency calls preserve codecs, typed errors, provider Context and Scope during candidate startup (I4, I8, I12)`,
		() =>
			Effect.gen(function* () {
				const f = yield* fixture()
				const runner =
					placement === "Runner"
						? yield* Units.serveRunner({
								owner: "bindings-runner",
								socket: f.directory + "/runner.sock",
							})
						: undefined
				const provider = Units.target({
					artifact: f.provider,
					contractArtifact: f.contractArtifact,
					contract: "provider.js",
					input: { mode: "test" },
					placement,
					...(runner === undefined ? {} : { runner: runner.address }),
				})
				const consumer = Units.target({
					artifact: f.consumer,
					contractArtifact: f.contractArtifact,
					contract: "consumer.js",
					input: { mode: "test" },
					placement: placement === "Worker" ? "Process" : "Worker",
				})
				const layer = Kernel.layer({
					authority: "bindings-" + placement,
					maxUnits: 4,
					instances: [
						{ id: "provider", target: provider },
						{ id: "consumer", target: consumer },
					],
					bindings: [
						{
							consumer: "consumer",
							provider: "provider",
							service: "fixture/Weather",
						},
					],
				}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
				yield* Effect.gen(function* () {
					const first = yield* Change.run({
						operations: [
							{ _tag: "Deploy", instance: "provider", target: provider },
						],
						strategy: "Restart",
						budget,
					})
					assert.equal(first.outcome, "Accepted", Cause.pretty(first.cause))
					const next = yield* Change.run({
						operations: [
							{ _tag: "Deploy", instance: "provider", target: provider },
						],
						strategy: "Restart",
						budget,
					})
					assert.equal(next.outcome, "Accepted", Cause.pretty(next.cause))
					const started = yield* Change.run({
						operations: [
							{ _tag: "Deploy", instance: "consumer", target: consumer },
						],
						strategy: "Restart",
						budget,
					})
					assert.equal(started.outcome, "Accepted", Cause.pretty(started.cause))
					assert.isTrue(
						Option.getOrThrow(HashMap.get(started.members, "consumer")).healthy,
					)
				}).pipe(Effect.provide(layer))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		45000,
	)

it.live(
	"rejects malformed operation metadata inside Describe before granting execution (I4, I12)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture(true)
			const target = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const layer = Kernel.layer({
				authority: "invalid-declaration",
				maxUnits: 2,
				instances: [{ id: "provider", target }],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				const rejected = yield* Change.submit({
					operations: [{ _tag: "Deploy", instance: "provider", target }],
					budget,
				}).pipe(Effect.flip)
				assert.equal(rejected.reason, "DescriptionFailed")
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				assert.equal(
					Array.filter(units, (u) => u.kind === "Execution").length,
					0,
				)
				const facts = yield* kernel.inspections
				assert.isTrue(Array.every(facts, (p) => p.exitEvidence === "Exited"))
				assert.include(
					Cause.pretty(facts[0]?.cause ?? Cause.empty),
					"InvalidIdentity",
				)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"installs one changed dependency without replacing another binding in the same consumer (I3, I8)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture(false, true)
			const a = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const b = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider-alt.js",
				input: { mode: "alt" },
				placement: "Worker",
			})
			const c = Units.target({
				artifact: f.consumer,
				contractArtifact: f.contractArtifact,
				contract: "consumer.js",
				input: { mode: "test" },
				placement: "Process",
			})
			const layer = Kernel.layer({
				authority: "partial-binding",
				maxUnits: 5,
				instances: [
					{ id: "a", target: a },
					{ id: "b", target: b },
					{ id: "c", target: c },
				],
				bindings: [
					{ consumer: "c", provider: "a", service: "fixture/Weather" },
					{ consumer: "c", provider: "b", service: "fixture/WeatherAlt" },
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				for (const [instance, target] of [
					["a", a],
					["a", a],
					["b", b],
					["c", c],
				] satisfies ReadonlyArray<readonly [string, Kernel.Target]>) {
					const result = yield* Change.run({
						operations: [{ _tag: "Deploy", instance, target }],
						strategy: "Restart",
						budget,
					})
					assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
				}
				const next = Units.target({
					artifact: f.provider,
					contractArtifact: f.contractArtifact,
					contract: "provider.js",
					input: { mode: "upgrade" },
					placement: "Worker",
				})
				const result = yield* Change.run({
					operations: [{ _tag: "Deploy", instance: "a", target: next }],
					strategy: "Overlap",
					budget,
				})
				assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				assert.isTrue(
					Array.some(
						units,
						(u) =>
							HashMap.has(u.members, "c") &&
							u.kind === "Execution" &&
							u.evidence === "Missing",
					),
				)
				assert.isTrue(
					Array.some(
						units,
						(u) =>
							HashMap.has(u.members, "b") &&
							u.kind === "Execution" &&
							u.evidence === "Missing",
					),
				)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)

const cleanupBarrier = Effect.fnUntraced(function* () {
	const closing = yield* Deferred.make<Socket>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((socket) =>
				socket.once("data", () => run(Deferred.succeed(closing, socket))),
			),
		),
		(server) =>
			Effect.sync(() => {
				server.close()
			}),
	)
	yield* Effect.callback<void>((resume) => {
		server.once("error", (cause) => resume(Effect.die(cause)))
		server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.void))
	})
	const address = yield* Effect.sync(() => server.address())
	if (address === null || typeof address === "string")
		return yield* Effect.die("Expected cleanup barrier address")
	return {
		port: address.port,
		closing: Deferred.await(closing),
		release: Effect.gen(function* () {
			const done = yield* Deferred.isDone(closing)
			if (!done) return
			const socket = yield* Deferred.await(closing)
			yield* Effect.sync(() => socket.write("release\n"))
		}),
	}
})
it.live(
	"retains a received native result through blocked owned cleanup and drains it before old-unit exit (I5, I8, I9)",
	() =>
		Effect.gen(function* () {
			const barrier = yield* cleanupBarrier()
			const f = yield* fixture(false, false, barrier.port)
			const provider = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "scope" },
				placement: "Worker",
			})
			const consumer = Units.target({
				artifact: f.consumer,
				contractArtifact: f.contractArtifact,
				contract: "consumer.js",
				input: { mode: "test" },
				placement: "Process",
			})
			const layer = Kernel.layer({
				authority: "owned-cleanup",
				maxUnits: 4,
				instances: [
					{ id: "provider", target: provider },
					{ id: "consumer", target: consumer },
				],
				bindings: [
					{
						consumer: "consumer",
						provider: "provider",
						service: "fixture/Weather",
					},
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				for (const instance of ["provider", "provider", "consumer"]) {
					const outcome = yield* Change.run({
						operations: [
							{
								_tag: "Deploy",
								instance,
								target: instance === "consumer" ? consumer : provider,
							},
						],
						strategy: "Restart",
						budget,
					})
					assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				}
				yield* barrier.closing
				const kernel = yield* Kernel.Kernel
				const before = yield* kernel.calls
				const held = Array.findFirst(before, (c) => c.credit).pipe(
					Option.getOrThrow,
				)
				assert.equal(held.result, "Received")
				const watching = yield* kernel.changes.pipe(
					Stream.filter((s) => s.phase === "Draining"),
					Stream.runHead,
					Effect.forkScoped,
				)
				const target = Units.target({
					artifact: f.provider,
					contractArtifact: f.contractArtifact,
					contract: "provider.js",
					input: { mode: "upgrade" },
					placement: "Worker",
				})
				const change = yield* Change.submit({
					operations: [{ _tag: "Deploy", instance: "provider", target }],
					strategy: "Overlap",
					budget: { ...budget, total: 60000, drain: 10000 },
				})
				const draining = yield* Fiber.join(watching)
				assert.equal(Option.getOrThrow(draining).id, change.id)
				const status = yield* kernel
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.equal(HashSet.size(status.outstandingCalls), 1)
				yield* barrier.release
				const outcome = yield* change.await
				assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				const after = yield* kernel
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.equal(HashSet.size(after.outstandingCalls), 0)
				assert.equal(HashSet.size(after.unconfirmedUnits), 0)
				const units = yield* kernel.units
				assert.equal(
					Array.findFirst(units, (u) => u.id === held.provider).pipe(
						Option.getOrThrow,
					).evidence,
					"Exited",
				)
			}).pipe(Effect.provide(layer), Effect.ensuring(barrier.release))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)

it.live(
	"rejects nested cross-unit completion before dispatching the second hop (I9, I12)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const target = (
				artifact: Artifact.Artifact,
				contract: string,
				mode: string,
			) =>
				Units.target({
					artifact,
					contractArtifact: f.contractArtifact,
					contract,
					input: { mode },
					placement: "Worker",
				})
			const b = target(f.provider, "provider-alt.js", "alt")
			const a = target(f.nested, "nested.js", "nested")
			const consumer = target(f.consumer, "consumer.js", "test")
			const layer = Kernel.layer({
				authority: "nested",
				maxUnits: 4,
				instances: [
					{ id: "b", target: b },
					{ id: "a", target: a },
					{ id: "consumer", target: consumer },
				],
				bindings: [
					{ consumer: "a", provider: "b", service: "fixture/WeatherAlt" },
					{ consumer: "consumer", provider: "a", service: "fixture/Weather" },
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				for (const [instance, target] of [
					["b", b],
					["a", a],
				] satisfies ReadonlyArray<readonly [string, Kernel.Target]>) {
					const outcome = yield* Change.run({
						operations: [{ _tag: "Deploy", instance, target }],
						strategy: "Restart",
						budget,
					})
					assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				}
				const outcome = yield* Change.run({
					operations: [
						{ _tag: "Deploy", instance: "consumer", target: consumer },
					],
					strategy: "Restart",
					budget,
				})
				assert.equal(outcome.outcome, "RecoveryFailed")
				assert.include(Cause.pretty(outcome.cause), "NestedCompletion")
				const kernel = yield* Kernel.Kernel
				const calls = yield* kernel.calls
				assert.isFalse(
					Array.some(calls, (c) => c.service === "fixture/WeatherAlt"),
				)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)

it.live(
	"retains runner call credit and Stuck evidence after control disconnect without native exit (I5, I9, I10)",
	() =>
		Effect.gen(function* () {
			const barrier = yield* cleanupBarrier()
			const f = yield* fixture(false, false, barrier.port)
			const runner = yield* Units.serveRunner({
				socket: f.directory + "/loss.sock",
				owner: "runner-call-loss",
			})
			const provider = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "scope" },
				placement: "Runner",
				runner: runner.address,
			})
			const consumer = Units.target({
				artifact: f.consumer,
				contractArtifact: f.contractArtifact,
				contract: "consumer.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const layer = Kernel.layer({
				authority: "runner-call-loss",
				maxUnits: 4,
				instances: [
					{ id: "provider", target: provider },
					{ id: "consumer", target: consumer },
				],
				bindings: [
					{
						consumer: "consumer",
						provider: "provider",
						service: "fixture/Weather",
					},
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				for (const instance of ["provider", "provider", "consumer"]) {
					const outcome = yield* Change.run({
						operations: [
							{
								_tag: "Deploy",
								instance,
								target: instance === "consumer" ? consumer : provider,
							},
						],
						strategy: "Restart",
						budget,
					})
					assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				}
				yield* barrier.closing
				const kernel = yield* Kernel.Kernel
				const watcher = yield* kernel.changes.pipe(
					Stream.filter((s) => s.phase === "Draining"),
					Stream.runHead,
					Effect.forkScoped,
				)
				const change = yield* Change.submit({
					operations: [
						{ _tag: "Deploy", instance: "provider", target: provider },
					],
					strategy: "Restart",
					budget: { ...budget, drain: 300, stop: 300, terminate: 300 },
				})
				yield* Fiber.join(watcher)
				yield* runner.disconnect
				const result = yield* change.await
				assert.equal(result.outcome, "Stuck", Cause.pretty(result.cause))
				const status = yield* kernel
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.equal(HashSet.size(status.outstandingCalls), 1)
				assert.equal(HashSet.size(status.unconfirmedUnits), 1)
				const calls = yield* kernel.calls
				assert.isTrue(
					Array.some(calls, (c) => c.credit && c.result === "Received"),
				)
				const units = yield* kernel.units
				assert.equal(
					Array.findFirst(units, (u) => u.id === "provider@2").pipe(
						Option.getOrThrow,
					).evidence,
					"Missing",
				)
				yield* barrier.release
			}).pipe(Effect.provide(layer), Effect.ensuring(barrier.release))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)
