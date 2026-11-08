import { Effect, Ref, Schema, Stream } from "effect"

import { Plugin } from "@graftland/graft"
import { Recorder } from "@graftland/plugin-remote/Recording"

/** A third-party recorder on the same public protocol that stores records but never acknowledges them. */
export default Plugin.make({
	name: "withholding-recorder",
	config: Schema.Struct({ recorder: Schema.String }),
	inject: [Recorder],
	apply: Effect.fn(function* (config) {
		const recorder = yield* Recorder
		const stored = yield* Ref.make(0)
		yield* recorder.records.pipe(
			Stream.runForEach(() => Ref.update(stored, (n) => n + 1)),
			Effect.forkScoped,
		)
		yield* recorder.register(config.recorder)
	}),
})
