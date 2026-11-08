/** Operator release workflows over the public kernel control protocol. */
import {
	Array,
	Cause,
	Clock,
	Effect,
	Equal,
	FileSystem,
	HashMap,
	Option,
	Order,
	Path,
	Schema,
	String,
} from "effect"

import type * as Kernel from "@graftland/graft/Kernel"
import type * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

import * as Storage from "./internal/storage"
import * as Journal from "./Journal"
import { Id, ReleaseError } from "./Model"

export interface CurrentInstance {
	readonly id: string
	readonly target: Kernel.Target
	readonly probes?: ReadonlyArray<string>
}
export interface LoadedRelease {
	readonly id: string
	readonly entries: ReadonlyArray<
		CurrentInstance & { readonly probes: ReadonlyArray<string> }
	>
}
export const PlanMember = Schema.Struct({
	instance: Schema.String,
	reason: Schema.Literals(["Added", "Changed", "Removed"]),
})
export type PlanMember = typeof PlanMember.Type
export interface Plan {
	readonly release: string
	readonly members: ReadonlyArray<PlanMember>
	readonly operations: ReadonlyArray<Kernel.DeploymentOperation>
	readonly probes: ReadonlyArray<string>
}
export const ApplyOptions = Schema.Struct({
	strategy: Schema.optionalKey(Schema.Literals(["Restart", "Overlap"])),
	budget: Schema.optionalKey(
		Schema.Struct({
			total: Schema.optionalKey(Schema.Finite),
			startup: Schema.optionalKey(Schema.Finite),
			probe: Schema.optionalKey(Schema.Finite),
			drain: Schema.optionalKey(Schema.Finite),
			stop: Schema.optionalKey(Schema.Finite),
			terminate: Schema.optionalKey(Schema.Finite),
		}),
	),
	trial: Schema.optionalKey(Schema.Finite),
})
export type ApplyOptions = typeof ApplyOptions.Type
export interface WorkflowStore {
	readonly releases: string
	readonly journal: string
}
export const Applied = Schema.Struct({
	release: Id,
	change: Schema.String,
	run: Schema.NullOr(Schema.String),
	outcome: Schema.Literals([
		"Accepted",
		"Aborted",
		"Recovered",
		"RecoveryFailed",
		"Stuck",
	]),
	phase: Schema.String,
	diagnostic: Schema.String,
})
export type Applied = typeof Applied.Type
const Intent = Schema.Struct({
	release: Id,
	key: Schema.String,
	started: Schema.Finite,
	members: Schema.Array(PlanMember),
	options: ApplyOptions,
})
const Receipt = Schema.Struct({
	intent: Intent,
	change: Schema.String,
	run: Schema.NullOr(Schema.String),
	result: Schema.NullOr(Applied),
})
export interface ReleaseHistory {
	readonly release: string
	readonly key: string
	readonly change: string
	readonly run: Option.Option<string>
	/** Absent until a conclusion has been recorded or the applying client has saved its result. */
	readonly outcome: Option.Option<string>
	readonly recorded: boolean
	readonly diagnostic: string
}

/** Verifies captured bytes and resolves input references without activating a plugin. */
export const load = Effect.fn("Release.load")(function* (
	store: string,
	id: string,
) {
	const release = yield* Storage.load(store, id)
	const path = yield* Path.Path
	const directory = path.resolve(store, id)
	const entries = yield* Effect.forEach(
		release.entries,
		Effect.fnUntraced(function* (entry) {
			if (entry.contractArtifact === undefined)
				return yield* Storage.failure(
					"Contract",
					"Rebuild this release to capture its contract",
				)
			if (
				(entry.target._tag === "Worker" &&
					(entry.target.execArgv?.length ?? 0) > 0) ||
				(entry.target._tag === "Local" && entry.target.command !== undefined)
			)
				return yield* Storage.failure(
					"Placement",
					"Native release units do not support custom commands or Worker arguments",
				)
			return {
				id: entry.id,
				probes: entry.probes,
				target: Units.target({
					artifact: {
						...entry.artifact,
						directory: path.join(directory, entry.artifact.directory),
					},
					contractArtifact: {
						...entry.contractArtifact,
						directory: path.join(directory, entry.contractArtifact.directory),
					},
					contract: entry.contractArtifact.identity.module,
					input: yield* Storage.resolveInput(entry.input),
					placement: entry.target._tag === "Worker" ? "Worker" : "Process",
				}),
			}
		}),
	)
	return { id, entries } satisfies LoadedRelease
}, Storage.protect)

/** Diffs only the application's supplied instances; omit infrastructure such as the recorder. No I/O. */
export const plan = (
	release: LoadedRelease,
	current: ReadonlyArray<CurrentInstance>,
): Plan => {
	const before = HashMap.fromIterable(
		Array.map(current, (entry) => [entry.id, entry] as const),
	)
	const after = HashMap.fromIterable(
		Array.map(release.entries, (entry) => [entry.id, entry] as const),
	)
	const members: ReadonlyArray<PlanMember> = [
		...Array.getSomes(
			Array.map(release.entries, (entry): Option.Option<PlanMember> => {
				const old = HashMap.get(before, entry.id)
				return Option.isNone(old)
					? Option.some({ instance: entry.id, reason: "Added" as const })
					: sameTarget(old.value.target, entry.target) &&
						  Equal.equals(old.value.probes ?? [], entry.probes)
						? Option.none()
						: Option.some({ instance: entry.id, reason: "Changed" as const })
			}),
		),
		...Array.getSomes(
			Array.map(current, (entry): Option.Option<PlanMember> =>
				HashMap.has(after, entry.id)
					? Option.none()
					: Option.some({ instance: entry.id, reason: "Removed" as const }),
			),
		),
	]
	return materialize(release, members)
}
const sameTarget = (a: Kernel.Target, b: Kernel.Target): boolean =>
	a.identity === b.identity &&
	a.placement === b.placement &&
	a.overlap === b.overlap &&
	Equal.equals(a.deployment?.input, b.deployment?.input)

const materialize = (
	release: LoadedRelease,
	members: ReadonlyArray<PlanMember>,
): Plan => {
	const entries = HashMap.fromIterable(
		Array.map(release.entries, (entry) => [entry.id, entry] as const),
	)
	return {
		release: release.id,
		members,
		operations: Array.map(members, (member): Kernel.DeploymentOperation =>
			member.reason === "Removed"
				? { _tag: "Remove", instance: member.instance }
				: {
						_tag: "Deploy",
						instance: member.instance,
						target: Option.getOrThrow(HashMap.get(entries, member.instance))
							.target,
					},
		),
		probes: Array.dedupe(
			Array.flatMap(members, (member) =>
				member.reason === "Removed"
					? []
					: Option.getOrThrow(HashMap.get(entries, member.instance)).probes,
			),
		),
	}
}

/** Atomically publishes synced metadata beside, never inside, the immutable release. */
const save = Effect.fnUntraced(function* (
	file: string,
	value: Schema.Json,
	exclusive: boolean = false,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.dirname(file)
	yield* fs.makeDirectory(directory, { recursive: true })
	yield* Effect.scoped(
		Effect.gen(function* () {
			const temporary = yield* fs.makeTempFileScoped({ directory })
			yield* Storage.write(temporary, value)
			const handle = yield* fs.open(temporary)
			yield* handle.sync
			if (exclusive)
				yield* fs
					.link(temporary, file)
					.pipe(
						Effect.catchTag("PlatformError", (error) =>
							error.reason._tag === "AlreadyExists"
								? Effect.void
								: Effect.fail(error),
						),
					)
			else yield* fs.rename(temporary, file)
			const parent = yield* fs.open(directory)
			yield* parent.sync
		}),
	)
})
const paths = Effect.fnUntraced(function* (store: WorkflowStore, key: string) {
	const path = yield* Path.Path
	const directory = path.join(store.releases, ".applications")
	return {
		intent: path.join(directory, key + ".intent.json"),
		receipt: path.join(directory, key + ".receipt.json"),
	}
})
const receipts = Effect.fnUntraced(function* (store: WorkflowStore) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.join(store.releases, ".applications")
	if (!(yield* fs.exists(directory))) return []
	const names = yield* fs.readDirectory(directory)
	return yield* Effect.forEach(
		Array.filter(names, (name) => String.endsWith(".receipt.json")(name)),
		(name) => Storage.read(path.join(directory, name), Receipt),
	)
})
/** Joins operator receipts to the durable journal by kernel run and Change id. */
export const history = Effect.fn("Release.history")(function* (
	store: WorkflowStore,
) {
	const records = yield* Journal.history(store.journal)
	const stored = yield* receipts(store)
	const saved = Array.sort(
		stored,
		Order.mapInput(
			Order.Number,
			(receipt: typeof Receipt.Type) => receipt.intent.started,
		),
	)
	return yield* Effect.forEach(
		saved,
		Effect.fnUntraced(function* (receipt): Effect.fn.Return<
			ReleaseHistory,
			ReleaseError,
			FileSystem.FileSystem | Path.Path
		> {
			yield* Storage.verify(store.releases, receipt.intent.release)
			const record = Array.findFirst(
				records,
				(record) =>
					record.run === receipt.run && record.change === receipt.change,
			)
			return {
				release: receipt.intent.release,
				key: receipt.intent.key,
				change: receipt.change,
				run: Option.fromNullOr(receipt.run),
				outcome: Option.orElse(
					Option.flatMap(record, (record) => record.outcome),
					() =>
						Option.map(
							Option.fromNullOr(receipt.result),
							(result) => result.outcome,
						),
				),
				recorded: Option.exists(record, (record) => record.concluded),
				diagnostic: Option.match(record, {
					onNone: () => receipt.result?.diagnostic ?? "",
					onSome: (record) => record.diagnostic,
				}),
			}
		}),
	)
}, Storage.protect)

const execute = Effect.fnUntraced(function* (
	client: Control.Client,
	store: WorkflowStore,
	id: string,
	current: ReadonlyArray<CurrentInstance>,
	key: string,
	options: ApplyOptions,
) {
	yield* Schema.decodeEffect(Id)(id)
	const fs = yield* FileSystem.FileSystem
	const files = yield* paths(store, key)
	if (yield* fs.exists(files.receipt)) {
		const receipt = yield* Storage.read(files.receipt, Receipt)
		const records = yield* Journal.history(store.journal)
		const recorded = Array.findFirst(
			records,
			(record) =>
				record.run === receipt.run &&
				record.change === receipt.change &&
				record.concluded,
		)
		if (receipt.result !== null)
			return {
				...receipt.result,
				diagnostic: Option.match(recorded, {
					onNone: () => "",
					onSome: (record) => record.diagnostic,
				}),
			}
		if (Option.isSome(recorded) && Option.isSome(recorded.value.outcome)) {
			const result = yield* Schema.decodeUnknownEffect(Applied)({
				release: id,
				change: receipt.change,
				run: receipt.run,
				outcome: recorded.value.outcome.value,
				phase: recorded.value.phase,
				diagnostic: recorded.value.diagnostic,
			})
			yield* save(files.receipt, {
				...receipt,
				result: { ...result, diagnostic: "" },
			})
			return result
		}
	}
	const release = yield* load(store.releases, id)
	if (!(yield* fs.exists(files.intent))) {
		const proposed = plan(release, current)
		if (proposed.members.length === 0)
			return yield* Storage.failure(
				"NoChanges",
				"The release already matches the supplied current instances",
			)
		yield* save(
			files.intent,
			{
				release: id,
				key,
				started: yield* Clock.currentTimeMillis,
				members: proposed.members,
				options,
			},
			true,
		)
	}
	const intent = yield* Storage.read(files.intent, Intent)
	const proposed = materialize(release, intent.members)
	const handle = yield* client
		.submit({
			operations: proposed.operations,
			key: intent.key,
			...intent.options,
			requirements: {
				probes: proposed.probes,
				trial: intent.options.trial ?? 0,
			},
		})
		.pipe(
			Effect.mapError((error) =>
				ReleaseError.make({
					code: error.reason,
					message: "Release admission failed",
					cause: Cause.fail(error),
				}),
			),
		)
	const observed = yield* client.get(handle.id)
	const status = yield* Effect.fromOption(observed, () =>
		Storage.failure(
			"UnknownChange",
			"The admitted release Change is no longer available",
		),
	)
	const records = yield* Journal.history(store.journal)
	// An outstanding duty carries the run even before its first append; otherwise the Intent has been acknowledged.
	const run = status.recording.required
		? Option.orElse(
				Option.map(
					Array.head(status.recording.outstanding),
					(duty) => duty.payload.run,
				),
				() =>
					Option.map(
						Array.findLast(records, (record) => record.change === handle.id),
						(record) => record.run,
					),
			)
		: Option.none<string>()
	const pending = {
		intent,
		change: handle.id,
		run: Option.getOrNull(run),
		result: null,
	}
	yield* save(files.receipt, pending)
	const conclusion = yield* handle.await
	const result: Applied = {
		release: id,
		change: handle.id,
		run: pending.run,
		outcome: conclusion.outcome,
		phase: conclusion.phase,
		diagnostic: Cause.pretty(conclusion.cause),
	}
	yield* save(files.receipt, {
		intent,
		change: handle.id,
		run: result.run,
		// Diagnostic retention belongs to the journal, not a second copy in operator receipts.
		result: { ...result, diagnostic: "" },
	})
	return result
})
/** Submits one stable release request. Repeated completed applies return their saved outcome. */
export const apply = Effect.fn("Release.apply")(function* (
	client: Control.Client,
	store: WorkflowStore,
	id: string,
	current: ReadonlyArray<CurrentInstance>,
	options: ApplyOptions = {},
) {
	return yield* execute(client, store, id, current, `release-${id}`, options)
}, Storage.protect)

/** Queries the public status projection; an unknown Change is `None`. */
export const observe = (client: Control.Client, id: string) => client.get(id)

/** Applies the accepted release before the latest accepted application, with a fresh admission key. */
export const rollback = Effect.fn("Release.rollback")(function* (
	client: Control.Client,
	store: WorkflowStore,
	current: ReadonlyArray<CurrentInstance>,
	options: ApplyOptions = {},
) {
	const releases = yield* history(store)
	const accepted = Array.filter(releases, (entry) =>
		Option.contains(entry.outcome, "Accepted"),
	)
	const latest = Array.last(accepted)
	if (Option.isNone(latest))
		return yield* Storage.failure(
			"NoPreviousRelease",
			"No accepted release is available to roll back",
		)
	const previous = Array.findLast(
		Array.dropRight(accepted, 1),
		(entry) => entry.release !== latest.value.release,
	)
	if (Option.isNone(previous))
		return yield* Storage.failure(
			"NoPreviousRelease",
			"No previous accepted release is available",
		)
	// The head's request key gives retries the same identity without reusing the target release's original apply.
	return yield* execute(
		client,
		store,
		previous.value.release,
		current,
		`rollback-${previous.value.release}-${latest.value.change}-${Option.getOrElse(latest.value.run, () => "unrecorded")}`,
		options,
	)
}, Storage.protect)
