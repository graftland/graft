// Node's synchronous module hooks have no Effect equivalent.
import { Base64 } from "effect/encoding"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
	Array,
	HashMap,
	HashSet,
	Option,
	Predicate,
	Schema,
	String,
} from "effect"

export class RestartRequired extends Schema.TaggedError<
	RestartRequired,
	{ readonly brand: unique symbol }
>()("RestartRequired", { url: Schema.String }) {}

// Only a missing entry is disposable; missing dependencies still fail the reload.
export const isMissingEntry = (url: string, cause: unknown): boolean =>
	String.startsWith("file:")(url) &&
	Predicate.hasProperty(cause, "code") &&
	((cause.code === "ERR_MODULE_NOT_FOUND" &&
		Predicate.hasProperty(cause, "url") &&
		cause.url === url) ||
		(cause.code === "ENOENT" &&
			Predicate.hasProperty(cause, "path") &&
			cause.path === fileURLToPath(url)))

// Allocated only when a session starts; importing this module performs no I/O.
let sessions = 0

export interface Generation {
	readonly id: number
}

/** Bytes actually read by a particular native import attempt. */
export interface FileVersion {
	readonly generation: number
	readonly content: string | undefined
	readonly resolution?: string
}

export interface Attempt {
	readonly generation: Generation
	readonly url: string
	readonly request?: string
}

interface Dependency extends Attempt {
	readonly parent: string
}

/** Resolve local requests lexically; Node's cached physical target is a separate fact. */
const fileRequest = (
	specifier: string,
	parent: string,
): Option.Option<string> => {
	if (
		!Array.some(["file:", "./", "../", "/"], (prefix) =>
			String.startsWith(prefix)(specifier),
		)
	)
		return Option.none()
	const url = new URL(specifier, parent)
	return url.protocol === "file:" ? Option.some(url.href) : Option.none()
}

/** A scoped Node hook. Mutable bindings bridge synchronous hooks to Effect. */
export const modules = (base: string, include: (url: string) => boolean) => {
	const key = `graft-hmr-${++sessions}`
	const prefix = `${key}:`
	const rawPrefix = `${key}:raw:`
	/** What `request` produces: the generation that imports a specifier. */
	const decodeRequest = Schema.decodeUnknownOption(
		Schema.TemplateLiteralParser([
			prefix,
			Schema.String.check(Schema.isPattern(/^\d+$/)),
			":",
			Schema.String,
		]),
	)
	let revision = 0
	let importing:
		{ readonly generation: Generation; readonly reload: boolean } | undefined
	// Dependency facts outlive an import operation: apply may import modules later.
	let dependencies = HashMap.empty<string, HashSet.HashSet<string>>()
	let edges = HashMap.empty<
		string,
		HashMap.HashMap<string, HashMap.HashMap<string, Dependency>>
	>()
	const link = (
		id: string,
		parent: string,
		child: string,
		request?: string,
	) => {
		const graph = Option.getOrElse(
			HashMap.get(edges, id),
			HashMap.empty<string, HashMap.HashMap<string, Dependency>>,
		)
		const children = Option.getOrElse(
			HashMap.get(graph, parent),
			HashMap.empty<string, Dependency>,
		)
		edges = HashMap.set(
			edges,
			id,
			HashMap.set(
				graph,
				parent,
				HashMap.set(children, request ?? child, {
					generation: { id: Number(id) },
					parent,
					url: child,
					...(request === undefined ? {} : { request }),
				}),
			),
		)
	}
	const reachable = (id: string, roots: ReadonlyArray<string>) => {
		const graph = Option.getOrElse(
			HashMap.get(edges, id),
			HashMap.empty<string, HashMap.HashMap<string, Dependency>>,
		)
		let seen = HashSet.empty<string>()
		let pending = roots
		while (Array.isReadonlyArrayNonEmpty(pending)) {
			const [url, ...rest] = pending
			pending = rest
			if (HashSet.has(seen, url)) continue
			seen = HashSet.add(seen, url)
			pending = Array.appendAll(
				pending,
				Array.map(
					HashMap.toValues(
						Option.getOrElse(
							HashMap.get(graph, url),
							HashMap.empty<string, Dependency>,
						),
					),
					(edge) => edge.url,
				),
			)
		}
		return seen
	}
	// Both checks and polling derive resolution facts from the same owned graph.
	const resolutionsFor = (attempt: Attempt): ReadonlyArray<Attempt> => {
		const id = String.String(attempt.generation.id)
		const used = reachable(id, [attempt.url])
		const graph = Option.getOrElse(
			HashMap.get(edges, id),
			HashMap.empty<string, HashMap.HashMap<string, Dependency>>,
		)
		return [
			...(attempt.request === undefined ? [] : [attempt]),
			...Array.flatMap(HashMap.toValues(graph), (children) =>
				Array.filter(
					HashMap.toValues(children),
					(edge) =>
						edge.request !== undefined && HashSet.has(used, edge.parent),
				),
			),
		]
	}

	let sources = HashMap.empty<string, HashMap.HashMap<string, string>>()
	let resolved: string | undefined

	const prepare = (): Generation => ({
		id: ++revision,
	})
	const clean = (url: string): string => {
		const value = new URL(url)
		value.searchParams.delete(key)
		return value.href
	}
	const version = (url: string | undefined): string | null =>
		url === undefined ? null : new URL(url).searchParams.get(key)
	const unsupported = (url: string, format: string | null | undefined) =>
		format === "commonjs" ||
		format === "commonjs-typescript" ||
		format === "addon" ||
		String.endsWith(".node")(new URL(url).pathname)
	const requireRestart = (url: string, id: string) => {
		dependencies = HashMap.set(
			dependencies,
			id,
			HashSet.add(
				Option.getOrElse(HashMap.get(dependencies, id), HashSet.empty<string>),
				url,
			),
		)
		if (
			importing !== undefined &&
			String.String(importing.generation.id) === id &&
			importing.reload
		)
			throw RestartRequired.make({ url })
	}

	const record = (
		url: string,
		id: string,
		format: string | null | undefined,
	) => {
		if (unsupported(url, format)) requireRestart(url, id)
	}

	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (String.startsWith(rawPrefix)(specifier))
				return nextResolve(String.slice(rawPrefix.length)(specifier), {
					...context,
					parentURL: base,
				})
			const request = decodeRequest(specifier)
			const entry = Option.isSome(request)
			const id = Option.match(request, {
				onNone: () => version(context.parentURL),
				onSome: ([, id]) => id,
			})
			if (id === null) return nextResolve(specifier, context)
			const resolve = () =>
				nextResolve(
					Option.match(request, {
						onNone: () => specifier,
						onSome: ([, , , target]) => target,
					}),
					{
						...context,
						parentURL: entry ? base : clean(context.parentURL!),
					},
				)
			const result = (() => {
				try {
					return resolve()
				} catch (cause) {
					// Node reports the missing file even though resolution did not complete.
					if (
						Predicate.hasProperty(cause, "url") &&
						typeof cause.url === "string" &&
						String.startsWith("file:")(cause.url)
					) {
						if (entry) resolved = cause.url
						else if (context.parentURL !== undefined && include(cause.url))
							link(
								id,
								clean(context.parentURL),
								cause.url,
								Option.getOrUndefined(
									fileRequest(specifier, clean(context.parentURL)),
								),
							)
					}
					throw cause
				}
			})()
			if (entry) resolved = result.url
			// Acquiring node:module permits require calls that Node can satisfy
			// without hooks. Record this capability before any cache can hide them.
			if (
				!entry &&
				result.url === "node:module" &&
				context.parentURL !== undefined
			) {
				link(id, clean(context.parentURL), result.url)
				requireRestart(result.url, id)
			}
			if (
				!String.startsWith("file:")(result.url) ||
				(!entry && !include(result.url))
			)
				return result
			if (!entry && context.parentURL !== undefined)
				link(
					id,
					clean(context.parentURL),
					result.url,
					Option.getOrUndefined(
						fileRequest(specifier, clean(context.parentURL)),
					),
				)
			const required = Array.contains(context.conditions, "require")
			if (required) requireRestart(result.url, id)
			else record(result.url, id, result.format)
			if (required || unsupported(result.url, result.format)) return result
			const url = new URL(result.url)
			url.searchParams.set(key, id)
			return { ...result, url: url.href }
		},
		load(url, context, nextLoad) {
			const id = version(url)
			if (id === null) return nextLoad(url, context)
			const original = clean(url)
			record(original, id, context.format)
			const result = nextLoad(original, context)
			const source = result.source
			if (source !== undefined && source !== null) {
				const bytes =
					typeof source === "string"
						? source
						: ArrayBuffer.isView(source)
							? new Uint8Array(
									source.buffer,
									source.byteOffset,
									source.byteLength,
								)
							: new Uint8Array(source)
				sources = HashMap.set(
					sources,
					id,
					HashMap.set(
						Option.getOrElse(
							HashMap.get(sources, id),
							HashMap.empty<string, string>,
						),
						original,
						Base64.encode(bytes),
					),
				)
			}
			record(original, id, result.format)
			return result
		},
	})
	return {
		prepare,
		fileRequest: (specifier: string) => fileRequest(specifier, base),
		resolutions: (attempts: ReadonlyArray<Attempt>) =>
			Array.flatMap(attempts, resolutionsFor),
		files: (attempts: ReadonlyArray<Attempt>) =>
			Array.reduce(
				attempts,
				HashMap.empty<string, FileVersion>(),
				(files, { generation, url, request }) => {
					const contents = Option.getOrElse(
						HashMap.get(sources, String.String(generation.id)),
						HashMap.empty<string, string>,
					)
					const unversioned = Option.getOrElse(
						HashMap.get(dependencies, String.String(generation.id)),
						HashSet.empty<string>,
					)
					const tracked = Array.reduce(
						Array.fromIterable(reachable(String.String(generation.id), [url])),
						files,
						(files, url) => {
							if (
								!String.startsWith("file:")(url) ||
								HashSet.has(unversioned, url)
							)
								return files
							// A retained failed lease must not override a newer import
							// of the same file just because its owner is visited last.
							if (
								Option.exists(
									HashMap.get(files, url),
									(current) =>
										current.generation > generation.id ||
										(current.generation === generation.id &&
											current.resolution !== undefined),
								)
							)
								return files
							return HashMap.set(files, url, {
								generation: generation.id,
								content: Option.getOrUndefined(HashMap.get(contents, url)),
							})
						},
					)
					return Array.reduce(
						resolutionsFor({
							generation,
							url,
							...(request === undefined ? {} : { request }),
						}),
						tracked,
						(files, edge) => {
							if (
								edge.request === undefined ||
								HashSet.has(unversioned, edge.url) ||
								Option.exists(
									HashMap.get(files, edge.request),
									(file) => file.generation > generation.id,
								)
							)
								return files
							return HashMap.set(files, edge.request, {
								generation: generation.id,
								content: Option.getOrUndefined(HashMap.get(contents, edge.url)),
								resolution: pathToFileURL(fileURLToPath(edge.url)).href,
							})
						},
					)
				},
			),
		unsupported: (generation: Generation, roots?: ReadonlyArray<string>) => {
			const found = Option.getOrElse(
				HashMap.get(dependencies, String.String(generation.id)),
				HashSet.empty<string>,
			)
			if (roots === undefined) return found
			const used = reachable(String.String(generation.id), roots)
			return HashSet.filter(found, (url) => HashSet.has(used, url))
		},
		start: (generation: Generation, reload = false) => {
			importing = { generation, reload }
		},
		discard: () => {
			importing = undefined
		},
		request: (specifier: string) => {
			resolved = undefined
			return `${prefix}${importing!.generation.id}:${specifier}`
		},
		rawRequest: (specifier: string) => `${rawPrefix}${specifier}`,
		resolved: () => Option.fromUndefinedOr(resolved),
		close: () => hooks.deregister(),
	}
}
