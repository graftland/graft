import { Graft, Plugin } from "@graftland/graft"
import { Commands } from "@graftland/cli/Commands"
import { Console, Context, Effect, Schema } from "effect"
import { Argument, Command } from "effect/cli"

export default Plugin.make({
	name: "hello-commands",
	config: Schema.Struct({ greeting: Schema.String }),
	inject: [Commands],
	apply: ({ greeting }) =>
		Effect.flatMap(Commands, (commands) =>
			commands.register(
				Command.make(
					"hello",
					{ name: Argument.String("name").pipe(Argument.withDefault("world")) },
					({ name }) => Console.log(`${greeting}, ${name}!`),
				),
			),
		),
})

class Greeting extends Context.Service<Greeting, { readonly text: string }>()(
	"@graftland/cli/test/command-plugin/Greeting",
) {}
export const provider = Plugin.make({
	name: "greeting-provider",
	inject: [Commands],
	apply: Effect.fnUntraced(function* () {
		yield* Effect.sleep("20 millis")
		yield* Graft.provide(Greeting, { text: "Shared greeting" })
		const commands = yield* Commands
		yield* commands.register(Command.make("support", {}, () => Effect.void))
	}),
})
export const consumer = Plugin.make({
	name: "greeting-consumer",
	inject: [Commands, Greeting],
	apply: Effect.fnUntraced(function* () {
		const commands = yield* Commands
		const greeting = yield* Greeting
		yield* commands.register(
			Command.make("greet", {}, () => Console.log(greeting.text)),
		)
	}),
})
