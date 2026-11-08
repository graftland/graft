import {
	Array,
	Deferred,
	Effect,
	Layer,
	Queue,
	Ref,
	Sink,
	Stdio,
	Stream,
	type Cause,
} from "effect"
import { assert, it } from "@effect/vitest"

import * as Units from "../src/Units"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
/** A kernel stdio whose stdin the test feeds and whose stdout it records. */
const fixture = Effect.gen(function* () {
	const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
	const written = yield* Ref.make<ReadonlyArray<string>>([])
	const stdio = Stdio.make({
		args: Effect.succeed([]),
		stdin: Stream.fromQueue(stdin),
		stdout: () =>
			Sink.forEach((chunk: string | Uint8Array) =>
				Ref.update(
					written,
					Array.append(
						typeof chunk === "string" ? chunk : decoder.decode(chunk),
					),
				),
			),
		stderr: () => Sink.drain,
	})
	const context = yield* Layer.build(
		Units.stdio.pipe(Layer.provide(Layer.succeed(Stdio.Stdio, stdio))),
	)
	const bridge = yield* Units.StdioBridge.pipe(
		Effect.provideContext(context),
		Effect.flatMap(Effect.fromOption),
	)
	return { stdin, written, bridge }
})
const holder = Effect.fnUntraced(function* (unit: string) {
	const received = yield* Queue.unbounded<string>()
	const ended = yield* Deferred.make<void>()
	return {
		received,
		ended,
		holder: {
			unit,
			incarnation: `${unit}/1`,
			deliver: (input: Units.StdioInput) =>
				Queue.offer(
					received,
					input._tag === "Bytes" ? decoder.decode(input.bytes) : "<end>",
				).pipe(Effect.asVoid),
			ended: Deferred.await(ended),
		} satisfies Units.Holder,
	}
})

it.effect(
	"lends stdio to one live incarnation and keeps input for the next holder",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture
			const a = yield* holder("a")
			const b = yield* holder("b")
			const observed1 = yield* f.bridge.claim(a.holder)
			assert.isTrue(observed1)
			const observed2 = yield* f.bridge.claim(b.holder)
			assert.isFalse(observed2)
			yield* Queue.offer(f.stdin, encoder.encode("first"))
			const observed3 = yield* Queue.take(a.received)
			assert.strictEqual(observed3, "first")
			yield* f.bridge.write("b", "b/1", encoder.encode("ignored"))
			yield* f.bridge.write("a", "a/1", encoder.encode("reply"))
			yield* f.bridge.release("a", "a/1")
			yield* Queue.offer(f.stdin, encoder.encode("kept"))
			const observed4 = yield* f.bridge.claim(b.holder)
			assert.isTrue(observed4)
			const observed5 = yield* Queue.take(b.received)
			assert.strictEqual(observed5, "kept")
			yield* Queue.end(f.stdin)
			const observed6 = yield* Queue.take(b.received)
			assert.strictEqual(observed6, "<end>")
			yield* f.bridge.close("a", "a/1")
			yield* f.bridge.close("b", "b/1")
			yield* f.bridge.closed
			const observed7 = yield* Ref.get(f.written)
			assert.deepStrictEqual(observed7, ["reply"])
		}).pipe(Effect.scoped),
)

it.effect("releases the stdio once the holding incarnation's unit ends", () =>
	Effect.gen(function* () {
		const f = yield* fixture
		const a = yield* holder("a")
		const b = yield* holder("b")
		const observed8 = yield* f.bridge.claim(a.holder)
		assert.isTrue(observed8)
		yield* Deferred.succeed(a.ended, undefined)
		const granted = yield* f.bridge
			.claim(b.holder)
			.pipe(Effect.repeat({ until: (ok) => ok, times: 1000 }))
		assert.isTrue(granted)
	}).pipe(Effect.scoped),
)
