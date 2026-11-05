import { Array, Effect, Option, Stream } from "effect"

import { Graft, type Fork } from "@graftland/graft"

/** A Pending fork is settled too, so fork.await alone cannot establish readiness. */
export const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	fork.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.die(`Fork ${fork.id} ended before reaching ${tag}`),
				onSome: Effect.succeed,
			}),
		),
	)

export const hasMessage = (entry: Graft.LogEntry, message: string): boolean =>
	Array.isArray(entry.message) && Array.contains(entry.message, message)

export const waitForLog = (message: string, occurrence = 1) =>
	Graft.logs.pipe(
		Stream.filter((entry) => hasMessage(entry, message)),
		Stream.drop(occurrence - 1),
		Stream.runHead,
		Effect.asVoid,
	)

export const snapshot = Graft.forks.pipe(
	Stream.runHead,
	Effect.map(Option.getOrThrow),
)

export const printSnapshot = Effect.fn("printSnapshot")(function* (
	label: string,
) {
	const trees = yield* snapshot
	const lines = (
		nodes: ReadonlyArray<Fork.ForkTree>,
		indent: string,
	): ReadonlyArray<string> =>
		Array.flatMap(nodes, (node) => [
			`${indent}${node.name} #${node.id}: ${node.state._tag}${node.state._tag === "Pending" ? ` (waiting for ${Array.join(node.state.missing, ", ")})` : ""}`,
			...lines(node.children, `${indent}  `),
		])
	yield* Effect.log(`${label}\n${Array.join(lines(trees, "  "), "\n")}`)
})
