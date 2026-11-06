import { Cause, Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { config, service, Value } from "./unit-contract"

export default Plugin.make({
	name: "actual-implementation",
	config,
	provides: [service],
	overlap: true,
	apply: Effect.fnUntraced(function* ({ value, wait, hangStop }) {
		const count = yield* Ref.make(0)
		yield* Plugin.probe(
			"health",
			Ref.update(count, (n) => n + 1),
		)
		yield* Plugin.probe(
			"broken",
			Effect.failCause(
				Cause.combine(Cause.fail("unhealthy"), Cause.die("probe defect")),
			),
		)
		if (hangStop) yield* Effect.addFinalizer(() => Effect.never)
		if (wait) return yield* Effect.never
		if (value === "fail") return yield* Effect.fail("Serving failed")
		if (value === "missing") {
			yield* Plugin.fork(
				Effect.sleep("10 millis").pipe(
					Effect.andThen(Effect.fail("Export unavailable")),
				),
			)
			return
		}
		yield* Graft.provide(Value, {
			read: Ref.get(count).pipe(Effect.map((probes) => ({ value, probes }))),
		})
	}),
})
