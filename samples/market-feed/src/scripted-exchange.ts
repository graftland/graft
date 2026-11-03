import { Cause, Effect, Option, Queue, Ref } from "effect"
import {
	ExchangeTransport,
	ExchangeUnavailable,
	type Quote,
} from "./services.ts"

type Frame =
	| { readonly _tag: "Quote"; readonly quote: Quote }
	| {
			readonly _tag: "Disconnect"
			readonly cause: Cause.Cause<ExchangeUnavailable>
	  }

/** A controlled transport: connection 2 is refused; other connections stay open until told to fail. */
export const makeScriptedExchange = Effect.gen(function* () {
	const attempts = yield* Ref.make(0)
	const socket = yield* Ref.make(Option.none<Queue.Queue<Frame>>())
	const transport = ExchangeTransport.of({
		connect: Effect.gen(function* () {
			const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1)
			yield* Effect.log(`exchange: connecting (attempt ${attempt})`)
			if (attempt === 2) {
				return yield* ExchangeUnavailable.make({
					operation: "connect",
					detail: "Venue maintenance: connection refused",
				})
			}
			const frames = yield* Effect.acquireRelease(
				Queue.bounded<Frame>(16),
				(frames) =>
					Queue.shutdown(frames).pipe(
						Effect.andThen(Ref.set(socket, Option.none())),
						Effect.andThen(
							Effect.log(`exchange: stopped (connection ${attempt})`),
						),
					),
			)
			yield* Ref.set(socket, Option.some(frames))
			return {
				read: Queue.take(frames).pipe(
					Effect.flatMap((frame) =>
						frame._tag === "Quote"
							? Effect.succeed(frame.quote)
							: Effect.failCause(frame.cause),
					),
				),
			}
		}),
	})
	const send = Effect.fn("ScriptedExchange.send")(function* (frame: Frame) {
		const connected = yield* Ref.get(socket)
		if (Option.isNone(connected))
			return yield* Effect.die("The scripted exchange has no open connection")
		yield* Queue.offer(connected.value, frame)
	})
	return {
		transport,
		attempts: Ref.get(attempts),
		quote: (quote: Quote) => send({ _tag: "Quote", quote }),
		disconnect: (cause: Cause.Cause<ExchangeUnavailable>) =>
			send({ _tag: "Disconnect", cause }),
	}
})
