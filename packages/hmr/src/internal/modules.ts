// Node's synchronous module hooks have no Effect equivalent.
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
	Array,
	Chunk,
	HashMap,
	HashSet,
	Option,
	Predicate,
	Schema,
	String,
} from "effect"

import { digest } from "./digest"

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

/** A resolution view that allocates fresh URLs for new or invalidated instances. */
export interface Generation {
	readonly id: number
}

/** Digest of the bytes actually loaded by a concrete module instance. */
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
	readonly node: string
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
	let resolved: string | undefined
	// Resolution views contain only routing identities. Old code can execute after
	// replacement (including teardown), so these persistent maps live until close.
	// Cached instances also retain their facts: Node does not replay static imports.
	// Leases restrict observation, not the lifetime of old routing targets.
	let views = HashMap.empty<number, HashMap.HashMap<string, string>>()
	let edges = HashMap.empty<string, HashMap.HashMap<string, Dependency>>()
	let sources = HashMap.empty<string, string>()
	let dependencies = HashSet.empty<string>()
	let reachCache = HashMap.empty<string, HashSet.HashSet<string>>()
	let retained = HashSet.empty<string>()
	let instantiatedViews = HashSet.empty<number>()
	const clean = (url: string): string => {
		const value = new URL(url)
		value.searchParams.delete(key)
		return value.href
	}
	const version = (url: string | undefined): number | undefined => {
		if (url === undefined) return undefined
		const value = new URL(url).searchParams.get(key)
		return value === null ? undefined : Number(value)
	}
	const tag = (url: string, id: number) => {
		const value = new URL(url)
		value.searchParams.set(key, String.String(id))
		return value.href
	}
	const route = (url: string, id: number): string =>
		Option.getOrElse(
			HashMap.get(
				Option.getOrElse(HashMap.get(views, id), HashMap.empty<string, string>),
				url,
			),
			() => tag(url, id),
		)

	const root = (attempt: Attempt) => route(attempt.url, attempt.generation.id)
	const children = (node: string) =>
		Option.getOrElse(
			HashMap.get(edges, node),
			HashMap.empty<string, Dependency>,
		)
	const reachable = (node: string) => {
		const cached = HashMap.get(reachCache, node)
		if (Option.isSome(cached)) return cached.value
		let seen = HashSet.empty<string>()
		let pending: Chunk.Chunk<string> = Chunk.of(node)
		while (Chunk.isNonEmpty(pending)) {
			const current = Chunk.headNonEmpty(pending)
			pending = Chunk.drop(pending, 1)
			if (HashSet.has(seen, current)) continue
			seen = HashSet.add(seen, current)
			for (const edge of HashMap.values(children(current)))
				pending = Chunk.prepend(pending, edge.node)
		}
		reachCache = HashMap.set(reachCache, node, seen)
		return seen
	}
	const usedBy = (attempts: ReadonlyArray<Attempt>) => {
		const roots = HashSet.fromIterable(Array.map(attempts, root))
		let used = HashSet.empty<string>()
		for (const node of roots) used = HashSet.union(used, reachable(node))
		return used
	}
	const link = (parent: string, node: string, request?: string) => {
		if (
			importing === undefined &&
			!HashSet.has(retained, parent) &&
			!HashSet.has(instantiatedViews, version(parent)!)
		)
			return
		retained = HashSet.add(retained, node)
		const url = clean(node)
		const edge = {
			node,
			url,
			generation: { id: version(node)! },
			...(request === undefined ? {} : { request }),
		}
		const previous = HashMap.get(children(parent), request ?? url)
		if (
			Option.exists(
				previous,
				(previous) => previous.node === node && previous.request === request,
			)
		)
			return
		edges = HashMap.set(
			edges,
			parent,
			HashMap.set(children(parent), request ?? url, edge),
		)
		reachCache = HashMap.empty()
	}
	const resolutions = (
		attempts: ReadonlyArray<Attempt>,
	): ReadonlyArray<Attempt> => [
		...Array.filter(attempts, (attempt) => attempt.request !== undefined),
		...Array.flatMap(Array.fromIterable(usedBy(attempts)), (node) =>
			Array.filter(
				HashMap.toValues(children(node)),
				(edge) => edge.request !== undefined,
			),
		),
	]
	const unsupported = (url: string, format: string | null | undefined) =>
		format === "commonjs" ||
		format === "commonjs-typescript" ||
		format === "addon" ||
		String.endsWith(".node")(new URL(url).pathname)
	const requireRestart = (node: string) => {
		if (importing !== undefined || HashSet.has(retained, node))
			dependencies = HashSet.add(dependencies, node)
		if (importing?.reload === true && importing.generation.id === version(node))
			throw RestartRequired.make({ url: clean(node) })
	}
	const record = (node: string, format: string | null | undefined) => {
		if (unsupported(clean(node), format)) requireRestart(node)
	}
	// One reverse traversal closes cycles and all importers of every dirty instance.
	const invalidated = (
		attempts: ReadonlyArray<Attempt>,
		dirty: HashSet.HashSet<string>,
	) => {
		const used = usedBy(attempts)
		let parents = HashMap.empty<string, HashSet.HashSet<string>>()
		let pending = Chunk.empty<string>()
		for (const node of used) {
			if (HashSet.has(dirty, clean(node)))
				pending = Chunk.prepend(pending, node)
			for (const edge of HashMap.values(children(node))) {
				parents = HashMap.set(
					parents,
					edge.node,
					HashSet.add(
						Option.getOrElse(
							HashMap.get(parents, edge.node),
							HashSet.empty<string>,
						),
						node,
					),
				)
				if (edge.request !== undefined && HashSet.has(dirty, edge.request))
					pending = Chunk.prepend(pending, edge.node)
			}
		}
		for (const attempt of attempts)
			if (attempt.request !== undefined && HashSet.has(dirty, attempt.request))
				pending = Chunk.prepend(pending, root(attempt))
		let invalid = HashSet.empty<string>()
		while (Chunk.isNonEmpty(pending)) {
			const node = Chunk.headNonEmpty(pending)
			pending = Chunk.drop(pending, 1)
			if (HashSet.has(invalid, node)) continue
			invalid = HashSet.add(invalid, node)
			for (const parent of Option.getOrElse(
				HashMap.get(parents, node),
				HashSet.empty<string>,
			))
				pending = Chunk.prepend(pending, parent)
		}
		return invalid
	}
	const prepare = (
		attempts: ReadonlyArray<Attempt> = [],
		invalid = HashSet.empty<string>(),
	): Generation => {
		const id = ++revision
		const seed = Array.reduce(attempts, 0, (id, attempt) =>
			Math.max(id, attempt.generation.id),
		)
		let view = Option.getOrElse(
			HashMap.get(views, seed),
			HashMap.empty<string, string>,
		)
		const used = usedBy(attempts)
		// Retain HAMT structure between views. Default routes need no stored entry;
		// only modules reused from older views need an explicit override.
		for (const [url, node] of view)
			if (!HashSet.has(used, node) || HashSet.has(invalid, node))
				view = HashMap.remove(view, url)
		for (const node of used) {
			if (HashSet.has(invalid, node)) continue
			const url = clean(node)
			const previous = HashMap.get(view, url)
			if (Option.isNone(previous) || version(previous.value)! < version(node)!)
				view = HashMap.set(view, url, node)
		}

		views = HashMap.set(views, id, view)
		return { id }
	}
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (String.startsWith(rawPrefix)(specifier))
				return nextResolve(String.slice(rawPrefix.length)(specifier), {
					...context,
					parentURL: base,
				})
			const parentNode = context.parentURL
			const request = decodeRequest(specifier)
			const entry = Option.isSome(request)
			const id = Option.match(request, {
				onNone: () => version(context.parentURL),
				onSome: ([, id]) => Number(id),
			})
			if (id === undefined) return nextResolve(specifier, context)
			const target = Option.match(request, {
				onNone: () => specifier,
				onSome: ([, , , target]) => target,
			})
			const parent = entry ? base : clean(context.parentURL!)
			const lexical = Option.getOrUndefined(fileRequest(target, parent))
			const result = (() => {
				try {
					return nextResolve(target, { ...context, parentURL: parent })
				} catch (cause) {
					if (
						Predicate.hasProperty(cause, "url") &&
						typeof cause.url === "string" &&
						String.startsWith("file:")(cause.url)
					) {
						if (entry) resolved = cause.url
						else if (include(cause.url))
							link(parentNode!, route(cause.url, id), lexical)
					}
					throw cause
				}
			})()
			if (entry) resolved = result.url
			if (!entry && result.url === "node:module") {
				const node = route(result.url, id)
				link(parentNode!, node)
				requireRestart(node)
			}
			if (
				!String.startsWith("file:")(result.url) ||
				(!entry && !include(result.url))
			)
				return result
			const node = route(result.url, id)
			if (!entry) link(parentNode!, node, lexical)
			const required = Array.contains(context.conditions, "require")
			if (required) requireRestart(node)
			else record(node, result.format)
			return required || unsupported(result.url, result.format)
				? result
				: { ...result, url: node }
		},
		load(url, context, nextLoad) {
			const id = version(url)
			if (id === undefined) return nextLoad(url, context)
			instantiatedViews = HashSet.add(instantiatedViews, id)
			const original = clean(url)
			record(url, context.format)
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
				if (importing !== undefined || HashSet.has(retained, url))
					sources = HashMap.set(sources, url, digest(bytes))
			}
			record(url, result.format)
			return result
		},
	})
	const files = (attempts: ReadonlyArray<Attempt>) => {
		let files = HashMap.empty<string, FileVersion>()
		const put = (url: string, node: string, resolution?: string) => {
			if (!String.startsWith("file:")(url) || HashSet.has(dependencies, node))
				return
			const generation = version(node)!
			const previous = HashMap.get(files, url)
			if (
				Option.exists(
					previous,
					(previous) =>
						previous.generation > generation ||
						(previous.generation === generation &&
							previous.resolution !== undefined),
				)
			)
				return
			files = HashMap.set(files, url, {
				generation,
				content: Option.getOrUndefined(HashMap.get(sources, node)),
				...(resolution === undefined ? {} : { resolution }),
			})
		}
		for (const node of usedBy(attempts)) put(clean(node), node)
		for (const attempt of resolutions(attempts))
			if (attempt.request !== undefined)
				put(
					attempt.request,
					root(attempt),
					pathToFileURL(fileURLToPath(attempt.url)).href,
				)
		return files
	}
	return {
		prepare,
		files,
		resolutions,
		invalidated,
		affected: (attempt: Attempt, invalid: HashSet.HashSet<string>) =>
			HashSet.has(invalid, root(attempt)),
		fileRequest: (specifier: string) => fileRequest(specifier, base),
		unsupported: (generation: Generation, roots?: ReadonlyArray<string>) => {
			const used =
				roots === undefined
					? undefined
					: usedBy(Array.map(roots, (url) => ({ url, generation })))
			return HashSet.fromIterable(
				Array.map(
					Array.filter(Array.fromIterable(dependencies), (node) =>
						used === undefined
							? version(node) === generation.id
							: HashSet.has(used, node),
					),
					clean,
				),
			)
		},
		collect: (attempts: ReadonlyArray<Attempt>) => {
			const used = usedBy(attempts)
			const ownedViews = HashSet.fromIterable(
				Array.map(attempts, (attempt) => attempt.generation.id),
			)
			views = HashMap.filter(
				views,
				(_, id) =>
					id === revision ||
					HashSet.has(instantiatedViews, id) ||
					HashSet.has(ownedViews, id),
			)
			// Old code can reach any default route in its instantiated view, even
			// after every lease on that target closed. Preserve its complete graph,
			// source baseline and native capabilities until the session closes.
			const keep = (node: string) =>
				HashSet.has(used, node) ||
				HashSet.has(instantiatedViews, version(node)!)
			retained = used
			sources = HashMap.filter(sources, (_, node) => keep(node))
			edges = HashMap.filter(edges, (_, node) => keep(node))
			dependencies = HashSet.filter(dependencies, keep)
			reachCache = HashMap.filter(reachCache, (_, node) =>
				HashSet.has(used, node),
			)
		},
		// Internal counters support deterministic retention tests and external benchmarks.
		counts: () => ({
			sources: HashMap.size(sources),
			edges: HashMap.size(edges),
			dependencies: HashSet.size(dependencies),
			views: HashMap.size(views),
		}),
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
		close: () => {
			hooks.deregister()
			views = HashMap.empty()
			sources = HashMap.empty()
			edges = HashMap.empty()
			dependencies = HashSet.empty()
			reachCache = HashMap.empty()
			retained = HashSet.empty()
			instantiatedViews = HashSet.empty()
		},
	}
}
