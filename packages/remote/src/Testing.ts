import type { Plugin } from "@graftland/graft"
import {
	Array,
	Equivalence,
	Deferred,
	Effect,
	Fiber,
	Stream,
	String,
	Schema,
} from "effect"
import type { Channel } from "./Transport"
import * as Framing from "./internal/runner/Framing"

export class ConformanceError extends Schema.TaggedError<
	ConformanceError,
	{ readonly brand: unique symbol }
>()("ConformanceError", { message: Schema.String }) {}
const check = (condition: boolean, message: string) =>
	condition ? Effect.void : Effect.fail(ConformanceError.make({ message }))
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
			yield* check(
				Array.makeEquivalence(
					Equivalence.Struct({
						channel: Equivalence.Number,
						payload: Array.makeEquivalence(Equivalence.Number),
					}),
				)(
					Array.map(reply, (frame) => ({
						channel: frame.channel,
						payload: Array.fromIterable(frame.payload),
					})),
					[
						{ channel: 0, payload: [1, 2, 3] },
						{ channel: 1, payload: [4, 5] },
					],
				),
				"The channel changed byte order across split or coalesced chunks",
			)
			yield* Deferred.succeed(done, undefined)
			yield* Fiber.join(sending)
		}),
		eof: Effect.gen(function* () {
			const channel = yield* connect
			yield* Stream.empty.pipe(Stream.run(channel.output))
			const remaining = yield* Stream.runCollect(channel.input)
			yield* check(
				remaining.length === 0,
				"The channel produced bytes after EOF",
			)
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
			Effect.all(
				[
					check(String.includes("HTTP/1.1 401")(response), "Expected HTTP 401"),
					check(
						!String.includes("101 Switching Protocols")(response),
						"Rejected credentials opened a WebSocket",
					),
					check(
						!String.includes("sec-websocket-accept:")(
							String.toLowerCase(response),
						),
						"Rejected credentials received a WebSocket accept header",
					),
					check(
						challenge === undefined ||
							String.includes(
								"www-authenticate: " + String.toLowerCase(challenge),
							)(String.toLowerCase(response)),
						"The authentication challenge was lost",
					),
				],
				{ discard: true },
			),
		),
	)
