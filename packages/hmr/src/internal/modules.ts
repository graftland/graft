// Node's synchronous module hooks have no Effect equivalent.
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"
import { HashSet, Option, Predicate, Schema, String as Str } from "effect"

export class RestartRequired extends Schema.TaggedError<
	RestartRequired,
	{ readonly brand: unique symbol }
>()("RestartRequired", { url: Schema.String }) {}

// Only a missing entry is disposable; missing dependencies still fail the reload.
export const isMissingEntry = (url: string, cause: unknown): boolean =>
	Str.startsWith("file:")(url) &&
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
	readonly id: string
	unsupported: HashSet.HashSet<string>
}

/** A scoped Node hook. Mutable bindings bridge synchronous hooks to Effect. */
export const modules = (base: string, include: (url: string) => boolean) => {
	const key = `graft-hmr-${++sessions}`
	const prefix = `${key}:`
	let revision = 0
	let recording: Generation | undefined
	let reloading = false
	let resolved: string | undefined

	const prepare = (): Generation => ({
		id: String(++revision),
		unsupported: HashSet.empty(),
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
		Str.endsWith(".node")(new URL(url).pathname)
	const record = (
		url: string,
		id: string,
		format: string | null | undefined,
	) => {
		if (recording?.id !== id) return
		if (unsupported(url, format)) {
			recording.unsupported = HashSet.add(recording.unsupported, url)
			if (reloading) throw RestartRequired.make({ url })
		}
	}

	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const entry = Str.startsWith(prefix)(specifier)
			const separator = !entry
				? 0
				: prefix.length +
					Option.getOrThrow(
						Str.indexOf(":")(Str.slice(prefix.length)(specifier)),
					)
			const id = entry
				? Str.slice(prefix.length, separator)(specifier)
				: version(context.parentURL)
			if (id === undefined || id === null)
				return nextResolve(specifier, context)
			const result = nextResolve(
				entry ? Str.slice(separator + 1)(specifier) : specifier,
				{
					...context,
					parentURL: entry ? base : clean(context.parentURL!),
				},
			)
			if (entry) resolved = result.url
			if (
				!Str.startsWith("file:")(result.url) ||
				(!entry && !include(result.url))
			)
				return result
			record(result.url, id, result.format)
			if (unsupported(result.url, result.format)) return result
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
			record(original, id, result.format)
			return result
		},
	})
	return {
		prepare,
		start: (generation: Generation, reload = false) => {
			recording = generation
			reloading = reload
		},
		discard: () => {
			recording = undefined
		},
		request: (specifier: string) => `${prefix}${recording!.id}:${specifier}`,
		resolved: () => resolved,
		close: () => hooks.deregister(),
	}
}
