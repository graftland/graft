import { Plugin } from "@graftland/graft"
import { Array, Effect, Number, Option, Random } from "effect"
import { command } from "../Chat.ts"

const notation = /^(\d{1,2})d(\d{1,3})$/

/** `/roll 2d6` rolls two six-sided dice. */
export default Plugin.make({
	name: "dice",
	apply: () =>
		command("roll", "roll dice, such as /roll 2d6", ({ user, args }) => {
			const match = Option.fromNullishOr(notation.exec(args[0] ?? "1d6"))
			const count = Option.flatMap(match, (m) => Number.parse(m[1] ?? ""))
			const sides = Option.flatMap(match, (m) => Number.parse(m[2] ?? ""))
			if (
				Option.isNone(count) ||
				Option.isNone(sides) ||
				count.value < 1 ||
				sides.value < 2
			)
				return Effect.succeed("Use dice notation, such as /roll 2d6.")
			return Effect.map(
				Effect.replicateEffect(
					Random.nextIntBetween(1, sides.value),
					count.value,
				),
				(rolls) =>
					`${user} rolled ${Array.join(
						Array.map(rolls, (roll) => `${roll}`),
						" + ",
					)} = ${Number.sumAll(rolls)}`,
			)
		}),
})
