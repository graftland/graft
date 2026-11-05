import { Effect, Layer, Logger, Option, Stream } from "effect"
import { NodeRuntime } from "@effect/platform-node"

import { Graft, Plugin } from "@graftland/graft"

import { Authenticator } from "../../src/Auth"
import { accept } from "../../src/internal/assembly"
import { platform } from "../../src/internal/platform"
import authenticator from "../../src/runner/auth/none"
import listener from "../../src/runner/stdio"
import { Listener } from "../../src/Transport"

const echo = Plugin.make({
	name: "stdio-echo",
	inject: [Listener, Authenticator],
	apply: Effect.fnUntraced(function* () {
		const transport = yield* Listener
		const auth = yield* Authenticator
		const bound = yield* transport.bind(Option.none())
		yield* bound.serve(
			accept(
				auth,
				transport.properties,
				() => (channel) =>
					Stream.run(channel.input, channel.output).pipe(Effect.asVoid),
			),
		)
	}),
})
NodeRuntime.runMain(
	Effect.gen(function* () {
		const services = yield* Layer.build(
			Graft.layer.pipe(Layer.provideMerge(platform)),
		)
		return yield* Effect.gen(function* () {
			const transport = yield* Graft.plugin(listener, {})
			const auth = yield* Graft.plugin(authenticator, {})
			yield* transport.await
			yield* auth.await
			const session = yield* Graft.plugin(echo)
			yield* session.await
		}).pipe(Effect.provideContext(services))
	}).pipe(Effect.scoped, Effect.provideService(Logger.LogToStderr, true)),
)
