import { Array, Effect, HashMap, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { build } from "tsdown"
import { beforeAll } from "vitest"

import { start } from "./fixtures/encoded-channel/kernel"

beforeAll(() =>
	Effect.runPromise(
		Effect.promise(() =>
			build({
				config: false,
				entry: [
					new URL("./fixtures/encoded-channel/worker.ts", import.meta.url)
						.pathname,
				],
				outDir: new URL("../.cache/encoded-channel", import.meta.url).pathname,
				format: "esm",
				platform: "node",
				fixedExtension: false,
				dts: false,
				deps: {
					alwaysBundle: [/^@graftland\//],
					neverBundle: [/^effect(?:\/|$)/],
				},
				inputOptions: {
					resolve: { conditionNames: ["source", "import", "node"] },
				},
			}),
		),
	),
)

describe("Encoded unit channel prototype", () => {
	it.live(
		"routes encoded values and typed errors without importing the contract into the kernel",
		() =>
			Effect.gen(function* () {
				const kernel = yield* start()
				const provider = yield* Effect.fromOption(Array.head(kernel.providers))
				assert.strictEqual(
					kernel.consumer.declaration.identity,
					"@prototype/inspect@1",
				)
				assert.strictEqual(kernel.consumer.declaration.tag, "inspectWire")
				const admitted = yield* kernel.dispatch("value", "success")
				assert.strictEqual(admitted, "Dispatched")
				const dispatched = yield* kernel.consumer.wait("dispatched", "value")
				const started = yield* provider.wait("started", "value")
				const success = yield* kernel.consumer.wait("success", "value")
				assert.isTrue(dispatched.checked)
				assert.isTrue(started.checked)
				assert.isTrue(success.checked)
				yield* provider.wait("exit-sent", "value")
				yield* kernel.dispatch("failure", "error")
				const failure = yield* kernel.consumer.wait("error", "failure")
				assert.isTrue(failure.checked)
				yield* provider.wait("exit-sent", "failure")
			}).pipe(Effect.scoped),
	)

	it.live(
		"rejects conflicting wire tags and contract provenance before connecting data ports",
		() =>
			Effect.forEach(
				[{ tag: "differentWire" }, { build: "different-build" }],
				Effect.fnUntraced(function* (declaration) {
					const kernel = yield* start(["old"], declaration)
					const result = yield* kernel.dispatch("rejected", "success")
					assert.strictEqual(result, "NotAdmitted")
					yield* kernel.consumer.send({ _tag: "Barrier" })
					yield* kernel.consumer.wait("barrier")
					const events = yield* kernel.consumer.trace
					assert.isFalse(
						Array.some(
							events,
							(event) =>
								event.phase === "bound" || event.phase === "dispatched",
						),
					)
				}, Effect.scoped),
			).pipe(Effect.asVoid),
	)

	it.live(
		"stops the client before an ensuring finalizer finishes and retains the remote exit obligation",
		() =>
			Effect.gen(function* () {
				const kernel = yield* start()
				const provider = yield* Effect.fromOption(Array.head(kernel.providers))
				yield* kernel.dispatch("cancel", "ensuring")
				yield* provider.wait("started", "cancel")
				yield* kernel.consumer.send({ _tag: "Cancel", id: "cancel" })
				const stopped = yield* kernel.consumer.wait("client-stopped", "cancel")
				assert.isTrue(stopped.checked)
				yield* provider.wait("cleanup-started", "cancel")
				const blocked = yield* provider.trace
				assert.isFalse(
					Array.some(blocked, (event) => event.phase === "exit-sent"),
				)
				yield* provider.send({ _tag: "Release" })
				yield* provider.wait("exit-sent", "cancel")
				const events = yield* provider.trace
				const phases = Array.map(events, (event) => event.phase)
				assert.isTrue(
					phases.indexOf("cleanup-finished") < phases.indexOf("exit-sent"),
				)
			}).pipe(Effect.scoped),
	)

	it.live("sends the RPC exit before a request scope finalizer finishes", () =>
		Effect.gen(function* () {
			const kernel = yield* start()
			const provider = yield* Effect.fromOption(Array.head(kernel.providers))
			yield* kernel.dispatch("scope", "scope")
			yield* provider.wait("started", "scope")
			yield* kernel.consumer.send({ _tag: "Cancel", id: "scope" })
			yield* kernel.consumer.wait("client-stopped", "scope")
			yield* provider.wait("cleanup-started", "scope")
			const blocked = yield* provider.trace
			assert.isTrue(Array.some(blocked, (event) => event.phase === "exit-sent"))
			assert.isFalse(
				Array.some(blocked, (event) => event.phase === "cleanup-finished"),
			)
			yield* provider.send({ _tag: "Release" })
			yield* provider.wait("cleanup-finished", "scope")
		}).pipe(Effect.scoped),
	)

	it.live(
		"returns a unary result before its request scope cleanup completes",
		() =>
			Effect.gen(function* () {
				const kernel = yield* start()
				const provider = yield* Effect.fromOption(Array.head(kernel.providers))
				yield* kernel.dispatch("result", "scope-success")
				yield* provider.wait("cleanup-started", "result")
				const result = yield* kernel.consumer.wait("success", "result")
				assert.isTrue(result.checked)
				const blocked = yield* provider.trace
				assert.isTrue(
					Array.some(blocked, (event) => event.phase === "exit-sent"),
				)
				assert.isFalse(
					Array.some(blocked, (event) => event.phase === "cleanup-finished"),
				)
				yield* provider.send({ _tag: "Release" })
				yield* provider.wait("cleanup-finished", "result")
			}).pipe(Effect.scoped),
	)

	it.live(
		"distinguishes local rejection from an unknown outcome after provider termination",
		() =>
			Effect.gen(function* () {
				const kernel = yield* start()
				const provider = yield* Effect.fromOption(Array.head(kernel.providers))
				yield* kernel.dispatch("lost", "ensuring")
				yield* provider.wait("started", "lost")
				yield* provider.terminate
				yield* provider.wait("unit-exited")
				const failure = yield* kernel.consumer.wait("unknown", "lost")
				assert.isDefined(failure.diagnostic)
				const outcome = yield* kernel.lostOutcome("lost")
				assert.strictEqual(outcome, "Unknown")
				const rejected = yield* kernel.dispatch("after-death", "success")
				assert.strictEqual(rejected, "NotAdmitted")
				const rejectedOutcome = yield* kernel.lostOutcome("after-death")
				assert.strictEqual(rejectedOutcome, "NotAdmitted")
				const events = yield* provider.trace
				assert.isFalse(
					Array.some(
						events,
						(event) =>
							event.phase === "exit-sent" || event.phase === "cleanup-finished",
					),
				)
				yield* kernel.consumer.wait("client-stopped", "lost")
			}).pipe(Effect.scoped),
	)

	it.live(
		"pins dispatched calls to the old generation while new calls use the new route",
		() =>
			Effect.gen(function* () {
				const kernel = yield* start(["old", "new"])
				const oldProvider = yield* Effect.fromOption(
					Array.get(kernel.providers, 0),
				)
				const newProvider = yield* Effect.fromOption(
					Array.get(kernel.providers, 1),
				)
				yield* kernel.dispatch("old-call", "ensuring")
				yield* oldProvider.wait("started", "old-call")
				yield* kernel.select("new")
				yield* kernel.dispatch("new-call", "success")
				yield* newProvider.wait("started", "new-call")
				const result = yield* kernel.consumer.wait("success", "new-call")
				assert.isTrue(result.checked)
				const selected = yield* kernel.selected
				assert.deepStrictEqual(
					HashMap.get(selected, "old-call"),
					Option.some("old"),
				)
				assert.deepStrictEqual(
					HashMap.get(selected, "new-call"),
					Option.some("new"),
				)
				yield* kernel.consumer.send({ _tag: "Cancel", id: "old-call" })
				yield* kernel.consumer.wait("client-stopped", "old-call")
				yield* oldProvider.wait("cleanup-started", "old-call")
				const blocked = yield* oldProvider.trace
				assert.isFalse(
					Array.some(blocked, (event) => event.phase === "exit-sent"),
				)
				yield* oldProvider.send({ _tag: "Release" })
				yield* oldProvider.wait("exit-sent", "old-call")
			}).pipe(Effect.scoped),
	)
})
