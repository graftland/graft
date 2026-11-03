/**
 * A group loads a list of entries and reconciles it in place when the list
 * changes: untouched entries keep running, configuration changes are applied
 * through `Fork.update`, and anything else is unloaded and loaded again.
 */
import { Graft, Plugin, type Fork } from "@nmnmcc/graft"
import {
	Array as Arr,
	Context,
	Effect,
	Equal,
	HashMap,
	Option,
	Predicate,
	Record,
	Ref,
	Schema,
	Scope,
} from "effect"
import { Entry, resolveEnv } from "./Entry"
import { ModuleResolver } from "./ModuleResolver"

interface Child {
	readonly entry: Entry
	readonly fork: Fork.Fork
	/** Its plugin or config could not be resolved; any update tries again from scratch. */
	readonly failed: boolean
}

/** Everything about an entry except its configuration: changing any of it means loading it again. */
const shape = (entry: Entry) => [
	entry.name,
	entry.group === true,
	entry.inject ?? [],
	entry.isolate ?? {},
	entry.intercept ?? {},
]

/** A plugin that only fails, so an entry that cannot be loaded still shows up as a failed fork. */
const failing = <E>(name: string, error: E) =>
	Plugin.make({ name, apply: () => Effect.fail(error) })

/** Waits for services named by string key before loading the plugin. */
const waitingFor = (keys: ReadonlyArray<string>, plugin: Plugin.Plugin) =>
	Plugin.make({
		name: plugin.name,
		config: Schema.Unknown,
		inject: Arr.map(keys, (key) => Context.Service<unknown>(key)),
		apply: (input) =>
			Effect.map(
				Graft.plugin(plugin, input),
				(fork) => (next: unknown) => Effect.as(fork.update(next), true),
			),
	})

/** Merges an entry's intercept value over the outer one, by reference key. */
const intercepting = (key: string, value: unknown): Graft.Intercept => ({
	apply: (effect) =>
		Effect.updateContext(effect, (context: Context.Context<never>) => {
			// @effect-diagnostics-next-line serviceNotAsClass:off -- the key is read from the config file at runtime
			const reference = Context.Service<unknown>(key)
			const outer = Context.getOption(context, reference)
			const merged =
				Option.isSome(outer) &&
				Predicate.isObject(outer.value) &&
				Predicate.isObject(value)
					? { ...outer.value, ...value }
					: value
			return Context.add(context, reference, merged)
		}),
})

const optionsOf = (entry: Entry): Graft.PluginOptions => ({
	isolate: Arr.map(Record.toEntries(entry.isolate ?? {}), ([key, realm]) =>
		realm === true ? { key } : ([{ key }, realm] as const),
	),
	intercept: Arr.map(Record.toEntries(entry.intercept ?? {}), ([key, value]) =>
		intercepting(key, value),
	),
})

export const Group: Plugin.Plugin<
	ReadonlyArray<Entry>,
	ReadonlyArray<Entry>,
	never
> = Plugin.make({
	name: "group",
	config: Schema.Array(Entry),
	inject: [ModuleResolver],
	apply: (entries) =>
		Effect.gen(function* () {
			const resolver = yield* ModuleResolver
			const context = yield* Effect.context<Graft.Graft | Scope.Scope>()
			const children = yield* Ref.make(HashMap.empty<string, Child>())

			const load = (entry: Entry) =>
				Effect.gen(function* () {
					const resolved = yield* Effect.all([
						entry.group === true
							? Effect.succeed<Plugin.Plugin>(Group)
							: resolver.resolve(entry.name),
						resolveEnv(entry.config),
					]).pipe(
						Effect.map(([plugin, input]) => ({ plugin, input, failed: false })),
						Effect.catch((error) =>
							Effect.succeed({
								plugin: failing(entry.name, error),
								input: undefined,
								failed: true,
							}),
						),
					)
					const { plugin, input, failed } = resolved
					const target: Plugin.Plugin = Arr.isReadonlyArrayNonEmpty(
						entry.inject ?? [],
					)
						? waitingFor(entry.inject ?? [], plugin)
						: plugin
					const fork = yield* Graft.plugin(target, input, optionsOf(entry))
					return { entry, fork, failed } satisfies Child
				})

			const reconcile = Effect.fnUntraced(function* (
				next: ReadonlyArray<Entry>,
			) {
				const wanted = Arr.filter(next, (entry) => entry.disabled !== true)
				const byId = HashMap.fromIterable(
					Arr.map(wanted, (entry) => [entry.id, entry] as const),
				)
				let current = yield* Ref.get(children)
				for (const [id, child] of current) {
					const entry = HashMap.get(byId, id)
					if (
						Option.isNone(entry) ||
						!Equal.equals(shape(entry.value), shape(child.entry))
					) {
						yield* child.fork.dispose
						current = HashMap.remove(current, id)
					}
				}
				for (const entry of wanted) {
					const existing = HashMap.get(current, entry.id)
					const reusable = Option.filter(existing, (child) => !child.failed)
					// Nested groups always get the update, so a retry reaches their entries too.
					const unchanged = Option.exists(
						reusable,
						(child) =>
							entry.group !== true &&
							Equal.equals(child.entry.config, entry.config),
					)
					if (unchanged) continue
					const input = Option.isSome(reusable)
						? yield* Effect.option(resolveEnv(entry.config))
						: Option.none()
					if (Option.isSome(reusable) && Option.isSome(input)) {
						yield* reusable.value.fork.update(input.value)
						current = HashMap.set(current, entry.id, {
							...reusable.value,
							entry,
						})
						continue
					}
					if (Option.isSome(existing)) yield* existing.value.fork.dispose
					const child = yield* load(entry)
					current = HashMap.set(current, entry.id, child)
				}
				yield* Ref.set(children, current)
			})

			yield* reconcile(entries)
			return (next: ReadonlyArray<Entry>) =>
				Effect.as(Effect.provideContext(reconcile(next), context), true)
		}),
})
