import { Context, Effect, Ref, Tracer } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Exporter } from "@fixture/plugin-otlp/Exporter"

const State = Context.Service("loader/fixture/extensions-fixed-7584")
export default Plugin.make({
	inject: [State],
	name: "test/fixedExporter",
	apply: (...args) =>
		Effect.flatMap(State, ({ starts }) =>
			Effect.fnUntraced(function* () {
				yield* Ref.update(starts, (n) => n + 1)
				yield* Graft.provide(Exporter, Tracer.nativeTracer)
			})(...args),
		),
})
