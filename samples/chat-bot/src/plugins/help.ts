import { Event, Plugin } from "@graftland/graft"
import { Array, Effect, Order } from "effect"
import { command, Describe } from "../Chat.ts"

/** `/help` asks the commands that are loaded right now, so it is never out of date. */
export default Plugin.make({
	name: "help",
	apply: () =>
		command("help", "list the available commands", () =>
			Effect.map(Event.parallel(Describe), (lines) =>
				Array.join(Array.sort(lines, Order.String), "\n"),
			),
		),
})
