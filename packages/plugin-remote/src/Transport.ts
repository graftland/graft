/** Ordered reliable bytes used inside native units; EOF is not exit evidence. */
import type { Sink, Stream } from "effect"

import type { TransportError } from "./Errors"

export interface Channel {
	readonly input: Stream.Stream<Uint8Array, TransportError>
	readonly output: Sink.Sink<unknown, Uint8Array, unknown, TransportError>
}
