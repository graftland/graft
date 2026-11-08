/** The release recorder: an ordinary unit plugin that holds the recording role through the public protocol. */
import {
	Array,
	Duration,
	Effect,
	FileSystem,
	HashMap,
	Path,
	Ref,
	Schedule,
	Schema,
	Stream,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"

import { Plugin } from "@graftland/graft"
import type { RecordDuty, RecoveredRecords } from "@graftland/graft/Kernel"
import { Recorder } from "@graftland/plugin-remote/Recording"

import * as Journal from "./Journal"

export const Config = Schema.Struct({
	/** The recording role named by the deployment's `recording.recorder`. */
	recorder: Schema.String,
	/** With a directory, each record is appended and synced to the journal there before it is acknowledged. */
	directory: Schema.optionalKey(Schema.String),
	/** How long full rendered causes are retained beside the journal. Default 30 days. */
	diagnosticRetention: Schema.optionalKey(
		Schema.DurationFromString.check(
			Schema.makeFilter(
				(duration) =>
					Duration.isFinite(duration) && !Duration.isNegative(duration),
				{ expected: "a finite nonnegative duration" },
			),
		),
	),
})
export type Config = typeof Config.Type

/** Keeps records in unit memory only; nothing survives the unit. */
const inMemory = Effect.fnUntraced(function* () {
	const stored = yield* Ref.make(HashMap.empty<string, RecordDuty>())
	return (record: RecordDuty) =>
		Ref.update(stored, HashMap.set(record.id, record))
})
/** A record that cannot be stored is never acknowledged; the append is retried while the unit runs. */
const durable = Effect.fnUntraced(function* (
	directory: string,
	diagnosticRetention: Duration.Duration,
) {
	const journal = yield* Journal.open(directory, { diagnosticRetention })
	const lines = yield* journal.lines
	const recovered: RecoveredRecords = {
		keys: Array.flatMap(lines, (line) =>
			line.stage === "Intent" && line.key !== null
				? [
						{
							key: line.key,
							request: line.request,
							run: line.run,
							change: line.change,
						},
					]
				: [],
		),
		unfinished: Array.flatMap(Journal.summarize(lines), (summary) =>
			!summary.concluded && Array.contains(summary.stages, "Intent")
				? [
						{
							run: summary.run,
							change: summary.change,
							members: summary.members,
						},
					]
				: [],
		),
	}
	yield* journal.prune.pipe(
		Effect.andThen(journal.compact),
		Effect.catchTag("JournalError", (error) =>
			Effect.logError("Maintaining the release journal failed", error),
		),
		Effect.repeat(Schedule.spaced("1 hour")),
		Effect.forkScoped,
	)
	if (journal.recovered.truncated > 0)
		yield* Effect.logWarning(
			`Removed a torn final journal line of ${journal.recovered.truncated} bytes`,
		)
	const store = (record: RecordDuty) =>
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
	return { store, recovered }
})

export const plugin = Plugin.make({
	name: "@graftland/plugin-release/Recorder",
	config: Config,
	inject: [
		Recorder,
		FileSystem.FileSystem,
		Path.Path,
		Digest.Digest,
		SecureRandom.SecureRandom,
	],
	apply: Effect.fn(function* (config) {
		const recorder = yield* Recorder
		const durableStore =
			config.directory === undefined
				? undefined
				: yield* durable(
						config.directory,
						config.diagnosticRetention ?? Duration.days(30),
					)
		const store =
			durableStore === undefined ? yield* inMemory() : durableStore.store
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
		if (durableStore === undefined) yield* recorder.register(config.recorder)
		else yield* recorder.register(config.recorder, durableStore.recovered)
	}),
})
export default plugin
