/** The release recorder's append-only journal: each record is on disk before it is acknowledged. */
import {
	Array,
	ByteSize,
	Cause,
	Effect,
	FileSystem,
	HashMap,
	Option,
	Order,
	Path,
	Ref,
	Schema,
	Semaphore,
	String,
	type PlatformError,
	type Scope,
} from "effect"

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
/** One journal line: a record exactly as the kernel delivered it. */
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
})
export type Line = typeof Line.Type
const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Line))
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Line))

export const fromDuty = (duty: RecordDuty): Line => ({
	id: `${duty.payload.run}/${duty.id}`,
	run: duty.payload.run,
	change: duty.payload.change,
	stage: duty.payload.stage,
	content: duty.content,
	members: duty.payload.members,
	targets: duty.payload.targets,
	outcome: Option.getOrNull(duty.payload.outcome),
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
	readonly lines: Effect.Effect<ReadonlyArray<Line>>
	readonly recovered: Recovered
}
export interface Options {
	/** A new segment starts once the current one reaches this size. Default 4 MiB. */
	readonly segmentBytes?: number
}
/** What the journal shows about one Change. */
export interface Summary {
	readonly run: string
	readonly change: string
	readonly stages: ReadonlyArray<Line["stage"]>
	readonly members: ReadonlyArray<string>
	readonly targets: ReadonlyArray<string>
	readonly outcome: Option.Option<string>
	readonly concluded: boolean
}

const storage = (detail: string) => (cause: PlatformError.PlatformError) =>
	JournalError.make({ reason: "Storage", detail, cause: Cause.fail(cause) })
const segmentName = (n: number) =>
	`segment-${String.padStart(6, "0")(`${n}`)}.jsonl`
const segmentNumber = (name: string): Option.Option<number> => {
	const match = /^segment-(\d{6})\.jsonl$/.exec(name)
	return match === null ? Option.none() : Option.some(Number(match[1]))
}

interface Read {
	readonly lines: ReadonlyArray<Line>
	/** Byte length of the valid prefix of the last segment and its total length. */
	readonly last: Option.Option<{
		readonly segment: number
		readonly valid: number
		readonly total: number
	}>
}
/** Decodes every segment; only the last line of the last segment may be torn. */
const readAll = Effect.fnUntraced(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const exists = yield* fs
		.exists(directory)
		.pipe(Effect.mapError(storage("Reading the journal directory failed")))
	if (!exists) return { lines: [], last: Option.none() } satisfies Read
	const names = yield* fs
		.readDirectory(directory)
		.pipe(Effect.mapError(storage("Reading the journal directory failed")))
	const segments = Array.sort(
		Array.getSomes(Array.map(names, segmentNumber)),
		Order.Number,
	)
	const encoder = new TextEncoder()
	return yield* Effect.reduce(
		segments,
		(): Read => ({ lines: [], last: Option.none() }),
		(read, segment, index) =>
			Effect.gen(function* () {
				const text = yield* fs
					.readFileString(path.join(directory, segmentName(segment)))
					.pipe(Effect.mapError(storage("Reading a journal segment failed")))
				const parts = String.split("\n")(text)
				/** A line counts only once its newline is written; anything after the last newline is torn. */
				const complete = Array.dropRight(parts, 1)
				const tail = Option.getOrElse(Array.last(parts), () => "")
				const isLast = index === segments.length - 1
				if (!isLast && tail !== "")
					return yield* JournalError.make({
						reason: "Corrupt",
						detail: `${segmentName(segment)} ends without a newline`,
					})
				const good = yield* Effect.forEach(complete, (line, at) =>
					decodeLine(line).pipe(
						Effect.catchTag("SchemaError", () =>
							JournalError.make({
								reason: "Corrupt",
								detail: `Line ${at + 1} of ${segmentName(segment)} does not decode`,
							}),
						),
					),
				)
				const total = encoder.encode(text).length
				const valid = total - encoder.encode(tail).length
				return {
					lines: Array.appendAll(read.lines, good),
					last: isLast ? Option.some({ segment, valid, total }) : read.last,
				} satisfies Read
			}),
	)
})

/** Opens the journal for appending, truncating a torn final line first. */
export const open = Effect.fnUntraced(function* (
	directory: string,
	options: Options = {},
): Effect.fn.Return<
	Handle,
	JournalError,
	FileSystem.FileSystem | Path.Path | Scope.Scope
> {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const limit = Math.max(1, options.segmentBytes ?? 4 * 1024 * 1024)
	const syncDirectory = Effect.scoped(
		Effect.flatMap(fs.open(directory), (handle) => handle.sync),
	).pipe(Effect.mapError(storage("Syncing the journal directory failed")))
	yield* fs
		.makeDirectory(directory, { recursive: true })
		.pipe(Effect.mapError(storage("Creating the journal directory failed")))
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
	if (Option.isNone(read.last)) yield* syncDirectory
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
				const known = HashMap.get(current.contents, line.id)
				if (Option.isSome(known))
					return known.value === line.content
						? ("Present" as const)
						: yield* JournalError.make({
								reason: "Conflict",
								detail: `Record ${line.id} is already journaled with other content`,
							})
				const text = yield* encodeLine(line).pipe(
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
					lines: Array.append(current.lines, line),
					contents: HashMap.set(current.contents, line.id, line.content),
					segment,
					size: (rotate ? 0 : current.size) + bytes.length,
				})
				return "Appended" as const
			}),
		)
	return {
		append,
		lines: Effect.map(Ref.get(state), (s) => s.lines),
		recovered: { truncated },
	}
})

/** Groups journaled lines by kernel run and Change id, in the order each Change first appeared. */
export const summarize = (
	lines: ReadonlyArray<Line>,
): ReadonlyArray<Summary> => {
	const key = (line: Line) => `${line.run}/${line.change}`
	const order = Array.dedupe(Array.map(lines, key))
	return Array.map(order, (change) => {
		const own = Array.filter(lines, (line) => key(line) === change)
		const conclusion = Array.findFirst(
			own,
			(line) => line.stage === "Conclusion",
		)
		const first = Array.headNonEmpty(own as [Line, ...Array<Line>])
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
		}
	})
}

/** Reads the journal without a running kernel; a torn final line is ignored, not removed. */
export const history = Effect.fnUntraced(function* (directory: string) {
	const read = yield* readAll(directory)
	return summarize(read.lines)
})
