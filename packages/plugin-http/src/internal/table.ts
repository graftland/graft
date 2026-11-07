import { Array, Effect, HashSet, Option, Result, Schema, String } from "effect"
import { FindMyWay, HttpMethod } from "effect/http"

import {
	InvalidMount,
	RouteConflict,
	type Mount,
	type Route,
	type RouteState,
} from "../Http"

/** A completed index is never mutated after publication. */
export interface Table extends RouteState {
	readonly index: Pick<FindMyWay.Router<Mount>, "find">
}
const insert = <A>(
	router: FindMyWay.Router<A>,
	route: Route,
	value: A,
): void => {
	const add = (path: FindMyWay.PathInput) =>
		route.method === "*"
			? router.all(path, value)
			: router.on(route.method, path, value)
	add(route.path)
	// FindMyWay's PathInput does not describe the empty root alias HttpRouter uses.
	if (String.endsWith("/*")(route.path))
		add(String.slice(0, -2)(route.path) as FindMyWay.PathInput)
}

class TableError extends Schema.TaggedError<
	TableError,
	{ readonly brand: unique symbol }
>()("TableError", {
	cause: Schema.Defect(),
}) {}
const key = (route: Route) => `${route.method} ${route.path}`
const indexOf = (mounts: ReadonlyArray<Mount>) =>
	Result.try({
		try: () => {
			const index = FindMyWay.make<Mount>()
			for (const mount of mounts)
				for (const route of mount.routes) insert(index, route, mount)
			return index
		},
		catch: (cause) => TableError.make({ cause }),
	})
/** Probe isolated indexes because a failed insertion can partially mutate a router. */
export const build = Effect.fnUntraced(function* (
	mounts: ReadonlyArray<Mount>,
) {
	let excluded = HashSet.empty<number>()
	let conflicts: ReadonlyArray<RouteConflict | InvalidMount> = []
	for (const [i, left] of Array.map(
		mounts,
		(mount, i) => [i, mount] as const,
	)) {
		const single = indexOf([left])
		if (Result.isFailure(single)) {
			excluded = HashSet.add(excluded, i)
			conflicts = Array.append(
				conflicts,
				InvalidMount.make({
					routes: Array.map(left.routes, key),
					cause: single.failure.cause,
				}),
			)
		}
	}
	const invalid = excluded
	for (const [i, left] of Array.map(
		mounts,
		(mount, i) => [i, mount] as const,
	)) {
		if (HashSet.has(invalid, i)) continue
		for (const [j, right] of Array.map(
			mounts,
			(mount, j) => [j, mount] as const,
		)) {
			if (j <= i || HashSet.has(invalid, j)) continue
			const pair = indexOf([left, right])
			if (Result.isFailure(pair)) {
				excluded = HashSet.add(HashSet.add(excluded, i), j)
				conflicts = Array.append(
					conflicts,
					RouteConflict.make({
						routes: Array.dedupe(
							Array.map([...left.routes, ...right.routes], key),
						),
						cause: pair.failure.cause,
					}),
				)
			}
		}
	}
	const served = Array.filter(mounts, (_, i) => !HashSet.has(excluded, i))
	const index = yield* Effect.fromResult(indexOf(served))
	return { index, served, conflicts } satisfies Table
})
export const empty = (): Table => ({
	index: FindMyWay.make(),
	served: [],
	conflicts: [],
})
/** Delegate method misses only when the path has a single unambiguous owner. */
export const lookup = (
	table: Table,
	method: string,
	url: string,
): Option.Option<Mount> => {
	const direct =
		table.index.find(method, url) ??
		(method === "HEAD" ? table.index.find("GET", url) : undefined)
	if (direct !== undefined) return Option.some(direct.handler)
	let owner: Mount | undefined
	for (const candidate of HttpMethod.all) {
		const found = table.index.find(candidate, url)
		if (found === undefined) continue
		if (owner !== undefined && owner !== found.handler) return Option.none()
		owner = found.handler
	}
	return Option.fromUndefinedOr(owner)
}
