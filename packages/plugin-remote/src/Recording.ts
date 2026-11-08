/** The public recording protocol, available to any plugin running in a native unit. */
import { Context, type Effect, type Stream } from "effect"

import type { RecordDuty, RecoveredRecords } from "@graftland/graft/Kernel"

/**
 * Records the kernel delivers to this unit, and the acknowledgements it sends back.
 * The unit's control channel identifies the incarnation, so a plugin cannot claim another one.
 */
export class Recorder extends Context.Service<
	Recorder,
	{
		/**
		 * Asks the kernel to bind the deployment's recording role to this unit incarnation.
		 * A durable recorder passes what its journal holds from earlier kernel runs.
		 */
		readonly register: (
			recorder: string,
			recovered?: RecoveredRecords,
		) => Effect.Effect<void>
		/** Every delivery in arrival order, including replays after a reconnect. */
		readonly records: Stream.Stream<RecordDuty>
		/** Sends after the record is stored; the kernel ignores a repeat and rejects other content. */
		readonly acknowledge: (record: RecordDuty) => Effect.Effect<void>
	}
>()("@graftland/plugin-remote/Recording/Recorder") {}
