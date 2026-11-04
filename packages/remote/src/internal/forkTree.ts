import type { Fork } from "@graftland/graft"
import { Array, Option } from "effect"

export const findSubtree = (
	trees: ReadonlyArray<Fork.ForkTree>,
	id: number,
): Option.Option<Fork.ForkTree> =>
	Array.findFirst(trees, (tree) =>
		tree.id === id ? Option.some(tree) : findSubtree(tree.children, id),
	)

export const isSubtreeActive = (tree: Fork.ForkTree): boolean =>
	tree.state._tag === "Active" && Array.every(tree.children, isSubtreeActive)
