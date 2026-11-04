import { assert, it } from "@effect/vitest"
import { Graft } from "@graftland/graft"
import {
	Array,
	Cause,
	Context,
	Deferred,
	Ref,
	Effect,
	Exit,
	Queue,
	Schema,
	Sink,
	Stream,
} from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import * as Contract from "../src/Contract"
import * as Child from "../src/internal/child"
import * as Runtime from "../src/internal/childRuntime"
import * as Port from "../src/internal/port"
import { TransportError } from "../src/Errors"
import { EndOfStream } from "../src/internal/runner/Framing"

const empty = Contract.make<
	Schema.Codec<unknown, Schema.Json>,
	Schema.Codec<unknown>
>({
	name: "child-failure-test",
	config: Schema.Null,
	error: Schema.Never,
	module: new URL("./fixtures/empty-plugin.ts", import.meta.url).href,
})
class Exported extends Context.Service<Exported, string>()(
	"@graftland/plugin-remote/test/child-failures.test/Exported",
) {}

it.effect(
	"reports a defect in the exported service handler mapping to the host",
	() =>
		Effect.gen(function* () {
			const marker = new Error("handler mapping failed")
			const group = RpcGroup.make(Rpc.make("Ping"))
			const service = Contract.service(Exported, group, {
				toHandlers: () => {
					throw marker
				},
				fromClient: () => "unused",
			})
			const contract = Contract.make({ ...empty, provides: [service] })
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
				peer,
				{ id: "test", generation: 1 },
				telemetry,
			)
			yield* Effect.addFinalizer(() => lifecycle.release)
			yield* lifecycle.load(null)
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
			yield* lifecycle.dispose
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"propagates a child input failure instead of reporting successful termination",
	() =>
		Effect.gen(function* () {
			const marker = TransportError.make({ cause: Cause.fail("read failed") })
			const result = yield* Runtime.run(empty, {
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
			Runtime.run(empty, { input, output: Sink.drain }).pipe(
				Effect.provide(Graft.layer),
			),
	)
}

it.effect("retains writer cleanup failure after normal EOF", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const cleaned = yield* Ref.make(false)
		const result = yield* Runtime.run(empty, {
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
