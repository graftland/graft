/**
 * The protocol every chat-bot plugin speaks. Nothing here keeps a registry of
 * commands or filters: plugins register event handlers, and Graft removes
 * those handlers when the plugin that registered them stops.
 */
import { Event, type Graft } from "@graftland/graft"
import type { Scope } from "effect"
import { Array, Effect, Option, String } from "effect"

export interface Message {
	readonly user: string
	readonly text: string
}

export interface Invocation {
	readonly user: string
	readonly name: string
	readonly args: ReadonlyArray<string>
}

/** Asks every command plugin in turn; the plugin that owns the command answers. */
export const Command = Event.make<
	[invocation: Invocation],
	Option.Option<string>
>("@graftland/sample-chat-bot/Command")

/** Collects one line of help from every command that is loaded right now. */
export const Describe = Event.make<[], string>(
	"@graftland/sample-chat-bot/Describe",
)

/** Filters that wrap message handling and may answer a message themselves. */
export const Inbound = Event.middleware<Message, Option.Option<string>>(
	"@graftland/sample-chat-bot/Inbound",
)

/**
 * Registers a command for as long as the calling plugin is loaded: its
 * handler and its line in `/help` come and go together with the plugin.
 */
export const command = Effect.fn("Chat.command")(function* <R>(
	name: string,
	description: string,
	run: (invocation: Invocation) => Effect.Effect<string, never, R>,
): Effect.fn.Return<void, never, Graft.Graft | Scope.Scope | R> {
	yield* Effect.acquireRelease(Effect.log(`/${name} is available`), () =>
		Effect.log(`/${name} is gone`),
	)
	yield* Event.on(Command, (invocation) =>
		invocation.name === name
			? Effect.asSome(run(invocation))
			: Effect.succeedNone,
	)
	yield* Event.on(Describe, () => Effect.succeed(`/${name}: ${description}`))
})

const parse = (message: Message): Option.Option<Invocation> => {
	if (!String.startsWith("/")(message.text)) return Option.none()
	const words = Array.filter(
		String.split(String.trim(String.slice(1)(message.text)), /\s+/),
		String.isNonEmpty,
	)
	return Option.map(Array.head(words), (name) => ({
		user: message.user,
		name,
		args: Array.drop(words, 1),
	}))
}

const dispatch = (message: Message) =>
	Option.match(parse(message), {
		onNone: () => Effect.succeedNone,
		onSome: (invocation) =>
			Effect.map(Event.bail(Command, invocation), (reply) =>
				Option.orElseSome(
					reply,
					() => `Unknown command /${invocation.name}. Try /help.`,
				),
			),
	})

/** Handles one incoming message and returns the bot's reply, if any. */
export const receive: (
	message: Message,
) => Effect.Effect<Option.Option<string>, never, Graft.Graft> = Effect.fn(
	"Chat.receive",
)(function* (message: Message) {
	return yield* Event.waterfall(Inbound, message, dispatch)
})
