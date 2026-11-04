import type { Plugin } from "@graftland/graft"
import { assert } from "@effect/vitest"
import { Array, Deferred, Effect, Fiber, Stream, String } from "effect"
import type { Channel } from "../src/Transport"
import * as Framing from "../src/internal/runner/Framing"

export interface Capabilities {
	readonly connector: Plugin.Plugin
	readonly listener: Plugin.Plugin
	readonly credentials: Plugin.Plugin
	readonly authenticator: Plugin.Plugin
}
/** The fixture supplies addresses/credentials and an echo session; no full runner is required. */
export const transport = <E, R>(
	plugins: Capabilities,
	fixture: (plugins: Capabilities) => Effect.Effect<Channel, E, R>,
) => {
	const connect = fixture(plugins)
	return {
		chunks: Effect.gen(function* () {
			const channel = yield* connect
			const first = yield* Framing.encode({
				channel: 0,
				payload: new Uint8Array([1, 2, 3]),
			})
			const second = yield* Framing.encode({
				channel: 1,
				payload: new Uint8Array([4, 5]),
			})
			const combined = new Uint8Array(first.length + second.length)
			combined.set(first)
			combined.set(second, first.length)
			// Split the header, then put the remainder and the next frame in one chunk.
			const done = yield* Deferred.make<void>()
			const sending = yield* Stream.make(
				combined.subarray(0, 2),
				combined.subarray(2),
			).pipe(
				Stream.concat(
					Stream.fromEffect(Deferred.await(done)).pipe(Stream.drain),
				),
				Stream.run(channel.output),
				Effect.forkScoped,
			)
			const frames = Framing.decoder()
			const reply = yield* channel.input.pipe(
				Stream.mapEffect((chunk) => Effect.fromResult(frames.decode(chunk))),
				Stream.flattenIterable,
				Stream.take(2),
				Stream.runCollect,
			)
			assert.deepEqual(
				Array.map(reply, (frame) => Array.fromIterable(frame.payload)),
				[
					[1, 2, 3],
					[4, 5],
				],
			)
			yield* Deferred.succeed(done, undefined)
			yield* Fiber.join(sending)
		}),
		eof: Effect.gen(function* () {
			const channel = yield* connect
			yield* Stream.empty.pipe(Stream.run(channel.output))
			const remaining = yield* Stream.runCollect(channel.input)
			assert.isEmpty(remaining)
		}),
	}
}

/** HTTP implementations reject before accepting a session, preserving the challenge. */
export const rejection = <E, R>(
	response: Effect.Effect<string, E, R>,
	challenge?: string,
) =>
	response.pipe(
		Effect.tap((response) =>
			Effect.sync(() => {
				assert.include(response, "HTTP/1.1 401")
				assert.notInclude(response, "101 Switching Protocols")
				assert.notInclude(String.toLowerCase(response), "sec-websocket-accept:")
				if (challenge !== undefined)
					assert.include(
						String.toLowerCase(response),
						"www-authenticate: " + String.toLowerCase(challenge),
					)
			}),
		),
	)
