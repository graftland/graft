/**
 * A scripted chat session. Plugins are loaded, reconfigured and unloaded
 * between messages, the way an operator would while the bot keeps running.
 *
 * Run it with `pnpm start` after building the workspace.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { type Fork, Graft } from "@graftland/graft"
import { Array, Effect, Layer, Logger, Option, Stream } from "effect"
import { receive } from "./Chat.ts"
import dice from "./plugins/dice.ts"
import * as Remote from "@graftland/plugin-remote"
import { SecureRandom } from "effect/crypto"
import { contract } from "./forecastContract.ts"
import help from "./plugins/help.ts"
import moderation from "./plugins/moderation.ts"
import weather from "./plugins/weather.ts"

const say = Effect.fn("say")(function* (user: string, text: string) {
	yield* Effect.log(`${user}: ${text}`)
	const reply = yield* receive({ user, text })
	if (Option.isSome(reply)) yield* Effect.log(`bot: ${reply.value}`)
})

const step = (title: string) => Effect.log(`--- ${title} ---`)

const state = (fork: Fork.Fork) =>
	Effect.map(Stream.runHead(fork.state), (state) =>
		Option.match(state, {
			onNone: () => "Disposed",
			onSome: (state) =>
				state._tag === "Pending"
					? `Pending, waiting for ${Array.join(state.missing, ", ")}`
					: state._tag,
		}),
	)

const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	Effect.asVoid(
		Stream.runHead(Stream.filter(fork.state, (state) => state._tag === tag)),
	)

const program = Effect.gen(function* () {
	yield* step("1. Start the bot with two command plugins")
	const helpFork = yield* Graft.plugin(help)
	const diceFork = yield* Graft.plugin(dice)
	yield* helpFork.await
	yield* diceFork.await
	yield* say("alice", "/help")
	yield* say("alice", "/roll 2d6")

	yield* step("2. Load /weather before anything provides forecasts")
	const weatherFork = yield* Graft.plugin(weather)
	yield* weatherFork.await
	yield* Effect.log(`weather is ${yield* state(weatherFork)}`)
	yield* say("bob", "/weather Paris")

	yield* step("3. Load the forecasts provider; /weather starts on its own")
	const forecastsFork = yield* Graft.plugin(
		Remote.plugin(contract, {
			contractModule: new URL("../dist/forecastContract.js", import.meta.url)
				.href,
			connect: { local: {} },
			config: { units: "celsius" },
		}),
	)
	yield* reach(weatherFork, "Active")
	yield* Effect.log(`weather is ${yield* state(weatherFork)}`)
	yield* say("bob", "/weather Paris")
	yield* say("bob", "/help")

	yield* step("4. A typo in one plugin's config fails only that plugin")
	// Config usually comes from graft.yml; the cast stands in for a hand-edited typo.
	const broken = yield* Graft.plugin(moderation, {
		banned: "spoiler",
	} as never)
	yield* Effect.exit(broken.await)
	yield* Effect.log(`moderation is ${yield* state(broken)}`)
	yield* say("carol", "/roll 1d20")
	yield* broken.dispose

	yield* step("5. Add moderation, then change its word list without a restart")
	const moderationFork = yield* Graft.plugin(moderation, {
		banned: ["spoiler"],
	})
	yield* moderationFork.await
	yield* say("carol", "Spoiler: the butler did it")
	yield* moderationFork.update({ banned: ["spoiler", "leak"] })
	yield* say("carol", "Here is a leak from the studio")
	yield* say("carol", "/roll 1d20")

	yield* step("6. Unload dice; /roll and its help line disappear with it")
	yield* diceFork.dispose
	yield* say("alice", "/roll 2d6")
	yield* say("alice", "/help")

	yield* step("7. Unload forecasts; /weather stops first and waits again")
	yield* forecastsFork.dispose
	yield* Effect.log(`weather is ${yield* state(weatherFork)}`)
	yield* say("bob", "/weather Tokyo")

	yield* step("8. Shut down: every plugin stops in reverse order")
})

program.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.provideMerge(
			Graft.layer,
			Layer.mergeAll(
				NodeServices.layer,
				SecureRandom.layerWebCrypto,
				Logger.layer([Logger.consolePretty()]),
			),
		),
	),
	NodeRuntime.runMain,
)
