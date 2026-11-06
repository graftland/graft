import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Queue,
	Ref,
	Schema,
	Sink,
	Stream,
} from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import * as Contract from "../src/Contract"
import { TransportError } from "../src/Errors"
import * as Child from "../src/internal/child"
import * as Runtime from "../src/internal/childRuntime"
import { prepare } from "../src/internal/contract"
import * as Port from "../src/internal/port"
import { EndOfStream } from "../src/internal/runner/Framing"

const implementation = new URL("./fixtures/empty-plugin.ts", import.meta.url)
	.href
const empty = Contract.make({
	name: "child-failure-test",
	config: Schema.Null,
})
class Exported extends Context.Service<Exported, string>()(
	"@graftland/plugin-remote/test/child-failures.test/Exported",
) {}

it.effect(
	"reports a defect in the exported service handler mapping to the host",
	() =>
		Effect.gen(function* () {
			const marker = new Error("handler mapping failed")
			const group = RpcGroup.make(
				Contract.operation(
					"@graftland/test/child-failures.test/Ping",
					1,
					Rpc.make("Ping"),
				),
			)
			const service = Contract.service(Exported, group, {
				toHandlers: () => {
					throw marker
				},
				fromClient: () => "unused",
			})
			const contract = prepare<
				Schema.Codec<unknown, Schema.Json>,
				Schema.Codec<unknown>
			>(Contract.make({ ...empty, provides: [service] }))
			yield* Graft.provide(Exported, "published")
			const peer = yield* Port.make(
				{ input: Stream.never, output: Sink.drain },
				{
					session: "test",
					serve: { [Exported.key]: group },
					call: {},
				},
			)
			const telemetry = yield* Child.telemetry(contract)
			const lifecycle = yield* Child.lifecycle(
				contract,
				implementation,
				peer,
				{ id: "test", generation: 1 },
				telemetry,
			)
			yield* Effect.addFinalizer(() => lifecycle.release)
			yield* lifecycle.serve(null).pipe(Effect.andThen(lifecycle.ready))
			const event = yield* Queue.take(telemetry.events).pipe(
				Effect.timeout("1 second"),
			)
			assert.strictEqual(event._tag, "Failed")
			assert(event._tag === "Failed")
			assert.isTrue(
				Array.some(
					event.cause.reasons,
					(reason) => reason._tag === "Die" && reason.defect === marker,
				),
			)
			yield* lifecycle.stop
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"propagates a child input failure instead of reporting successful termination",
	() =>
		Effect.gen(function* () {
			const marker = TransportError.make({ cause: Cause.fail("read failed") })
			const result = yield* Runtime.run(empty, implementation, {
				input: Stream.fail(marker),
				output: Sink.drain,
			}).pipe(Effect.exit)
			assert(Exit.isFailure(result))
			assert.include(Cause.pretty(result.cause), "read failed")
		}).pipe(Effect.provide(Graft.layer)),
)

for (const input of [
	Stream.empty,
	Stream.fail(TransportError.make({ cause: Cause.fail(EndOfStream.make({})) })),
]) {
	it.effect(
		`ends a child normally on ${input === Stream.empty ? "EOF" : "normal channel closure"}`,
		() =>
			Runtime.run(empty, implementation, { input, output: Sink.drain }).pipe(
				Effect.provide(Graft.layer),
			),
	)
}

it.effect("retains writer cleanup failure after normal EOF", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const cleaned = yield* Ref.make(false)
		const result = yield* Runtime.run(empty, implementation, {
			input: Stream.fromEffect(Deferred.await(started)).pipe(Stream.drain),
			output: Sink.unwrap(
				Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
					Ref.set(cleaned, true).pipe(
						Effect.andThen(Effect.die("writer-finalizer-failed")),
					),
				).pipe(Effect.as(Sink.drain)),
			),
		}).pipe(Effect.exit)
		const released = yield* Ref.get(cleaned)
		assert.isTrue(released)
		assert(Exit.isFailure(result))
		assert.include(Cause.pretty(result.cause), "writer-finalizer-failed")
	}).pipe(Effect.provide(Graft.layer)),
)

it.effect("retains writer cleanup interruption after normal EOF", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const cleaned = yield* Ref.make(false)
		const result = yield* Runtime.run(empty, implementation, {
			input: Stream.fromEffect(Deferred.await(started)).pipe(Stream.drain),
			output: Sink.unwrap(
				Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
					Ref.set(cleaned, true).pipe(Effect.andThen(Effect.interrupt)),
				).pipe(Effect.as(Sink.drain)),
			),
		}).pipe(Effect.exit)
		const released = yield* Ref.get(cleaned)
		assert.isTrue(released)
		assert(Exit.isFailure(result))
		assert.isTrue(Cause.hasInterruptsOnly(result.cause))
	}).pipe(Effect.provide(Graft.layer)),
)
