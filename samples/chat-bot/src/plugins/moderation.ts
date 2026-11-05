import { Array, Effect, Ref, Schema, String } from "effect"

import { Event, Plugin } from "@graftland/graft"

import { Inbound } from "../Chat.ts"

/**
 * Removes messages that contain a banned word before any command sees them.
 * A new word list is applied in place: the filter keeps running.
 */
export default Plugin.make({
	name: "moderation",
	config: Schema.Struct({ banned: Schema.Array(Schema.String) }),
	apply: Effect.fn("moderation.apply")(function* (config) {
		const banned = yield* Ref.make(config.banned)
		yield* Effect.acquireRelease(Effect.log("Moderation started"), () =>
			Effect.log("Moderation stopped"),
		)
		yield* Event.on(Inbound, (message, next) =>
			Effect.flatMap(Ref.get(banned), (words) => {
				const text = String.toLowerCase(message.text)
				return Array.some(words, (word) =>
					String.includes(String.toLowerCase(word))(text),
				)
					? Effect.succeedSome(`A message from ${message.user} was removed.`)
					: next(message)
			}),
		)
		return (next) =>
			Effect.as(
				Effect.andThen(
					Ref.set(banned, next.banned),
					Effect.log(`Moderation now blocks ${next.banned.length} words`),
				),
				true,
			)
	}),
})
