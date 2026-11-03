/**
 * Hot module replacement for Graft plugins on Node.js.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- native import resolution must work without requiring a platform layer
import { realpath } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Data,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	FileSystem,
	HashMap,
	HashSet,
	Option,
	Ref,
	Result,
	String,
	Schema,
	Semaphore,
	Stream,
	Scope,
} from "effect"
import type { Duration, PlatformError } from "effect"
import { changes } from "./internal/changes"
import {
	isMissingEntry,
	modules,
	RestartRequired,
	type Attempt,
} from "./internal/modules"

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

export type WatchResult = Data.TaggedEnum<{
	Reloaded: { readonly entries: ReadonlyArray<string> }
	Skipped: {
		readonly modules: ReadonlyArray<string>
		readonly reason:
			"restart-required" | "ambiguous-exports" | "identity-conflict"
	}
	Failed: { readonly cause: Cause.Cause<HmrError> }
}>

export const WatchResult = Data.taggedEnum<WatchResult>()

export type ReloadResult = Exclude<WatchResult, { readonly _tag: "Failed" }>

export interface Options {
	/** Application module URL, usually import.meta.url; used for bare and relative resolution. */
	readonly base: string
	/** Files to version. Defaults to file URLs outside node_modules. Entries are always included. */
	readonly include?: (url: string) => boolean
}

export interface WatchOptions extends FileSystem.WatchOptions {
	readonly debounce?: Duration.Input
	/** Receives an absolute file path; applies to native events and reconciliation. */
	readonly filter?: (path: string) => boolean
}

/** Separates retry observations from an importer's temporary resource scope. */
export interface ImportOptions {
	readonly observationScope: Scope.Scope
}

export interface Hmr {
	/** Keeps imported entries registered until this HMR session closes. */
	readonly importer: (specifier: string) => Promise<unknown>
	/** Registers an observation lease in observationScope, or the caller's scope when omitted. */
	readonly importerScoped: (
		specifier: string,
		options?: ImportOptions,
	) => Effect.Effect<unknown, HmrError, Scope.Scope>
	/** Imports every entry before replacing anything. Activation failures belong to Graft. */
	readonly reload: Effect.Effect<ReloadResult, HmrError>
	/**
	 * Consuming this stream installs watchers and checks loaded module contents once
	 * per second to recover missed events. Known native loading limitations emit
	 * Skipped even without a file event. The consumer owns the stream's lifetimes.
	 */
	readonly watch: (
		paths: ReadonlyArray<string>,
		options?: WatchOptions,
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
		// A lease owns both the running graph and its latest uncommitted attempt.
		const owners = yield* Ref.make(
			HashMap.empty<
				symbol,
				{
					readonly active: Option.Option<Attempt>
					readonly pending: Option.Option<Attempt>
				}
			>(),
		)
		const closed = yield* Ref.make(false)
		const session = yield* Effect.scope
		// Transfer the complete Exit before restoring interruption. Effect may replace
		// a failed masked operation with pending interruption at that boundary.
		const preserveExit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const completed = yield* Deferred.make<Exit.Exit<A, E>>()
				return yield* effect.pipe(
					Effect.exit,
					Effect.tap((exit) => Deferred.succeed(completed, exit)),
					Effect.uninterruptible,
					Effect.flatten,
					Effect.onExit((exit) =>
						Effect.gen(function* () {
							if (Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause))
								return
							const saved = yield* Deferred.poll(completed)
							if (Option.isNone(saved)) return
							const original = yield* saved.value
							if (Exit.isFailure(original))
								yield* Effect.logError(
									"HMR operation failed during cancellation",
									original.cause,
								)
						}),
					),
				)
			})
		// Native imports cannot be cancelled: keep the lock until their promises settle.
		const serial = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(preserveExit, semaphore.withPermits(1))
		const hooks = yield* Effect.acquireRelease(
			Effect.sync(() =>
				modules(
					options.base,
					options.include ??
						((url) =>
							!String.includes("/node_modules/")(new URL(url).pathname)),
				),
			),
			(hooks) =>
				serial(
					Ref.set(closed, true).pipe(Effect.andThen(Effect.sync(hooks.close))),
				),
		)
		const state = yield* Ref.make({
			generation: hooks.prepare(),
			entries: HashMap.empty<
				string,
				{
					readonly plugin: Plugin.Plugin
					readonly leases: HashSet.HashSet<symbol>
				}
			>(),
		})
		// Stop Promise-backed operations before releasing their leases. Otherwise
		// a lease finalizer could wait on an import before its owner interrupts it.
		const imports = yield* Scope.fork(session)
		const run = yield* FiberSet.makeRuntimePromise<never, unknown, HmrError>()
		const closedError = () =>
			HmrError.make({
				stage: "closed",
				specifier: "",
				cause: "HMR scope is closed",
			})
		const checkOpen = Ref.get(closed).pipe(
			Effect.flatMap((closed) =>
				closed ? Effect.fail(closedError()) : Effect.void,
			),
		)
		const physicalTarget = (request: string) =>
			Effect.tryPromise({
				try: () => realpath(fileURLToPath(request)),
				catch: (cause) =>
					HmrError.make({ stage: "import", specifier: request, cause }),
			}).pipe(
				Effect.map((path) => pathToFileURL(path).href),
				Effect.catchIf(
					(error) => isMissingEntry(request, error.cause),
					() => Effect.undefined,
				),
			)
		const changedResolution = Effect.fnUntraced(function* (
			attempt: Pick<Attempt, "url" | "request">,
		) {
			if (attempt.request === undefined) return Option.none<string>()
			const request = attempt.request
			const expected = pathToFileURL(fileURLToPath(attempt.url)).href
			const actual = yield* physicalTarget(request)
			if (actual === expected) return Option.none<string>()
			// If both paths disappeared, this is ordinary entry deletion. A
			// missing link with a surviving old target must never reload that target.
			if (actual === undefined) {
				const remaining = yield* physicalTarget(attempt.url)
				if (remaining === undefined) return Option.none<string>()
			}
			return Option.some(request)
		})

		const changedResolutions = Ref.get(owners).pipe(
			Effect.flatMap((owners) =>
				Effect.forEach(
					hooks.resolutions(
						Array.flatMap(HashMap.toValues(owners), (owner) =>
							Array.getSomes([owner.active, owner.pending]),
						),
					),
					changedResolution,
				),
			),
			Effect.map((changes) =>
				Array.fromIterable(HashSet.fromIterable(Array.getSomes(changes))),
			),
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
			const url = yield* Effect.fromOption(hooks.resolved()).pipe(
				Effect.mapError((cause) =>
					HmrError.make({ stage: "import", specifier, cause }),
				),
			)
			const request = hooks.fileRequest(specifier)
			const attempt = {
				url,
				...Option.match(request, {
					onNone: () => ({}),
					onSome: (request) => ({ request }),
				}),
			}
			const changed = yield* changedResolution(attempt)
			if (Option.isSome(changed))
				return yield* HmrError.make({
					stage: "import",
					specifier,
					cause: RestartRequired.make({ url: changed.value }),
				})
			return { namespace, plugin: plugin.value, url }
		})
		const importWithLease = (specifier: string) =>
			Effect.acquireRelease(
				serial(
					Effect.gen(function* () {
						yield* checkOpen
						const current = yield* Ref.get(state)
						hooks.start(current.generation)
						// Acquire an owner for either Exit. Rethrow only after its finalizer
						// is registered, so failed imports remain available for scoped retry.
						const exit = yield* Effect.exit(load(specifier))
						const token: symbol = Symbol()
						const root = Option.orElse(hooks.resolved(), () =>
							String.startsWith("file:")(specifier)
								? Option.some(specifier)
								: Option.none(),
						)
						const attempt = Option.map(root, (url) => ({
							url,
							generation: current.generation,
							...Option.match(hooks.fileRequest(specifier), {
								onNone: () => ({}),
								onSome: (request) => ({ request }),
							}),
						}))
						yield* Ref.update(
							owners,
							HashMap.set(token, {
								active: Exit.isSuccess(exit) ? attempt : Option.none(),
								pending: Exit.isFailure(exit) ? attempt : Option.none(),
							}),
						)
						if (Exit.isSuccess(exit)) {
							const entry = exit.value
							const previous = HashMap.get(current.entries, entry.url)
							const leases = Option.match(previous, {
								onNone: () => HashSet.empty<symbol>(),
								onSome: (entry) => entry.leases,
							})
							yield* Ref.set(state, {
								...current,
								entries: HashMap.set(current.entries, entry.url, {
									plugin: entry.plugin,
									leases: HashSet.add(leases, token),
								}),
							})
						}
						return { token, exit: Exit.map(exit, (entry) => entry.namespace) }
					}).pipe(Effect.ensuring(Effect.sync(hooks.discard))),
				),
				({ token }) =>
					serial(
						Effect.gen(function* () {
							yield* Ref.update(owners, HashMap.remove(token))
							yield* Ref.update(state, (current) => ({
								...current,
								entries: HashMap.filterMap(current.entries, (entry) => {
									const leases = HashSet.remove(entry.leases, token)
									return HashSet.size(leases) === 0
										? Result.fail(undefined)
										: Result.succeed({ ...entry, leases })
								}),
							}))
						}),
					),
			).pipe(
				Effect.flatMap(({ exit }) => exit),
				preserveExit,
			)

		const importerScoped: Hmr["importerScoped"] = (specifier, options) =>
			options === undefined
				? importWithLease(specifier)
				: importWithLease(specifier).pipe(
						Scope.provide(options.observationScope),
					)

		const importer = (specifier: string): Promise<unknown> =>
			// A closed FiberSet interrupts new work before checkOpen can execute.
			Ref.getUnsafe(closed)
				? Promise.reject(closedError())
				: run(
						importerScoped(specifier).pipe(
							Effect.provideService(Scope.Scope, imports),
						),
					)

		const unsupportedModules = Ref.get(state).pipe(
			Effect.map(({ generation, entries }) =>
				hooks.unsupported(
					generation,
					Array.fromIterable(HashMap.keys(entries)),
				),
			),
		)

		const reload = serial(
			Effect.gen(function* () {
				yield* checkOpen
				const changed = yield* changedResolutions
				if (changed.length > 0)
					return WatchResult.Skipped({
						reason: "restart-required",
						modules: changed,
					})
				const { entries } = yield* Ref.get(state)
				const unsupported = yield* unsupportedModules
				if (HashSet.size(unsupported) > 0)
					return WatchResult.Skipped({
						modules: Array.fromIterable(unsupported),
						reason: "restart-required",
					})
				// Advance even without entries so retries bypass cached failed imports.
				const candidate = hooks.prepare()
				hooks.start(candidate, true)
				return yield* Effect.gen(function* () {
					const loaded = yield* Effect.forEach(entries, ([url, previous]) =>
						Ref.update(
							owners,
							HashMap.map((owner, token) =>
								HashSet.has(previous.leases, token)
									? {
											...owner,
											pending: Option.map(owner.active, (attempt) => ({
												...attempt,
												url,
												generation: candidate,
											})),
										}
									: owner,
							),
						).pipe(
							Effect.andThen(load(url)),
							Effect.map((entry) =>
								Option.some({
									url,
									previous: previous.plugin,
									leases: previous.leases,
									plugin: entry.plugin,
								}),
							),
							Effect.catchIf(
								(error) =>
									error.stage === "import" && isMissingEntry(url, error.cause),
								() => Effect.succeedNone,
							),
						),
					)
					const candidates = Array.getSomes(loaded)
					const alternatives = Array.reduce(
						candidates,
						HashMap.empty<Plugin.Plugin, HashSet.HashSet<Plugin.Plugin>>(),
						(groups, { previous, plugin }) =>
							HashMap.set(
								groups,
								previous,
								HashSet.add(
									Option.getOrElse(
										HashMap.get(groups, previous),
										HashSet.empty<Plugin.Plugin>,
									),
									plugin,
								),
							),
					)
					const ambiguous = Array.filter(candidates, ({ previous }) =>
						Option.exists(
							HashMap.get(alternatives, previous),
							(plugins) => HashSet.size(plugins) > 1,
						),
					)
					if (ambiguous.length > 0)
						return WatchResult.Skipped({
							reason: "ambiguous-exports",
							modules: Array.map(ambiguous, ({ url }) => url),
						})
					const next = HashMap.fromIterable(
						Array.map(
							candidates,
							({ url, plugin, leases }) => [url, { plugin, leases }] as const,
						),
					)
					const pairs = Array.map(
						candidates,
						({ previous, plugin }) => [previous, plugin] as const,
					)
					const changed = yield* changedResolutions
					if (changed.length > 0)
						return WatchResult.Skipped({
							reason: "restart-required",
							modules: changed,
						})
					const replacement = yield* Graft.replace(pairs).pipe(
						Effect.provideService(Graft.Graft, graft),
						Effect.result,
					)
					if (Result.isFailure(replacement))
						return WatchResult.Skipped({
							reason: "identity-conflict",
							modules: Array.filterMap(candidates, ({ url }, index) =>
								Array.contains(replacement.failure.indices, index)
									? Result.succeed(url)
									: Result.fail(undefined),
							),
						})
					yield* Ref.update(owners, (owners) =>
						Array.reduce(candidates, owners, (owners, { url, leases }) =>
							HashMap.map(owners, (owner, token) =>
								HashSet.has(leases, token)
									? {
											active: Option.map(owner.pending, (attempt) => ({
												...attempt,
												url,
												generation: candidate,
											})),
											pending: Option.none(),
										}
									: owner,
							),
						),
					)
					yield* Ref.set(state, { entries: next, generation: candidate })
					return WatchResult.Reloaded({
						entries: Array.fromIterable(HashMap.keys(next)),
					})
				}).pipe(
					Effect.catchIf(
						(error): error is HmrError & { readonly cause: RestartRequired } =>
							Schema.is(RestartRequired)(error.cause),
						(error) =>
							Effect.succeed(
								WatchResult.Skipped({
									modules: Array.fromIterable(
										HashSet.add(hooks.unsupported(candidate), error.cause.url),
									),
									reason: "restart-required",
								}),
							),
					),
					Effect.ensuring(Effect.sync(hooks.discard)),
				)
			}),
		)
		return {
			importer,
			importerScoped,
			reload,
			watch: (paths, watchOptions) =>
				paths.length === 0
					? Stream.empty
					: changes(
							(use) =>
								Ref.get(owners).pipe(
									Effect.map((owners) =>
										hooks.files([
											...Array.getSomes(
												Array.map(
													HashMap.toValues(owners),
													(owner) => owner.active,
												),
											),
											...Array.getSomes(
												Array.map(
													HashMap.toValues(owners),
													(owner) => owner.pending,
												),
											),
										]),
									),
									Effect.flatMap(use),
									// Hold ownership through the reads, so release cannot leave
									// an in-flight snapshot reading a retired path.
									semaphore.withPermits(1),
								),
							paths,
							watchOptions,
						).pipe(
							Stream.debounce(watchOptions?.debounce ?? "50 millis"),
							Stream.mapEffect(() =>
								Effect.map(Effect.exit(reload), (exit): WatchResult =>
									Exit.isSuccess(exit)
										? exit.value
										: WatchResult.Failed({ cause: exit.cause }),
								),
							),
							// Native caches may hide both dependency edges and the first save.
							// Report known restart requirements independently of filesystem events.
							Stream.merge(
								Stream.tick("1 second").pipe(
									Stream.mapEffect(() =>
										unsupportedModules.pipe(semaphore.withPermits(1)),
									),
									Stream.changes,
									Stream.filter((modules) => HashSet.size(modules) > 0),
									Stream.map((modules) =>
										WatchResult.Skipped({
											reason: "restart-required",
											modules: Array.fromIterable(modules),
										}),
									),
								),
							),
						),
		}
	})
