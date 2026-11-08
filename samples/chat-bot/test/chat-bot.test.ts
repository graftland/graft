import {
	Array,
	Effect,
	Exit,
	Layer,
	Logger,
	MutableList,
	Option,
	Schema,
	Stream,
	type Scope,
} from "effect"
import { assert, describe, it } from "@effect/vitest"

import { Graft, type Fork } from "@graftland/graft"

import { receive } from "../src/Chat.ts"
import { Forecasts, ForecastUnavailable } from "../src/Forecasts.ts"
import dice from "../src/plugins/dice.ts"
import forecasts from "../src/plugins/forecasts.ts"
import help from "../src/plugins/help.ts"
import moderation from "../src/plugins/moderation.ts"
import weather from "../src/plugins/weather.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

const reply = (text: string) =>
	Effect.map(
		receive({ user: "alice", text }),
		Option.getOrElse(() => ""),
	)

const state = (fork: Fork.Fork) =>
	Effect.map(Stream.runHead(fork.state), (state) =>
		Option.match(state, {
			onNone: () => "Disposed",
			onSome: (state) => state._tag,
		}),
	)

const expectReply = (text: string, expected: string) =>
	Effect.map(reply(text), (actual) => assert.strictEqual(actual, expected))

const expectState = (fork: Fork.Fork, expected: string) =>
	Effect.map(state(fork), (actual) => assert.strictEqual(actual, expected))

const reach = (fork: Fork.Fork, tag: Fork.ForkState["_tag"]) =>
	Effect.asVoid(
		Stream.runHead(Stream.filter(fork.state, (state) => state._tag === tag)),
	)

const text = (entry: Graft.LogEntry) =>
	Array.join(
		Array.map(Array.ensure(entry.message), (part) => `${part}`),
		" ",
	)

/**
 * Every log message written so far, oldest first. `Graft.logs` replays recent
 * history, so the stream ends at a marker logged just before reading it.
 */
const messages = Effect.gen(function* () {
	yield* Effect.log("end of log")
	const entries = yield* Stream.runCollect(
		Stream.takeUntil(Graft.logs, (entry) => text(entry) === "end of log"),
	)
	return Array.map(entries, text)
})

const unknownWeather = "Unknown command /weather. Try /help."
const removed = "A message from alice was removed."

describe("chat-bot", () => {
	it.effect("lists and answers only the commands that are loaded", () =>
		Effect.gen(function* () {
			const helpFork = yield* Graft.plugin(help)
			const diceFork = yield* Graft.plugin(dice)
			yield* helpFork.await
			yield* diceFork.await
			const before = yield* reply("/help")
			assert.include(before, "/roll")
			const roll = yield* reply("/roll 2d6")
			assert.match(roll, /^alice rolled \d \+ \d = \d+$/)

			yield* diceFork.dispose
			const after = yield* reply("/help")
			assert.notInclude(after, "/roll")
			const unknown = yield* reply("/roll 2d6")
			assert.strictEqual(unknown, "Unknown command /roll. Try /help.")
		}).pipe(run),
	)

	it.effect(
		"starts /weather once forecasts exist and stops it before they go",
		() =>
			Effect.gen(function* () {
				const weatherFork = yield* Graft.plugin(weather)
				yield* weatherFork.await
				yield* expectState(weatherFork, "Pending")
				yield* expectReply("/weather Paris", unknownWeather)

				const forecastsFork = yield* Graft.plugin(forecasts, {
					units: "fahrenheit",
				})
				yield* reach(weatherFork, "Active")
				const paris = yield* reply("/weather Paris")
				assert.strictEqual(paris, "Paris: light rain, 57 °F")

				yield* forecastsFork.dispose
				yield* expectState(weatherFork, "Pending")
				const log = yield* messages
				const gone = Array.findLastIndex(log, (m) => m === "/weather is gone")
				const disconnected = Array.findLastIndex(
					log,
					(m) => m === "Disconnected from the weather service",
				)
				assert.isTrue(Option.isSome(gone))
				assert.isTrue(Option.isSome(disconnected))
				assert.isBelow(
					Option.getOrElse(gone, () => Infinity),
					Option.getOrElse(disconnected, () => -Infinity),
				)
			}).pipe(run),
	)

	it.effect("updates the moderation word list without restarting it", () =>
		Effect.gen(function* () {
			const diceFork = yield* Graft.plugin(dice)
			const fork = yield* Graft.plugin(moderation, { banned: ["spoiler"] })
			yield* diceFork.await
			yield* fork.await
			yield* expectReply("SPOILER: the butler did it", removed)
			yield* expectReply("A leak from the studio", "")

			yield* fork.update({ banned: ["spoiler", "leak"] })
			yield* expectReply("A leak from the studio", removed)
			const roll = yield* reply("/roll 1d4")
			assert.match(roll, /^alice rolled \d = \d$/)
			const log = yield* messages
			const starts = Array.filter(log, (m) => m === "Moderation started")
			assert.lengthOf(starts, 1)
			assert.notInclude(log, "Moderation stopped")
		}).pipe(run),
	)

	it.effect("fails only the plugin whose config is invalid", () =>
		Effect.gen(function* () {
			const diceFork = yield* Graft.plugin(dice)
			yield* diceFork.await
			const broken = yield* Graft.plugin(moderation, {
				banned: "spoiler",
			} as never)
			const exit = yield* Effect.exit(broken.await)
			assert.isTrue(Exit.isFailure(exit))
			yield* expectState(broken, "Failed")
			const roll = yield* reply("/roll 1d4")
			assert.match(roll, /^alice rolled \d = \d$/)
		}).pipe(run),
	)
})

it.effect(
	"matches uppercase banned words both initially and after an update",
	() =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(moderation, { banned: ["SPOILER"] })
			yield* fork.await
			yield* expectReply("SPOILER", removed)
			yield* fork.update({ banned: ["LEAK"] })
			yield* expectReply("LEAK", removed)
		}).pipe(run),
)

it.effect(
	"logs the forecast diagnostic while keeping the weather fallback response",
	() =>
		Effect.gen(function* () {
			const marker = new Error("forecast diagnostic")
			const logs = MutableList.make<Logger.Options<unknown>>()
			yield* Effect.gen(function* () {
				yield* Graft.provide(Forecasts, {
					today: () => Effect.fail(ForecastUnavailable.make({ cause: marker })),
				})
				const fork = yield* Graft.plugin(weather)
				yield* fork.await
				yield* expectReply(
					"/weather Paris",
					"Weather is temporarily unavailable.",
				)
			}).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make((log) => {
							MutableList.append(logs, log)
						}),
					]),
				),
			)
			assert.isTrue(
				Array.some(MutableList.toArray(logs), (log) =>
					Array.some(
						log.cause.reasons,
						(reason) =>
							reason._tag === "Fail" &&
							Schema.is(ForecastUnavailable)(reason.error) &&
							reason.error.cause === marker,
					),
				),
			)
		}).pipe(run),
)
