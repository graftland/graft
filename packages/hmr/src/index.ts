/**
 * Hot module replacement for Graft plugins on Node.js.
 */
import { Graft, Plugin } from "@graftland/graft"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FiberSet,
	FileSystem,
	HashMap,
	HashSet,
	Option,
	String as Str,
	Schema,
	Semaphore,
	Stream,
} from "effect"
import type { Duration, PlatformError, Scope } from "effect"
import { isMissingEntry, modules, RestartRequired } from "./internal/modules"

export class HmrError extends Schema.TaggedError<
	HmrError,
	{ readonly brand: unique symbol }
>()("HmrError", {
	stage: Schema.Literals(["import", "exports", "closed"]),
	specifier: Schema.String,
	cause: Schema.Unknown,
}) {
	override get message(): string {
		return `HMR ${this.stage} failed for ${this.specifier || "the closed session"}`
	}
}

export type ReloadResult =
	| { readonly _tag: "Reloaded"; readonly entries: ReadonlyArray<string> }
	| {
			readonly _tag: "Skipped"
			readonly modules: ReadonlyArray<string>
			readonly reason: "restart-required"
	  }

export type WatchResult =
	| ReloadResult
	| {
			readonly _tag: "Failed"
			readonly cause: Cause.Cause<HmrError>
	  }

export interface Options {
	/** Application module URL, usually import.meta.url; used for bare and relative resolution. */
	readonly base: string
	/** Files to version. Defaults to file URLs outside node_modules. Entries are always included. */
	readonly include?: (url: string) => boolean
}

export interface Hmr {
	/** Pass directly to ModuleResolver.layer({ base, importer }). */
	readonly importer: (specifier: string) => Promise<unknown>
	/** Imports every entry before replacing anything. Activation failures belong to Graft. */
	readonly reload: Effect.Effect<ReloadResult, HmrError>
	/** Consuming this stream installs the watchers; the consumer owns their lifetime. */
	readonly watch: (
		paths: ReadonlyArray<string>,
		options?: FileSystem.WatchOptions & { readonly debounce?: Duration.Input },
	) => Stream.Stream<
		WatchResult,
		PlatformError.PlatformError,
		FileSystem.FileSystem
	>
}

/**
 * Installs Node module hooks until the enclosing scope closes. Module evaluation
 * must be side-effect free. Versioned ESM cache entries are not reclaimed.
 */
export const make = (
	options: Options,
): Effect.Effect<Hmr, never, Graft.Graft | Scope.Scope> =>
	Effect.gen(function* () {
		const graft = yield* Graft.Graft
		const semaphore = yield* Semaphore.make(1)
		let closed = false
		// Native imports cannot be cancelled: keep the lock until their promises settle.
		const serial = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			semaphore.withPermits(1)(Effect.uninterruptible(effect))
		const hooks = yield* Effect.acquireRelease(
			Effect.sync(() =>
				modules(
					options.base,
					options.include ??
						((url) => !Str.includes("/node_modules/")(new URL(url).pathname)),
				),
			),
			(hooks) =>
				serial(
					Effect.sync(() => {
						closed = true
						hooks.close()
					}),
				),
		)
		let generation = hooks.prepare()
		let entries = HashMap.empty<string, Plugin.Plugin>()
		const run = yield* FiberSet.makeRuntimePromise<never, unknown, HmrError>()
		const checkOpen = Effect.suspend(() =>
			closed
				? Effect.fail(
						HmrError.make({
							stage: "closed",
							specifier: "",
							cause: "HMR scope is closed",
						}),
					)
				: Effect.void,
		)
		const load = Effect.fnUntraced(function* (specifier: string) {
			const namespace = yield* Effect.tryPromise({
				try: () => import(/* @vite-ignore */ hooks.request(specifier)),
				catch: (cause) => HmrError.make({ stage: "import", specifier, cause }),
			})
			const plugin = Plugin.fromModule(namespace)
			if (Option.isNone(plugin))
				return yield* HmrError.make({
					stage: "exports",
					specifier,
					cause: "Expected a default or named plugin export",
				})
			return { namespace, plugin: plugin.value, url: hooks.resolved()! }
		})
		const importer = (specifier: string): Promise<unknown> =>
			run(
				Effect.gen(function* () {
					yield* checkOpen
					hooks.start(generation)
					const entry = yield* load(specifier)
					entries = HashMap.set(entries, entry.url, entry.plugin)
					return entry.namespace
				}).pipe(Effect.ensuring(Effect.sync(hooks.discard)), serial),
			)
		const reload = serial(
			Effect.gen(function* () {
				yield* checkOpen
				if (HashSet.size(generation.unsupported) > 0)
					return {
						_tag: "Skipped" as const,
						modules: Arr.fromIterable(generation.unsupported),
						reason: "restart-required" as const,
					}
				// Advance even without entries so retries bypass cached failed imports.
				const candidate = hooks.prepare()
				hooks.start(candidate, true)
				return yield* Effect.gen(function* () {
					let next = HashMap.empty<string, Plugin.Plugin>()
					let pairs: ReadonlyArray<readonly [Plugin.Plugin, Plugin.Plugin]> = []
					for (const [url, previous] of entries) {
						const entry = yield* load(url).pipe(
							Effect.catchIf(
								(error) =>
									error.stage === "import" && isMissingEntry(url, error.cause),
								() => Effect.undefined,
							),
						)
						if (entry === undefined) continue
						next = HashMap.set(next, url, entry.plugin)
						pairs = Arr.append(pairs, [previous, entry.plugin])
					}
					yield* Graft.replace(pairs).pipe(
						Effect.provideService(Graft.Graft, graft),
					)
					entries = next
					generation = candidate
					return {
						_tag: "Reloaded" as const,
						entries: Arr.fromIterable(HashMap.keys(entries)),
					}
				}).pipe(
					Effect.catchIf(
						(error) => Schema.is(RestartRequired)(error.cause),
						() =>
							Effect.succeed({
								_tag: "Skipped" as const,
								modules: Arr.fromIterable(candidate.unsupported),
								reason: "restart-required" as const,
							}),
					),
					Effect.ensuring(Effect.sync(hooks.discard)),
				)
			}),
		)
		return {
			importer,
			reload,
			watch: (paths, watchOptions) =>
				Stream.unwrap(
					Effect.map(FileSystem.FileSystem, (fs) =>
						Stream.mergeAll(
							Arr.map(paths, (path) => fs.watch(path, watchOptions)),
							{ concurrency: "unbounded" },
						).pipe(
							Stream.debounce(watchOptions?.debounce ?? "50 millis"),
							Stream.mapEffect(() =>
								Effect.map(Effect.exit(reload), (exit): WatchResult =>
									Exit.isSuccess(exit)
										? exit.value
										: { _tag: "Failed", cause: exit.cause },
								),
							),
						),
					),
				),
		}
	})
