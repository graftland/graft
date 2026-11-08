/** The release recorder: an ordinary unit plugin that holds the recording role through the public protocol. */
import { Effect, HashMap, Ref, Schema, Stream } from "effect"

import { Plugin } from "@graftland/graft"
import type { RecordDuty } from "@graftland/graft/Kernel"
import { Recorder } from "@graftland/plugin-remote/Recording"

export const Config = Schema.Struct({
	/** The recording role named by the deployment's `recording.recorder`. */
	recorder: Schema.String,
})
export type Config = typeof Config.Type

/** Stores each delivered record in unit memory, then acknowledges it. Nothing is durable. */
const store = (
	recorder: Recorder["Service"],
	stored: Ref.Ref<HashMap.HashMap<string, RecordDuty>>,
	record: RecordDuty,
) =>
	Ref.update(stored, HashMap.set(record.id, record)).pipe(
		Effect.andThen(recorder.acknowledge(record)),
	)

export const plugin = Plugin.make({
	name: "@graftland/plugin-release/Recorder",
	config: Config,
	inject: [Recorder],
	apply: Effect.fn(function* (config) {
		const recorder = yield* Recorder
		const stored = yield* Ref.make(HashMap.empty<string, RecordDuty>())
		yield* recorder.records.pipe(
			Stream.runForEach((record) => store(recorder, stored, record)),
			Effect.forkScoped,
		)
		yield* recorder.register(config.recorder)
	}),
})
export default plugin
