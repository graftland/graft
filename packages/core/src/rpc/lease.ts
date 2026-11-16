/**
 * Service leases for streaming RPC handlers.
 *
 * Effect handlers can wrap their work in `Graft.use`, which holds the service
 * for the duration of the call. A streaming handler returns a `Stream` instead,
 * so the lease has to cover the whole stream: from the first pull until the
 * stream ends, fails, or is interrupted.
 */
import { Cause, Effect, Exit, Queue, Stream, type Context } from "effect"

import * as Graft from "../Graft"

/**
 * Leases the service for as long as the returned stream is alive.
 *
 * The stream starts by acquiring the lease, keeps it while it emits, and
 * releases it when it ends, fails, or is interrupted. This is the stream
 * counterpart of `Graft.use`: if the service is withdrawn while the stream is
 * running, the stream is interrupted and fails with `ServiceWithdrawn`, and the
 * provider only tears the service down after the stream has stopped.
 */
export const useStream = <I, S, A, E, R>(
	key: Context.Key<I, S>,
	f: (service: S) => Stream.Stream<A, E, R>,
): Stream.Stream<A, E | Graft.ServiceWithdrawn, R | Graft.Graft> =>
	Stream.unwrap(
		Effect.gen(function* () {
			// A small bounded queue keeps pull-based backpressure: the producer
			// suspends instead of buffering the whole stream. Ending or failing
			// the queue still drains the values that are already buffered.
			const queue = yield* Queue.bounded<
				A,
				E | Graft.ServiceWithdrawn | Cause.Done
			>(1)
			// The producer runs in the stream's own scope, so ending or
			// interrupting the stream interrupts it, which releases the lease
			// held by `Graft.use`. Its exit is relayed through the queue, so a
			// failure (including withdrawal) reaches the consumer.
			yield* Graft.use(key, (service) =>
				Stream.runForEach(f(service), (value) => Queue.offer(queue, value)),
			).pipe(
				Effect.onExit((exit) =>
					Exit.isSuccess(exit)
						? Queue.end(queue)
						: Queue.failCause(queue, exit.cause),
				),
				Effect.forkScoped,
			)
			return Stream.fromQueue(queue)
		}),
	)
