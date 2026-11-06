import { Array, Cause, Context, HashSet, Result } from "effect"
import { HttpApi, OpenApi, type HttpApiGroup } from "effect/http-api"

import { CompositionError, GroupConflict, type Snapshot } from "../HttpApis"

export interface Composition extends Snapshot {
	readonly conflicts: ReadonlyArray<GroupConflict>
	readonly broken: ReadonlyArray<{
		readonly group: string
		readonly cause: Cause.Cause<never>
	}>
}
const apiOf = (
	groups: ReadonlyArray<HttpApiGroup.Top>,
	info: Context.Context<never>,
): HttpApi.Top =>
	// HttpApi.add accepts an empty rest list at runtime; only its public tuple type requires one item.
	HttpApi.make("graft")
		.add(...(groups as Array.NonEmptyReadonlyArray<HttpApiGroup.Top>))
		.annotateMerge(info)

const generate = (api: HttpApi.Top) =>
	Result.try({
		try: () => OpenApi.fromApi(api),
		catch: (cause) => CompositionError.make({ cause }),
	})
/** Compose deterministically, excluding duplicate identifiers, broken groups and incompatible pairs. */
export const compose = (
	groups: ReadonlyArray<HttpApiGroup.Constraint>,
	info: Context.Context<never> = Context.empty(),
): Result.Result<Composition, CompositionError> => {
	const sorted = Array.sort(
		groups as ReadonlyArray<HttpApiGroup.Top>,
		(a: HttpApiGroup.Top, b: HttpApiGroup.Top) =>
			a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0,
	)
	let excluded = HashSet.empty<string>()
	let conflicts: ReadonlyArray<GroupConflict> = []
	let broken: Composition["broken"] = []
	for (const group of sorted) {
		if (
			!HashSet.has(excluded, group.identifier) &&
			Array.filter(sorted, (other) => other.identifier === group.identifier)
				.length > 1
		) {
			excluded = HashSet.add(excluded, group.identifier)
			conflicts = Array.append(
				conflicts,
				GroupConflict.make({
					groups: [group.identifier],
					reason: "same identifier",
				}),
			)
		}
	}
	let survivors = Array.filter(
		sorted,
		(group) => !HashSet.has(excluded, group.identifier),
	)
	if (Result.isFailure(generate(apiOf(survivors, info)))) {
		for (const group of survivors) {
			const single = generate(apiOf([group], info))
			if (Result.isFailure(single)) {
				excluded = HashSet.add(excluded, group.identifier)
				broken = Array.append(broken, {
					group: group.identifier,
					cause: Cause.die(single.failure.cause),
				})
			}
		}
		survivors = Array.filter(
			survivors,
			(group) => !HashSet.has(excluded, group.identifier),
		)
		for (const [i, left] of Array.map(
			survivors,
			(group, i) => [i, group] as const,
		)) {
			for (const right of Array.drop(survivors, i + 1)) {
				const pair = generate(apiOf([left, right], info))
				if (Result.isFailure(pair)) {
					excluded = HashSet.add(
						HashSet.add(excluded, left.identifier),
						right.identifier,
					)
					conflicts = Array.append(
						conflicts,
						GroupConflict.make({
							groups: [left.identifier, right.identifier],
							cause: pair.failure.cause,
						}),
					)
				}
			}
		}
	}
	const api = apiOf(
		Array.filter(
			survivors,
			(group) => !HashSet.has(excluded, group.identifier),
		),
		info,
	)
	return Result.map(generate(api), (spec) => ({ api, spec, conflicts, broken }))
}
