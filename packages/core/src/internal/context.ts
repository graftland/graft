import { Array, Context, HashSet } from "effect"
import type { Activation } from "./runtime"

/** Strip provision-sourced values before child intercepts read or transform the fallback. */
export const inheritContext = (
	parent: Activation,
	inherited: Context.Context<never>,
) =>
	Context.makeUnsafe<never>(
		new Map([
			...Array.filter(parent.fallback.mapUnsafe, ([key]) =>
				HashSet.has(parent.provisionKeys, key),
			),
			...Array.filter(
				inherited.mapUnsafe,
				([key]) => !HashSet.has(parent.provisionKeys, key),
			),
		]),
	)
