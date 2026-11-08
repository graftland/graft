/**
 * The Loader unit: reads one config revision, prepares every entry in disposable
 * inspection units and submits them to the kernel as one Change.
 */
import {
	Array,
	Config,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Schema,
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

const operation = Effect.fnUntraced(function* (
	entry: Entry,
	options: Options,
	resolver: ModuleResolver.ModuleResolver["Service"],
	preparation: Effect.Success<ReturnType<typeof Preparation.make>>,
	control: Control.Client,
) {
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
	if (names.length > 0) {
		const planned = yield* Preparation.target(input, {
			control: options.control,
		})
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
		_tag: "Deploy",
		instance: entry.id,
		target: prepared.target,
	} satisfies Kernel.DeploymentOperation
})

/** Reads, prepares and submits one revision; the plugin then stays idle. */
const deploy = Effect.fnUntraced(function* (options: Options) {
	const path = yield* Path.Path
	const control = yield* Control.connect(options.control)
	const resolver = yield* ModuleResolver.make({
		base: path.dirname(options.config),
		control: options.control,
	})
	const preparation = yield* Preparation.make({ control: options.control })
	const read = yield* revision(options.config)
	const entries = yield* instances(read)
	const operations = yield* Effect.forEach(entries, (entry) =>
		operation(entry, options, resolver, preparation, control),
	)
	if (operations.length === 0) return
	const handle = yield* control.submit({ operations, strategy: "Restart" })
	const conclusion = yield* handle.await
	if (conclusion.outcome !== "Accepted")
		return yield* DeploymentFailed.make({
			change: handle.id,
			outcome: conclusion.outcome,
			cause: conclusion.cause,
		})
	yield* Effect.logInfo(
		`Deployed ${operations.length} ${operations.length === 1 ? "entry" : "entries"}`,
	)
})

export const plugin = Plugin.make({
	name: "@graftland/loader/Deployment",
	config: Options,
	inject: [FileSystem.FileSystem, Path.Path],
	apply: deploy,
})
export default plugin
