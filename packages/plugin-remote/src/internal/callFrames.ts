import { Effect, Schema } from "effect"

import type { CallMessage } from "@graftland/graft/Kernel"

import * as Wire from "./unitProtocol"

export const encode = Effect.fnUntraced(function* (
	message: CallMessage,
): Effect.fn.Return<Wire.CallMessage, Schema.SchemaError> {
	if (message._tag === "Lost")
		return {
			...message,
			cause: yield* Schema.encodeEffect(Wire.Cause)(message.cause),
		}
	if (message._tag !== "Complete") return message
	return {
		...message,
		cleanup: message.cleanup._tag,
		cause: yield* Schema.encodeEffect(Wire.Cause)(message.cause),
		...(message.cleanup._tag === "Failed"
			? {
					cleanupCause: yield* Schema.encodeEffect(Wire.Cause)(
						message.cleanup.cause,
					),
				}
			: {}),
	}
})
export const decode = Effect.fnUntraced(function* (
	message: Wire.CallMessage,
): Effect.fn.Return<CallMessage, Schema.SchemaError> {
	if (message._tag === "Lost")
		return {
			...message,
			cause: yield* Schema.decodeEffect(Wire.Cause)(message.cause),
		}
	if (message._tag !== "Complete") return message
	const cause = yield* Schema.decodeEffect(Wire.Cause)(message.cause)
	return {
		...message,
		cause,
		cleanup:
			message.cleanup === "Failed"
				? {
						_tag: "Failed",
						cause:
							message.cleanupCause === undefined
								? cause
								: yield* Schema.decodeEffect(Wire.Cause)(message.cleanupCause),
					}
				: message.cleanup === "Completed"
					? { _tag: "Completed" }
					: { _tag: "Unknown" },
	}
})
