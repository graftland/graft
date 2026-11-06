import { Cause, Deferred, Effect, Exit, Fiber, Ref, Schema } from "effect"
import { RpcClientError } from "effect/rpc"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import type { Manifest } from "@graftland/graft"

import * as Conformance from "../src/Conformance"

const entry: Manifest.Entry = {
	implementation: "index.js",
	contracts: [],
	requirements: {
		placements: ["Worker"],
		filesystem: false,
		nativeModules: false,
	},
	probes: ["health"],
	services: {
		required: [],
		optional: [],
		implements: [{ key: "example/Reader", operations: ["example/read@1"] }],
	},
	operations: [],
}
const request = { operation: "example/read@1", payload: {} }
const suite: Conformance.Suite = {
	entry,
	examples: [{ ...request, expected: { _tag: "Success", value: "ok" } }],
	cancellation: { request, started: request, released: request },
}
const session: Conformance.Session = {
	operations: [request.operation],
	terminate: Effect.void,
	call: () => Effect.succeed(Exit.succeed("ok")),
	roundTrip: () => Effect.void,
	equal: () => Effect.succeed(true),
	probe: () => Effect.void,
}
it.effect(
	"round trips non-JSON contract values through the portable codec",
	() =>
		Effect.all(
			[
				Conformance.roundTrip(Schema.BigInt, 123n),
				Conformance.roundTrip(Schema.Uint8Array, new Uint8Array([0, 255, 42])),
			],
			{ discard: true },
		),
)
it.effect("rejects a value outside its declared codec", () =>
	Effect.gen(function* () {
		const result = yield* Effect.result(Conformance.roundTrip(Schema.Int, 1.5))
		assert.equal(result._tag, "Failure")
	}),
)
it.effect("a failing declared probe preserves its complete cause", () =>
	Effect.gen(function* () {
		const result = yield* Effect.flip(
			Conformance.run(
				{
					...session,
					probe: () =>
						Conformance.ConformanceError.make({
							message: "Probe failed",
							cause: Cause.combine(Cause.fail("offline"), Cause.die("broken")),
						}),
				},
				suite,
			),
		)
		assert.include(Cause.pretty(Cause.fail(result)), "offline")
		assert.include(Cause.pretty(Cause.fail(result)), "broken")
	}).pipe(Effect.scoped),
)
it.effect(
	"does not accept an already completed call as evidence of cancellation",
	() =>
		Effect.gen(function* () {
			const result = yield* Effect.result(Conformance.run(session, suite))
			assert.equal(result._tag, "Failure")
		}).pipe(Effect.scoped),
)
it.effect("rejects missing operation coverage", () =>
	Effect.gen(function* () {
		const result = yield* Effect.flip(
			Conformance.run(session, {
				...suite,
				entry: {
					...entry,
					services: {
						...entry.services,
						implements: [{ key: "example/Reader", operations: ["other@1"] }],
					},
				},
			}),
		)
		assert.include(Cause.pretty(Cause.fail(result)), "Missing conformance case")
	}).pipe(Effect.scoped),
)
it.effect("distinguishes business errors from a successful response", () =>
	Effect.gen(function* () {
		const result = yield* Effect.flip(
			Conformance.run(session, {
				...suite,
				examples: [
					{
						...request,
						expected: { _tag: "BusinessError", value: "rejected" },
					},
				],
			}),
		)
		assert.include(Cause.pretty(Cause.fail(result)), "Expected failure")
	}).pipe(Effect.scoped),
)
it.effect("cancellation observes the handler finalizer before passing", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const released = yield* Deferred.make<void>()
		const terminated = yield* Ref.make(false)
		const controlled: Conformance.Session = {
			...session,
			terminate: Ref.set(terminated, true),
			call: (request) =>
				Ref.get(terminated).pipe(
					Effect.flatMap((closed) =>
						closed
							? Effect.succeed(
									Exit.fail(
										RpcClientError.RpcClientError.make({
											reason: RpcClientError.RpcClientDefect.make({
												message: "Unit has exited",
												cause: "Terminated",
											}),
										}),
									),
								)
							: request.payload === "wait"
								? Deferred.succeed(started, undefined).pipe(
										Effect.andThen(Effect.never),
										Effect.ensuring(Deferred.succeed(released, undefined)),
										Effect.exit,
									)
								: request.payload === "started"
									? Deferred.await(started).pipe(Effect.as(Exit.void))
									: request.payload === "released"
										? Deferred.await(released).pipe(Effect.as(Exit.void))
										: session.call(request),
					),
				),
		}
		yield* Conformance.run(controlled, {
			...suite,
			cancellation: {
				request: { ...request, payload: "wait" },
				started: { ...request, payload: "started" },
				released: { ...request, payload: "released" },
			},
		})
		const closed = yield* Deferred.isDone(released)
		assert.isTrue(closed)
	}).pipe(Effect.scoped),
)
it.effect(
	"preserves a request finalizer defect instead of accepting interruption alone",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const controlled: Conformance.Session = {
				...session,
				call: (request) =>
					request.payload === "wait"
						? Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
								Effect.ensuring(Effect.die("Request cleanup broke")),
							)
						: Deferred.await(started).pipe(Effect.as(Exit.void)),
			}
			const result = yield* Effect.flip(
				Conformance.run(controlled, {
					...suite,
					examples: [],
					cancellation: {
						request: { ...request, payload: "wait" },
						started: { ...request, payload: "started" },
						released: { ...request, payload: "released" },
					},
				}),
			)
			assert.include(Cause.pretty(Cause.fail(result)), "Request cleanup broke")
		}).pipe(Effect.scoped),
)

for (const kind of ["Success", "BusinessError"] as const) {
	it.effect(
		`bounds the ${kind} equality comparison and identifies the operation`,
		() =>
			Effect.gen(function* () {
				const comparing = yield* Deferred.make<void>()
				const interrupted = yield* Ref.make(false)
				const fiber = yield* Effect.forkScoped(
					Conformance.run(
						{
							...session,
							call: () =>
								Effect.succeed(
									kind === "Success"
										? Exit.succeed("ok")
										: Exit.fail("rejected"),
								),
							equal: () =>
								Deferred.succeed(comparing, undefined).pipe(
									Effect.andThen(Effect.never),
									Effect.onInterrupt(() => Ref.set(interrupted, true)),
								),
						},
						{
							...suite,
							timeout: "5 millis",
							examples: [
								{
									...request,
									expected: {
										_tag: kind,
										value: kind === "Success" ? "ok" : "rejected",
									},
								},
							],
						},
					).pipe(Effect.flip),
				)
				yield* Deferred.await(comparing)
				yield* TestClock.adjust("5 millis")
				assert.isDefined(
					fiber.pollUnsafe(),
					"The stage deadline must complete without an outer timeout",
				)
				const failure = yield* Fiber.join(fiber)
				const detail = Cause.pretty(Cause.fail(failure))
				assert.include(detail, request.operation)
				assert.include(
					detail,
					kind === "Success"
						? "Success comparison"
						: "Business-error comparison",
				)
				assert.include(detail, "deadline")
				const wasInterrupted = yield* Ref.get(interrupted)
				assert.isTrue(wasInterrupted)
			}).pipe(Effect.scoped),
	)
}
