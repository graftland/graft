/** The release recorder's append-only journal: each record is on disk before it is acknowledged. */
import {
	Array,
	ByteSize,
	Cause,
	Clock,
	Duration,
	Effect,
	FileSystem,
	HashMap,
	HashSet,
	Option,
	Order,
	Path,
	PlatformError,
	Ref,
	Schema,
	Semaphore,
	String,
	type Scope,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"

import type { RecordDuty } from "@graftland/graft/Kernel"

export class JournalError extends Schema.TaggedError<
	JournalError,
	{ readonly brand: unique symbol }
>()("JournalError", {
	reason: Schema.Literals(["Corrupt", "Conflict", "Storage"]),
	detail: Schema.String,
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}

const Stage = Schema.Literals(["Intent", "Commit", "Conclusion"])
/** A record received from the kernel, before its diagnostic is stored separately. */
export const Line = Schema.Struct({
	id: Schema.String,
	/** The kernel run; a Change id is unique only within its run. */
	run: Schema.String,
	change: Schema.String,
	stage: Stage,
	content: Schema.String,
	members: Schema.Array(Schema.String),
	targets: Schema.Array(Schema.String),
	outcome: Schema.NullOr(Schema.String),
	/** Each member's desired and actual target identity, health and what the attempt did with it. */
	facts: Schema.Array(
		Schema.Struct({
			instance: Schema.String,
			desired: Schema.NullOr(Schema.String),
			actual: Schema.NullOr(Schema.String),
			healthy: Schema.Boolean,
			attempt: Schema.String,
		}),
	),
	/** The phase the Change was in, and its full rendered cause; empty when it has none. */
	phase: Schema.String,
	diagnostic: Schema.String,
})
export type Line = typeof Line.Type
/** An opaque diagnostic identifier and its retention deadline in epoch milliseconds. */
export const DiagnosticReference = Schema.Struct({
	id: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
	expiresAt: Schema.Finite,
})
export type DiagnosticReference = typeof DiagnosticReference.Type
/** A durable line contains a content digest and a diagnostic reference, never the rendered cause. */
export const Entry = Schema.Struct({
	...Line.fields,
	content: Schema.String,
	diagnostic: Schema.NullOr(DiagnosticReference),
})
export type Entry = typeof Entry.Type
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Entry))
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Entry))
const Diagnostic = Schema.Struct({
	expiresAt: Schema.Finite,
	cause: Schema.String,
})
const encodeDiagnostic = Schema.encodeEffect(Schema.fromJsonString(Diagnostic))
const decodeDiagnostic = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Diagnostic),
)

export const fromDuty = (duty: RecordDuty): Line => ({
	id: `${duty.payload.run}/${duty.id}`,
	run: duty.payload.run,
	change: duty.payload.change,
	stage: duty.payload.stage,
	content: duty.content,
	members: duty.payload.members,
	targets: duty.payload.targets,
	outcome: Option.getOrNull(duty.payload.outcome),
	facts: Array.map(duty.payload.facts, (fact) => ({
		instance: fact.instance,
		desired: Option.getOrNull(fact.desired),
		actual: Option.getOrNull(fact.actual),
		healthy: fact.healthy,
		attempt: fact.attempt,
	})),
	phase: duty.payload.phase,
	diagnostic: duty.payload.diagnostic,
})

export interface Recovered {
	/** Bytes of a torn final line removed when the journal was opened. */
	readonly truncated: number
}
export interface Handle {
	/** Appends and syncs the line; a line already present with the same content is not written again. */
	readonly append: (
		line: Line,
	) => Effect.Effect<"Appended" | "Present", JournalError>
	readonly lines: Effect.Effect<ReadonlyArray<Entry>>
	/** Removes expired diagnostics. Also runs on open and append. */
	readonly prune: Effect.Effect<void, JournalError>
	/** Merges eligible closed segments; returns the number of source segments replaced. */
	readonly compact: Effect.Effect<number, JournalError>
	readonly recovered: Recovered
}
export interface Options {
	/** A new segment starts once the current one reaches this size. Default 4 MiB. */
	readonly segmentBytes?: number
	/** How long rendered causes remain available. Default 30 days; must be finite and nonnegative. */
	readonly diagnosticRetention?: Duration.Input
}
/** What the journal shows about one Change. */
export interface Outcome {
	readonly run: string
	readonly change: string
	readonly stages: ReadonlyArray<Line["stage"]>
	readonly members: ReadonlyArray<string>
	readonly targets: ReadonlyArray<string>
	readonly outcome: Option.Option<string>
	readonly concluded: boolean
	/** Member facts and diagnostic of the latest record: after a crash, which members ran, recovered or stayed down. */
	readonly facts: Entry["facts"]
	readonly phase: string
	readonly diagnosticReference: Option.Option<DiagnosticReference>
}
/** A durable outcome with the current availability of its separately retained diagnostic. */
export interface Summary extends Outcome {
	readonly diagnostic: string
	readonly diagnosticStatus: "None" | "Available" | "Expired"
}

const storage = (detail: string) => (cause: PlatformError.PlatformError) =>
	JournalError.make({ reason: "Storage", detail, cause: Cause.fail(cause) })
const segmentName = (n: number) =>
	`segment-${String.padStart(6, "0")(`${n}`)}.jsonl`
interface Segment {
	readonly first: number
	readonly last: number
	readonly name: string
}
const segment = (name: string): Option.Option<Segment> => {
	const regular = /^segment-(\d+)\.jsonl$/.exec(name)
	if (regular !== null)
		return Option.some({
			first: Number(regular[1]),
			last: Number(regular[1]),
			name,
		})
	const compacted = /^compacted-(\d+)-(\d+)\.jsonl$/.exec(name)
	return compacted === null
		? Option.none()
		: Option.some({
				first: Number(compacted[1]),
				last: Number(compacted[2]),
				name,
			})
}
interface Read {
	readonly lines: ReadonlyArray<Entry>
	readonly segments: ReadonlyArray<
		Segment & { readonly lines: ReadonlyArray<Entry> }
	>
	readonly obsolete: ReadonlyArray<string>
	/** Byte length of the valid prefix of the open segment and its total length. */
	readonly last: Option.Option<{
		readonly segment: number
		readonly valid: number
		readonly total: number
	}>
}
/** A renamed compacted range supersedes its sources, including after a crash during deletion. */
const readAllOnce = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const empty: Read = {
		lines: [],
		segments: [],
		obsolete: [],
		last: Option.none(),
	}
	if (
		!(yield* fs
			.exists(directory)
			.pipe(Effect.mapError(storage("Reading the journal directory failed"))))
	)
		return empty
	const names = yield* fs
		.readDirectory(directory)
		.pipe(Effect.mapError(storage("Reading the journal directory failed")))
	const ordered = Array.sort(
		Array.getSomes(Array.map(names, segment)),
		Order.mapInput(
			Order.Tuple([Order.Number, Order.Number]),
			(segment: Segment) => [segment.first, -segment.last] as const,
		),
	)
	const selected = Array.reduce(
		ordered,
		{
			active: [] as ReadonlyArray<Segment>,
			obsolete: [] as ReadonlyArray<string>,
			through: 0,
		},
		(s, next) =>
			next.last <= s.through
				? { ...s, obsolete: Array.append(s.obsolete, next.name) }
				: { ...s, active: Array.append(s.active, next), through: next.last },
	)
	return yield* Effect.reduce(
		selected.active,
		(): Read => ({ ...empty, obsolete: selected.obsolete }),
		(read, next, index) =>
			Effect.gen(function* () {
				const text = yield* fs
					.readFileString(path.join(directory, next.name))
					.pipe(Effect.mapError(storage("Reading a journal segment failed")))
				const parts = String.split("\n")(text)
				const complete = Array.dropRight(parts, 1)
				const tail = Option.getOrElse(Array.last(parts), () => "")
				const isOpen =
					index === selected.active.length - 1 &&
					String.startsWith("segment-")(next.name)
				if (!isOpen && tail !== "")
					return yield* JournalError.make({
						reason: "Corrupt",
						detail: `${next.name} ends without a newline`,
					})
				const good = yield* Effect.forEach(complete, (line, at) =>
					decodeLine(line).pipe(
						Effect.mapError((cause) =>
							JournalError.make({
								reason: "Corrupt",
								detail: `Line ${at + 1} of ${next.name} does not decode`,
								cause: Cause.fail(cause),
							}),
						),
					),
				)
				const total = new TextEncoder().encode(text).length
				const valid = total - new TextEncoder().encode(tail).length
				return {
					lines: Array.appendAll(read.lines, good),
					segments: Array.append(read.segments, { ...next, lines: good }),
					obsolete: read.obsolete,
					last: isOpen
						? Option.some({ segment: next.last, valid, total })
						: read.last,
				} satisfies Read
			}),
	)
})

/** A concurrent reader may list sources just before the recorder replaces them. */
const readAll = Effect.fnUntraced(function* (directory: string) {
	return yield* readAllOnce(directory).pipe(
		Effect.retry({
			times: 2,
			while: (error) =>
				error.reason === "Storage" &&
				error.cause !== undefined &&
				Option.exists(
					Cause.findErrorOption(error.cause),
					(cause) =>
						PlatformError.isPlatformError(cause) &&
						cause.reason._tag === "NotFound",
				),
		}),
	)
})

const corrupt = (detail: string) => (cause: Schema.SchemaError) =>
	JournalError.make({ reason: "Corrupt", detail, cause: Cause.fail(cause) })

/** Deletes expired diagnostic files, including unreferenced files left by a failed append. */
const pruneDiagnostics = Effect.fnUntraced(
	function* (directory: string) {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		if (!(yield* fs.exists(directory))) return
		const now = yield* Clock.currentTimeMillis
		const names = yield* fs.readDirectory(directory)
		let removed = false
		for (const name of names) {
			const pending = /^[0-9a-f-]{36}\.([0-9.]+)\.tmp$/.exec(name)
			if (pending !== null) {
				if (Number(pending[1]) <= now) {
					yield* fs.remove(path.join(directory, name), { force: true })
					removed = true
				}
				continue
			}
			if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
			const file = path.join(directory, name)
			const text = yield* fs.readFileString(file)
			const diagnostic = yield* decodeDiagnostic(text).pipe(
				Effect.mapError(corrupt("A diagnostic does not decode")),
			)
			if (diagnostic.expiresAt <= now) {
				yield* fs.remove(file, { force: true })
				removed = true
			}
		}
		if (removed)
			yield* Effect.scoped(
				Effect.flatMap(fs.open(directory), (handle) => handle.sync),
			)
	},
	Effect.mapError((cause) =>
		cause._tag === "JournalError"
			? cause
			: storage("Removing expired diagnostics failed")(cause),
	),
)

/** Opens the journal for appending, truncating a torn final line first. */
export const open = Effect.fnUntraced(function* (
	directory: string,
	options: Options = {},
): Effect.fn.Return<
	Handle,
	JournalError,
	| FileSystem.FileSystem
	| Path.Path
	| Scope.Scope
	| Digest.Digest
	| SecureRandom.SecureRandom
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const digest = yield* Digest.Digest
	const random = yield* SecureRandom.SecureRandom
	const retention = Duration.toMillis(
		Duration.fromInputUnsafe(options.diagnosticRetention ?? "30 days"),
	)
	if (!Number.isFinite(retention) || retention < 0)
		return yield* JournalError.make({
			reason: "Corrupt",
			detail: "Diagnostic retention must be finite and nonnegative",
		})
	const diagnostics = path.join(directory, "diagnostics")
	const limit = Math.max(1, options.segmentBytes ?? 4 * 1024 * 1024)
	const syncDirectory = Effect.scoped(
		Effect.flatMap(fs.open(directory), (handle) => handle.sync),
	).pipe(Effect.mapError(storage("Syncing the journal directory failed")))
	yield* fs
		.makeDirectory(diagnostics, { recursive: true, mode: 0o700 })
		.pipe(Effect.mapError(storage("Creating the journal directory failed")))
	const prune = pruneDiagnostics(diagnostics).pipe(
		Effect.provideService(FileSystem.FileSystem, fs),
		Effect.provideService(Path.Path, path),
	)
	yield* prune
	const read = yield* readAll(directory)
	const truncated = Option.match(read.last, {
		onNone: () => 0,
		onSome: (last) => last.total - last.valid,
	})
	if (truncated > 0 && Option.isSome(read.last)) {
		const file = path.join(directory, segmentName(read.last.value.segment))
		yield* fs
			.truncate(file, read.last.value.valid)
			.pipe(Effect.mapError(storage("Truncating a torn journal line failed")))
	}
	const state = yield* Ref.make({
		lines: read.lines,
		contents: HashMap.fromIterable(
			Array.map(read.lines, (line) => [line.id, line.content] as const),
		),
		segment: Option.match(read.last, {
			onNone: () => 1,
			onSome: (l) => l.segment,
		}),
		size: Option.match(read.last, { onNone: () => 0, onSome: (l) => l.valid }),
	})
	yield* syncDirectory
	const lock = yield* Semaphore.make(1)
	/** Appends after `valid`, the last acknowledged boundary of the segment. */
	const write = (segment: number, valid: number, bytes: Uint8Array) =>
		Effect.scoped(
			Effect.gen(function* () {
				const file = path.join(directory, segmentName(segment))
				// A failed append may have left a partial or unsynced line; cut back to the boundary first.
				if (yield* fs.exists(file)) {
					const info = yield* fs.stat(file)
					if (ByteSize.toBigInt(info.size) > BigInt(valid))
						yield* fs.truncate(file, valid)
				}
				const handle = yield* fs.open(file, { flag: "a", mode: 0o600 })
				yield* handle.writeAll(bytes)
				yield* handle.sync
			}),
		).pipe(Effect.mapError(storage("Appending to the journal failed")))
	const append = (line: Line) =>
		lock.withPermits(1)(
			Effect.gen(function* () {
				const current = yield* Ref.get(state)
				yield* prune
				const fingerprint = yield* digest.digestHex(
					Digest.sha256,
					new TextEncoder().encode(line.content),
				)
				const known = HashMap.get(current.contents, line.id)
				if (Option.isSome(known))
					return known.value === fingerprint
						? ("Present" as const)
						: yield* JournalError.make({
								reason: "Conflict",
								detail: `Record ${line.id} is already journaled with other content`,
							})
				const reference =
					line.diagnostic === ""
						? null
						: {
								id: yield* random.uuidV4(),
								expiresAt: (yield* Clock.currentTimeMillis) + retention,
							}
				if (reference !== null) {
					const text = yield* encodeDiagnostic({
						expiresAt: reference.expiresAt,
						cause: line.diagnostic,
					}).pipe(Effect.mapError(corrupt("A diagnostic cannot be encoded")))
					yield* Effect.scoped(
						Effect.gen(function* () {
							const temporary = path.join(
								diagnostics,
								`${reference.id}.${reference.expiresAt}.tmp`,
							)
							const handle = yield* fs.open(temporary, {
								flag: "wx",
								mode: 0o600,
							})
							yield* handle.writeAll(new TextEncoder().encode(text))
							yield* handle.sync
							yield* fs.rename(
								temporary,
								path.join(diagnostics, `${reference.id}.json`),
							)
							const parent = yield* fs.open(diagnostics)
							yield* parent.sync
						}),
					).pipe(Effect.mapError(storage("Writing a diagnostic failed")))
				}
				const entry: Entry = {
					...line,
					content: fingerprint,
					diagnostic: reference,
				}
				const text = yield* encodeLine(entry).pipe(
					Effect.mapError((error) =>
						JournalError.make({
							reason: "Corrupt",
							detail: "A record cannot be encoded",
							cause: Cause.fail(error),
						}),
					),
				)
				const bytes = new TextEncoder().encode(text + "\n")
				const rotate = current.size > 0 && current.size + bytes.length > limit
				const segment = rotate ? current.segment + 1 : current.segment
				yield* write(segment, rotate ? 0 : current.size, bytes)
				if (rotate || current.size === 0) yield* syncDirectory
				yield* Ref.set(state, {
					lines: Array.append(current.lines, entry),
					contents: HashMap.set(current.contents, line.id, fingerprint),
					segment,
					size: (rotate ? 0 : current.size) + bytes.length,
				})
				return "Appended" as const
			}),
		)
	const compact = lock
		.withPermits(1)(
			Effect.gen(function* () {
				const current = yield* Ref.get(state)
				const read = yield* readAll(directory)
				// Persist a previously renamed replacement before finishing interrupted source deletion.
				if (read.obsolete.length > 0) {
					yield* syncDirectory
					for (const name of read.obsolete)
						yield* fs
							.remove(path.join(directory, name), { force: true })
							.pipe(
								Effect.mapError(
									storage("Removing a superseded segment failed"),
								),
							)
					yield* syncDirectory
				}
				const concluded = HashSet.fromIterable(
					Array.map(
						Array.filter(current.lines, (line) => line.stage === "Conclusion"),
						(line) => `${line.run}/${line.change}`,
					),
				)
				const eligible = (segment: Read["segments"][number]) =>
					segment.last < current.segment &&
					Array.every(segment.lines, (line) =>
						HashSet.has(concluded, `${line.run}/${line.change}`),
					)
				let sources: Read["segments"] = []
				for (const segment of read.segments) {
					if (eligible(segment)) sources = Array.append(sources, segment)
					else if (sources.length >= 2) break
					else sources = []
				}
				if (sources.length < 2) return 0
				const first = sources[0]!
				const last = sources[sources.length - 1]!
				const name = `compacted-${first.first}-${last.last}.jsonl`
				const text = yield* Effect.forEach(
					Array.flatMap(sources, (source) => source.lines),
					(line) =>
						encodeLine(line).pipe(
							Effect.mapError(corrupt("A compacted record cannot be encoded")),
						),
				)
				const temporary = path.join(directory, `${name}.tmp`)
				yield* Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* fs.open(temporary, { flag: "w", mode: 0o600 })
						yield* handle.writeAll(
							new TextEncoder().encode(Array.join(text, "\n") + "\n"),
						)
						yield* handle.sync
					}),
				).pipe(Effect.mapError(storage("Writing a compacted segment failed")))
				yield* fs
					.rename(temporary, path.join(directory, name))
					.pipe(
						Effect.mapError(storage("Publishing a compacted segment failed")),
					)
				yield* syncDirectory
				for (const source of sources)
					yield* fs
						.remove(path.join(directory, source.name), { force: true })
						.pipe(
							Effect.mapError(storage("Removing a compacted source failed")),
						)
				yield* syncDirectory
				return sources.length
			}),
		)
		.pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path),
		)
	return {
		append,
		prune: lock.withPermits(1)(prune),
		compact,
		lines: Effect.map(Ref.get(state), (s) => s.lines),
		recovered: { truncated },
	}
})

/** Groups journaled lines by kernel run and Change id, in the order each Change first appeared. */
export const summarize = (
	lines: ReadonlyArray<Entry>,
): ReadonlyArray<Outcome> => {
	const key = (line: Entry) => `${line.run}/${line.change}`
	const order = Array.dedupe(Array.map(lines, key))
	return Array.map(order, (change) => {
		const own = Array.filter(lines, (line) => key(line) === change)
		const conclusion = Array.findFirst(
			own,
			(line) => line.stage === "Conclusion",
		)
		const first = Array.headNonEmpty(own as [Entry, ...Array<Entry>])
		const last = Array.lastNonEmpty(own as [Entry, ...Array<Entry>])
		return {
			run: first.run,
			change: first.change,
			stages: Array.map(own, (line) => line.stage),
			members: first.members,
			targets: first.targets,
			outcome: Option.flatMap(conclusion, (line) =>
				Option.fromNullOr(line.outcome),
			),
			concluded: Option.isSome(conclusion),
			facts: last.facts,
			phase: last.phase,
			diagnosticReference: Option.fromNullOr(last.diagnostic),
		}
	})
}

/** Reads the journal without a running kernel; a torn final line is ignored, not removed. */
export const history = Effect.fnUntraced(function* (
	directory: string,
): Effect.fn.Return<
	ReadonlyArray<Summary>,
	JournalError,
	FileSystem.FileSystem | Path.Path
> {
	const read = yield* readAll(directory)
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const now = yield* Clock.currentTimeMillis
	return yield* Effect.forEach(summarize(read.lines), (summary) =>
		Effect.gen(function* () {
			if (Option.isNone(summary.diagnosticReference))
				return { ...summary, diagnostic: "", diagnosticStatus: "None" as const }
			const reference = summary.diagnosticReference.value
			if (reference.expiresAt <= now)
				return {
					...summary,
					diagnostic: "Diagnostic expired",
					diagnosticStatus: "Expired" as const,
				}
			const text = yield* fs
				.readFileString(
					path.join(directory, "diagnostics", `${reference.id}.json`),
				)
				.pipe(Effect.mapError(storage("Reading a diagnostic failed")))
			const diagnostic = yield* decodeDiagnostic(text).pipe(
				Effect.mapError(corrupt("A diagnostic does not decode")),
			)
			return {
				...summary,
				diagnostic: diagnostic.cause,
				diagnosticStatus: "Available" as const,
			}
		}),
	)
})
