/**
 * Turns the `name` of an entry into a plugin.
 */
import { ConfigDirectory } from "./ConfigDirectory"
import { isOnlyFailure } from "./internal/recovery"
import { Plugin } from "@graftland/graft"
import {
	Array,
	Cause,
	Context,
	Data,
	Effect,
	Exit,
	Layer,
	HashMap,
	Ref,
	Result,
	Option,
	Path,
	Predicate,
	Record,
	Schema,
	Scope,
	String,
} from "effect"

export class ModuleNotFound extends Schema.TaggedError<
	ModuleNotFound,
	{ readonly brand: unique symbol }
>()("ModuleNotFound", {
	plugin: Schema.String,
	tried: Schema.Array(Schema.String),
}) {
	override get message(): string {
		return `No plugin found for "${this.plugin}" (tried ${Array.join(this.tried, ", ")})`
	}
}

/** A module could not be imported, or plugin resolution found no plugin export. */
export class ModuleInvalid extends Schema.TaggedError<
	ModuleInvalid,
	{ readonly brand: unique symbol }
>()("ModuleInvalid", { specifier: Schema.String, cause: Schema.Unknown }) {
	override get message(): string {
		return `Module "${this.specifier}" could not be loaded`
	}
}

export class ModuleResolver extends Context.Service<
	ModuleResolver,
	{
		readonly importModule: (
			exactSpecifier: string,
			options?: ImportOptions,
		) => Effect.Effect<unknown, ModuleInvalid, Scope.Scope>
		readonly resolve: (
			name: string,
			options?: ImportOptions,
		) => Effect.Effect<
			Plugin.Plugin,
			ModuleNotFound | ModuleInvalid,
			Scope.Scope
		>
	}
>()("@graftland/loader/ModuleResolver") {}

const isPath = (name: string) =>
	String.startsWith(".")(name) || String.startsWith("/")(name)

/** The specifiers tried for a name, in order: as written, then the naming conventions for short names. */
export const candidates = (name: string): ReadonlyArray<string> =>
	isPath(name) || String.includes(":")(name) || String.startsWith("@")(name)
		? [name]
		: [name, `@graftland/plugin-${name}`, `graft-plugin-${name}`]

/** An error followed by its causes, outermost first. */
const causes = (error: unknown, depth = 0): ReadonlyArray<unknown> =>
	depth < 8 &&
	Predicate.hasProperty(error, "cause") &&
	error.cause !== undefined
		? [error, ...causes(error.cause, depth + 1)]
		: [error]

/** Node's message for a missing package or file, followed by its importer. */
const decodeNotFound = Schema.decodeUnknownOption(
	Schema.TemplateLiteralParser([
		"Cannot find ",
		Schema.Literals(["package", "module"]),
		" '",
		Schema.String.check(Schema.isPattern(/^[^']+$/)),
		"'",
		Schema.String,
	]),
)

/** What a module resolution error says is missing, if it is one. */
const missingName = (error: unknown): Option.Option<string> =>
	Predicate.hasProperty(error, "code") &&
	error.code === "ERR_MODULE_NOT_FOUND" &&
	Predicate.hasProperty(error, "message") &&
	Predicate.isString(error.message)
		? Option.map(decodeNotFound(error.message), ([, , , name]) => name)
		: Option.none()

/**
 * Whether an import failed because the candidate itself does not exist, as
 * opposed to something it imports. Only then is the next candidate tried.
 */
const isMissing = (error: unknown, candidate: ReadonlyArray<string>) =>
	Array.some(causes(error), (error) =>
		Option.exists(missingName(error), (name) =>
			Array.contains(candidate, name),
		),
	)

/** The package a bare specifier belongs to: `@scope/name` or `name`. */
const packageOf = (specifier: string) =>
	Array.join(
		Array.take(
			String.split("/")(specifier),
			String.startsWith("@")(specifier) ? 2 : 1,
		),
		"/",
	)

/** The caller owns observations even when a candidate's resources must close. */
export interface ImportOptions {
	readonly observationScope: Scope.Scope
}

/**
 * Opt-in resolution planning. Increment revision after installations, removals or
 * resolution changes. exists must only resolve names, without acquiring resources.
 * observe runs on every call, including cache hits, and owns missing-path watches.
 */
export interface ResolutionEnvironment<E = never> {
	readonly revision: Effect.Effect<number>
	readonly exists: (specifier: string) => Effect.Effect<boolean, E>
	readonly observe: (
		specifiers: ReadonlyArray<string>,
		options: ImportOptions,
	) => Effect.Effect<void, E, Scope.Scope>
}

export interface Options<E = never> {
	readonly resolution?: ResolutionEnvironment<E>

	readonly base: string
	readonly importer: (
		specifier: string,
		options: ImportOptions,
	) => Promise<unknown> | Effect.Effect<unknown, E, Scope.Scope>
}

class PlanKey extends Data.Class<{
	readonly name: string
	readonly target: string
}> {}

/** Failed attempts release their resources before recovery; successful leases stay with the entry. */
const inCandidateScope = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const parent = yield* Effect.scope
			const scope = yield* Scope.fork(parent)
			const result = yield* Effect.exit(
				restore(effect).pipe(Scope.provide(scope)),
			)
			if (Exit.isSuccess(result)) return result.value
			const closed = yield* Effect.exit(Scope.close(scope, result))
			return yield* Effect.failCause(
				Exit.isFailure(closed)
					? Cause.combine(result.cause, closed.cause)
					: result.cause,
			)
		}),
	)

/**
 * Resolves names with dynamic `import`. Relative specifiers are resolved
 * against `ConfigDirectory` when supplied, otherwise `base`; file URLs retain their query and fragment for importing, while
 * their decoded paths identify missing candidates. Bare specifiers go through
 * `importer`, which should run in the application so its dependencies are visible.
 * Effect importers may acquire
 * resources in a candidate scope owned by the entry lifecycle. A failed candidate
 * closes before fallback; a successful candidate remains leased until entry disposal.
 * Importers may attach observation-only leases to the separate observationScope.
 * The caller keeps that scope through failure and closes it on retry or disposal.
 */
export const make: <E>(
	options: Options<E>,
) => Effect.Effect<(typeof ModuleResolver)["Service"], never, Path.Path> =
	Effect.fnUntraced(function* <E>(options: Options<E>) {
		const path = yield* Path.Path
		/** Keep the import target and Node's possible missing names in one normalization step. */
		const normalize = Effect.fnUntraced(function* (specifier: string) {
			const invalid = (cause: unknown) =>
				ModuleInvalid.make({ specifier, cause })
			if (isPath(specifier)) {
				const directory = yield* ConfigDirectory
				const file = path.resolve(
					Option.getOrElse(directory, () => options.base),
					specifier,
				)
				const url = yield* path.toFileUrl(file).pipe(Effect.mapError(invalid))
				return { target: url.href, names: [specifier, file, url.href] }
			}
			if (String.startsWith("file:")(String.toLowerCase(specifier))) {
				const url = yield* Effect.try({
					try: () => new URL(specifier),
					catch: invalid,
				})
				const file = yield* path.fromFileUrl(url).pipe(Effect.mapError(invalid))
				return { target: specifier, names: [specifier, file, url.href] }
			}
			return {
				target: specifier,
				names: String.includes(":")(specifier)
					? [specifier]
					: [specifier, packageOf(specifier)],
			}
		})
		type Candidate = Effect.Success<ReturnType<typeof normalize>> & {
			readonly specifier: string
			readonly exists: Result.Result<boolean, ModuleInvalid>
		}
		const plans = yield* Ref.make({
			revision: -1,
			entries: HashMap.empty<PlanKey, ReadonlyArray<Candidate>>(),
		})
		const plan = Effect.fnUntraced(function* (name: string) {
			// Relative requests share a resolver but may come from different Include directories.
			const key = new PlanKey({ name, target: (yield* normalize(name)).target })
			const environment = options.resolution
			const revision =
				environment === undefined ? 0 : yield* environment.revision
			// Revisions only grow: a call that read an older one must not roll the cache back.
			const found = yield* Ref.modify(plans, (current) =>
				current.revision === revision
					? [HashMap.get(current.entries, key), current]
					: revision > current.revision
						? [
								Option.none(),
								{
									revision,
									entries: HashMap.empty<PlanKey, ReadonlyArray<Candidate>>(),
								},
							]
						: [Option.none(), current],
			)
			if (Option.isSome(found)) return found.value
			const normalized = yield* Effect.forEach(candidates(name), (specifier) =>
				Effect.map(normalize(specifier), (candidate) => ({
					...candidate,
					specifier,
				})),
			)
			// Keep probe failures in priority order. A later candidate's typed
			// failure matters only if all preceding candidates were missing.
			const selected = yield* Effect.forEach(normalized, (candidate) =>
				Effect.map(
					environment === undefined
						? Effect.succeed(Result.succeed(true))
						: environment.exists(candidate.target).pipe(
								Effect.mapError((cause) =>
									ModuleInvalid.make({ specifier: candidate.specifier, cause }),
								),
								Effect.result,
							),
					(exists) => ({ ...candidate, exists }),
				),
			)
			// A slow old plan cannot repopulate a cache after its revision changed.
			// Probe failures may be transient, so only fully answered plans are cached.
			yield* Ref.update(plans, (current) =>
				current.revision !== revision ||
				Array.some(selected, (candidate) => Result.isFailure(candidate.exists))
					? current
					: {
							...current,
							entries: HashMap.set(current.entries, key, selected),
						},
			)
			return selected
		})
		const load = Effect.fnUntraced(function* (
			specifier: string,
			candidate: { readonly target: string },
			observationScope: Scope.Scope,
		) {
			const context = yield* Effect.context<never>()
			return yield* Effect.tryPromise({
				try: (signal) => {
					// Start Promise importers inside the registration step, so even
					// immediate cancellation leaves their rejection observed.
					const imported = options.importer(candidate.target, {
						observationScope,
					})
					return Effect.isEffect(imported)
						? Promise.resolve(imported)
						: imported.then(Effect.succeed, (cause) => {
								if (signal.aborted)
									Effect.runSyncWith(context)(
										Effect.logError(
											"Module import failed after cancellation",
											Cause.die(cause),
										).pipe(Effect.annotateLogs({ specifier })),
									)
								throw cause
							})
				},
				catch: (cause) => ModuleInvalid.make({ specifier, cause }),
			}).pipe(
				Effect.flatMap((imported) =>
					imported.pipe(
						Effect.mapError((cause) =>
							ModuleInvalid.make({ specifier, cause }),
						),
					),
				),
			)
		})
		/** Only a missing candidate permits short-name fallback. */
		const attempt = Effect.fnUntraced(function* (
			candidate: Candidate,
			observationScope: Scope.Scope,
		) {
			const { specifier } = candidate
			return yield* load(specifier, candidate, observationScope).pipe(
				Effect.flatMap((module) =>
					Effect.fromOption(Plugin.fromModule(module), () =>
						ModuleInvalid.make({ specifier, cause: "it exports no plugin" }),
					),
				),
				inCandidateScope,
				Effect.asSome,
				Effect.catchCauseIf(
					(cause) =>
						isOnlyFailure(cause, (error) =>
							isMissing(error.cause, candidate.names),
						),
					() => Effect.succeedNone,
				),
			)
		})
		return {
			importModule: Effect.fnUntraced(function* (
				specifier: string,
				options?: ImportOptions,
			) {
				const caller = yield* Effect.scope
				const candidate = yield* normalize(specifier)
				return yield* load(
					specifier,
					candidate,
					options?.observationScope ?? caller,
				).pipe(inCandidateScope)
			}),
			resolve: Effect.fnUntraced(function* (
				name: string,
				importOptions?: ImportOptions,
			) {
				const caller = yield* Effect.scope
				const observationScope = importOptions?.observationScope ?? caller
				const tried = candidates(name)
				if (options.resolution !== undefined)
					yield* inCandidateScope(
						options.resolution
							.observe(tried, { observationScope })
							.pipe(
								Effect.mapError((cause) =>
									ModuleInvalid.make({ specifier: name, cause }),
								),
							),
					)
				const selected = yield* plan(name)
				for (const candidate of selected) {
					if (!(yield* Effect.fromResult(candidate.exists))) continue
					const plugin = yield* attempt(candidate, observationScope)
					if (Option.isSome(plugin)) return plugin.value
				}
				return yield* ModuleNotFound.make({ plugin: name, tried })
			}),
		}
	})

export const layer = <E>(
	options: Options<E>,
): Layer.Layer<ModuleResolver, never, Path.Path> =>
	Layer.effect(ModuleResolver, make(options))

/** Resolves names from a fixed table, for tests and bundled applications. */
export const fromRecord = (
	plugins: Readonly<Record<string, Plugin.Plugin>>,
): Layer.Layer<ModuleResolver> =>
	Layer.succeed(ModuleResolver, {
		importModule: (specifier) =>
			Effect.suspend(() =>
				Effect.fromOption(Record.get(plugins, specifier), () =>
					ModuleInvalid.make({
						specifier,
						cause: "it is not in the module table",
					}),
				).pipe(Effect.map((plugin) => ({ default: plugin }))),
			),
		resolve: (name) =>
			Effect.suspend(() =>
				Effect.fromOption(Record.get(plugins, name), () =>
					ModuleNotFound.make({ plugin: name, tried: [name] }),
				),
			),
	})
