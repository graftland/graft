import { Array, Effect, Record, Tracer } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

it.effect("names the fork, plugin and revision on every plugin span", () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	const plugin = Plugin.make({ name: "traced", apply: () => Effect.void })
	return Effect.gen(function* () {
		const fork = yield* Graft.plugin(plugin)
		yield* fork.await
		// A restart, like a replacement, starts a new revision.
		yield* fork.restart
		yield* fork.await
		const attributes = Array.map(
			Array.filter(spans, (span) => span.name === "graft.plugin traced"),
			(span) => Record.fromEntries(span.attributes),
		)
		assert.deepStrictEqual(attributes, [
			{ "graft.fork": fork.id, "graft.plugin": "traced", "graft.revision": 0 },
			{ "graft.fork": fork.id, "graft.plugin": "traced", "graft.revision": 1 },
		])
	}).pipe(run, Effect.withTracer(tracer))
})
