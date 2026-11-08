/** The release recorder: an ordinary unit plugin that holds the recording role through the public protocol. */
import {
	Effect,
	FileSystem,
	HashMap,
	Path,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"

import { Plugin } from "@graftland/graft"
import type { RecordDuty } from "@graftland/graft/Kernel"
import { Recorder } from "@graftland/plugin-remote/Recording"

import * as Journal from "./Journal"

export const Config = Schema.Struct({
	/** The recording role named by the deployment's `recording.recorder`. */
	recorder: Schema.String,
	/** With a directory, each record is appended and synced to the journal there before it is acknowledged. */
	directory: Schema.optionalKey(Schema.String),
})
export type Config = typeof Config.Type

/** Keeps records in unit memory only; nothing survives the unit. */
const inMemory = Effect.fnUntraced(function* () {
	const stored = yield* Ref.make(HashMap.empty<string, RecordDuty>())
	return (record: RecordDuty) =>
		Ref.update(stored, HashMap.set(record.id, record))
})
/** A record that cannot be stored is never acknowledged; the append is retried while the unit runs. */
const durable = Effect.fnUntraced(function* (directory: string) {
	const journal = yield* Journal.open(directory)
	if (journal.recovered.truncated > 0)
		yield* Effect.logWarning(
			`Removed a torn final journal line of ${journal.recovered.truncated} bytes`,
		)
	return (record: RecordDuty) =>
		journal.append(Journal.fromDuty(record)).pipe(
			Effect.tapError((error) =>
				Effect.logError(
					"Storing a release record failed; it stays unacknowledged",
					error,
				),
			),
			Effect.retry({
				while: (error) => error.reason === "Storage",
				schedule: Schedule.spaced("1 second"),
			}),
			Effect.asVoid,
		)
})

export const plugin = Plugin.make({
	name: "@graftland/plugin-release/Recorder",
	config: Config,
	inject: [Recorder, FileSystem.FileSystem, Path.Path],
	apply: Effect.fn(function* (config) {
		const recorder = yield* Recorder
		const store =
			config.directory === undefined
				? yield* inMemory()
				: yield* durable(config.directory)
		yield* recorder.records.pipe(
			Stream.runForEach((record) =>
				store(record).pipe(
					Effect.andThen(recorder.acknowledge(record)),
					Effect.catchTag("JournalError", (error) =>
						Effect.logError(
							"A release record conflicts with the journal and is not acknowledged",
							error,
						),
					),
				),
			),
			Effect.forkScoped,
		)
		yield* recorder.register(config.recorder)
	}),
})
export default plugin
