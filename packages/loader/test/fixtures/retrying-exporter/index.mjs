import {
	Context,
	Deferred,
	Duration,
	Effect,
	Option,
	Ref,
	Schedule,
	Tracer,
} from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Exporter } from "@fixture/plugin-otlp/Exporter"

const RetryGate = Context.Reference("otlp/retry-gate", {
	defaultValue: () => Option.none(),
})
const State = Context.Service("otlp/retrying-exporter")
export default Plugin.make({
	inject: [State],
	name: "test/retryingExporter",
	retry: Schedule.fromStep(
		Effect.succeed(() =>
			Effect.gen(function* () {
				const gate = yield* RetryGate
				const { retrying, resume } = yield* Effect.fromOption(gate)
				yield* Deferred.succeed(retrying, undefined)
				yield* Deferred.await(resume)
				return [0, Duration.zero]
			}),
		),
	),
	apply: () =>
		Effect.gen(function* () {
			const { attempts, phase, started } = yield* State
			const attempt = yield* Ref.getAndUpdate(attempts, (n) => n + 1)
			if (attempt === 0 && phase === "startup")
				return yield* Effect.fail("exporter startup failure")
			yield* Graft.provide(
				Exporter,
				Tracer.make({ span: Tracer.nativeTracer.span }),
			)
			if (attempt === 0)
				yield* Plugin.fork(
					Deferred.await(started).pipe(
						Effect.andThen(Effect.fail("exporter task failure")),
					),
				)
		}),
})
