/**
 * The Loader unit: reads a config revision, prepares every changed entry in
 * disposable inspection units and submits them to the kernel as one Change.
 */
import {
	Array,
	Config,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	HashMap,
	HashSet,
	Option,
	Path,
	Record,
	Ref,
	Schedule,
	Schema,
	Stream,
	String,
	type PlatformError,
} from "effect"

import { Plugin, type Kernel } from "@graftland/graft"
import * as Control from "@graftland/plugin-remote/Control"

import { Entry as EntrySchema, Env, type Entry } from "./Entry"
import { revision } from "./Include"
import { isContainer } from "./internal/snapshot"
import * as ModuleResolver from "./ModuleResolver"
import * as Preparation from "./Preparation"

export { WriteConflict } from "./internal/atomicWrite"

/** An entry uses a field the kernel deployment path does not carry yet. */
export class DeploymentUnsupported extends Schema.TaggedError<
	DeploymentUnsupported,
	{ readonly brand: unique symbol }
>()("DeploymentUnsupported", {
	entry: Schema.String,
	field: Schema.Literals(["isolate", "inject", "intercept"]),
}) {}
/** The submitted Change did not conclude `Accepted`. */
export class DeploymentFailed extends Schema.TaggedError<
	DeploymentFailed,
	{ readonly brand: unique symbol }
>()("DeploymentFailed", {
	change: Schema.String,
	outcome: Schema.String,
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

export const Options = Schema.Struct({
	/** Absolute path of the config file. */
	config: Schema.String,
	control: Control.Address,
	placement: Schema.optionalKey(Schema.Literals(["Worker", "Process"])),
	/** Turns each saved edit of the config file or a project module into a Change. */
	watch: Schema.optionalKey(Schema.Boolean),
})
export type Options = typeof Options.Type

/** Application entries in file order. Groups are structural; disabled subtrees and command entries are left out. */
export const instances = (
	entries: ReadonlyArray<Entry>,
): Effect.Effect<ReadonlyArray<Entry>, DeploymentUnsupported> =>
	Effect.forEach(entries, (entry) =>
		entry.disabled === true || entry["cli"] === true
			? Effect.succeed<ReadonlyArray<Entry>>([])
			: entry.group === true
				? instances(Option.getOrElse(children(entry.config), () => []))
				: supported(entry).pipe(Effect.as<ReadonlyArray<Entry>>([entry])),
	).pipe(Effect.map(Array.flatten))
const children = Schema.decodeUnknownOption(Schema.Array(EntrySchema))
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown))
const supported = (entry: Entry) =>
	entry.isolate !== undefined
		? DeploymentUnsupported.make({ entry: entry.id, field: "isolate" })
		: (entry.inject ?? []).length > 0
			? DeploymentUnsupported.make({ entry: entry.id, field: "inject" })
			: entry.intercept !== undefined
				? DeploymentUnsupported.make({ entry: entry.id, field: "intercept" })
				: Effect.void

export interface Referenced {
	readonly value: unknown
	readonly names: ReadonlyArray<string>
}
/** Replaces each `!env` value with a kernel reference so the value never enters deployment data. */
export const references = (value: unknown): Referenced => {
	if (value instanceof Env)
		return { value: { $reference: value.name }, names: [value.name] }
	if (Array.isArray(value)) {
		const items = Array.map(value, references)
		return {
			value: Array.map(items, (item) => item.value),
			names: Array.flatMap(items, (item) => item.names),
		}
	}
	if (!isContainer(value) || !isRecord(value)) return { value, names: [] }
	const fields = Array.map(
		Record.toEntries(value),
		([key, inner]) => [key, references(inner)] as const,
	)
	return {
		value: Record.fromEntries(
			Array.map(fields, ([key, inner]) => [key, inner.value] as const),
		),
		names: Array.flatMap(fields, ([, inner]) => inner.names),
	}
}

interface Tools {
	readonly options: Options
	readonly resolver: ModuleResolver.ModuleResolver["Service"]
	readonly preparation: Effect.Success<ReturnType<typeof Preparation.make>>
	readonly control: Control.Client
}
/** What the last accepted revision deployed per entry: code identity and encoded input. */
type Applied = HashMap.HashMap<string, string>
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
/** The code identity does not cover the input, so an edited config alone must still count as a change. */
const appliedKey = (target: Kernel.Target) =>
	encodeJson(target.deployment?.input ?? null).pipe(
		Effect.map((input) => `${target.identity}\u0000${input}`),
	)

/** Prepares one entry; an entry whose target identity is already applied is left untouched. */
const operation = Effect.fnUntraced(function* (
	entry: Entry,
	tools: Tools,
	applied: Applied,
) {
	const { options, resolver, preparation, control } = tools
	const { value, names } = references(entry.config ?? {})
	const module = yield* resolver.resolve(entry.name)
	const input: Preparation.Input = {
		instance: entry.id,
		module,
		input: value,
		...(options.placement === undefined
			? {}
			: { placement: options.placement }),
	}
	const planned = yield* Preparation.target(input, {
		control: options.control,
	})
	const key = yield* appliedKey(planned)
	const directories = artifactDirectories(planned)
	if (Option.contains(HashMap.get(applied, entry.id), key))
		return {
			instance: entry.id,
			identity: key,
			directories,
			operation: Option.none(),
		}
	if (names.length > 0) {
		const values = yield* Effect.forEach(Array.dedupe(names), (name) =>
			Effect.map(Config.String(name), (v) => [name, v] as const),
		)
		yield* control.setPolicy({
			instance: entry.id,
			allowed: [planned.identity],
			values: Record.fromEntries(values),
		})
	}
	const prepared = yield* preparation.inspect(input)
	return {
		instance: entry.id,
		identity: yield* appliedKey(prepared.target),
		directories,
		operation: Option.some<Kernel.DeploymentOperation>({
			_tag: "Deploy",
			instance: entry.id,
			target: prepared.target,
		}),
	}
})

const isBusy = (error: Control.ControlError) => error.reason === "Busy"
/** Captured directories a target runs from: its module and its environment modules. */
const artifactDirectories = (target: Kernel.Target): ReadonlyArray<string> => [
	...Option.toArray(
		Option.fromUndefinedOr(target.deployment?.artifact.directory),
	),
	...Array.map(
		target.deployment?.environment ?? [],
		(m) => m.artifact.directory,
	),
]
/**
 * Removes captured artifacts that no running entry uses once a revision is
 * accepted, so long editing sessions do not accumulate one copy per save.
 */
const prune = Effect.fnUntraced(function* (
	options: Options,
	keep: HashSet.HashSet<string>,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const store = path.join(path.dirname(options.config), ".graft", "artifacts")
	const names = yield* fs
		.readDirectory(store)
		.pipe(Effect.orElseSucceed(() => []))
	const kept = HashSet.map(keep, (directory) => path.resolve(directory))
	yield* Effect.forEach(
		Array.filter(
			names,
			(name) =>
				String.startsWith("sha256-")(name) &&
				!HashSet.has(kept, path.resolve(store, name)),
		),
		(name) =>
			fs
				.remove(path.join(store, name), { recursive: true })
				.pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Removing an unused artifact failed", cause),
					),
				),
		{ discard: true },
	)
})
/** Reads the file, prepares changed entries and submits one Change; returns what is now applied. */
const revise = Effect.fnUntraced(function* (tools: Tools, applied: Applied) {
	const read = yield* revision(tools.options.config)
	const entries = yield* instances(read)
	const planned = yield* Effect.forEach(entries, (entry) =>
		operation(entry, tools, applied),
	)
	const present = HashSet.fromIterable(Array.map(planned, (p) => p.instance))
	const removed = Array.filter(
		Array.fromIterable(HashMap.keys(applied)),
		(id) => !HashSet.has(present, id),
	)
	const operations = [
		...Array.getSomes(Array.map(planned, (p) => p.operation)),
		...Array.map(removed, (instance): Kernel.DeploymentOperation => ({
			_tag: "Remove",
			instance,
		})),
	]
	const next: Applied = HashMap.fromIterable(
		Array.map(planned, (p) => [p.instance, p.identity] as const),
	)
	const keep = HashSet.fromIterable(
		Array.flatMap(planned, (p) => p.directories),
	)
	if (operations.length === 0) return next
	/** A conflicting owner rejects with Busy; the newest revision is kept and submitted again. */
	const handle = yield* tools.control
		.submit({ operations, strategy: "Restart" })
		.pipe(
			Effect.retry({
				while: isBusy,
				schedule: Schedule.spaced("250 millis"),
			}),
		)
	const conclusion = yield* handle.await
	if (conclusion.outcome !== "Accepted")
		return yield* DeploymentFailed.make({
			change: handle.id,
			outcome: conclusion.outcome,
			cause: conclusion.cause,
		})
	yield* Effect.logInfo(
		`Deployed ${operations.length} ${operations.length === 1 ? "change" : "changes"}`,
	)
	yield* prune(tools.options, keep)
	return next
})

const ignored = HashSet.make("node_modules", ".graft", ".cache", ".git")
type Signal = "Initial" | "Edited"
/**
 * Applies the first revision only after the watcher is installed, so no save is
 * missed. Saves within 100 ms coalesce; one made while a revision is applied
 * runs next, and only the newest is kept. Returns once the first revision
 * concluded; later failures are logged and leave running entries unchanged.
 */
const watched = Effect.fnUntraced(function* (tools: Tools) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.dirname(tools.options.config)
	const ready = yield* Deferred.make<void>()
	const first = yield* Deferred.make<
		void,
		Effect.Error<ReturnType<typeof revise>> | PlatformError.PlatformError
	>()
	const applied = yield* Ref.make<Applied>(HashMap.empty())
	const edits = fs
		.watch(root, {
			recursive: true,
			onReady: () => Deferred.doneUnsafe(ready, Exit.void),
		})
		.pipe(
			Stream.filter((event) => {
				const relative = path.isAbsolute(event.path)
					? path.relative(root, event.path)
					: event.path
				return !Array.some(String.split(path.sep)(relative), (segment) =>
					HashSet.has(ignored, segment),
				)
			}),
			Stream.debounce("100 millis"),
			Stream.map((): Signal => "Edited"),
		)
	const apply = (signal: Signal) =>
		Ref.get(applied).pipe(
			Effect.flatMap((current) => revise(tools, current)),
			Effect.flatMap((next) => Ref.set(applied, next)),
			Effect.exit,
			Effect.flatMap((exit) =>
				signal === "Initial"
					? Deferred.done(first, exit)
					: Exit.isFailure(exit)
						? Effect.logError(
								"The edited configuration was not applied; running entries are unchanged",
								exit.cause,
							)
						: Effect.void,
			),
			Effect.asVoid,
		)
	yield* Stream.merge(
		Stream.fromEffect(Deferred.await(ready).pipe(Effect.as<Signal>("Initial"))),
		edits,
	).pipe(
		Stream.buffer({ capacity: 1, strategy: "sliding" }),
		Stream.runForEach(apply),
		Effect.catchCause((cause) =>
			Deferred.failCause(first, cause).pipe(
				Effect.andThen(
					Effect.logError("Watching the configuration stopped", cause),
				),
			),
		),
		Plugin.fork,
	)
	return yield* Deferred.await(first)
})

/** Applies the first revision, then with `watch` turns each saved edit into a Change. */
const deploy = Effect.fnUntraced(function* (options: Options) {
	const path = yield* Path.Path
	const tools: Tools = {
		options,
		control: yield* Control.connect(options.control),
		resolver: yield* ModuleResolver.make({
			base: path.dirname(options.config),
			control: options.control,
			uncaptured: [options.config],
		}),
		preparation: yield* Preparation.make({ control: options.control }),
	}
	if (options.watch === true) return yield* watched(tools)
	yield* revise(tools, HashMap.empty())
})

export const plugin = Plugin.make({
	name: "@graftland/loader/Deployment",
	config: Options,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: deploy,
})
export default plugin
