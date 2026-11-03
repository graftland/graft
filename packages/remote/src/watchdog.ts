/** Executable worker: fd 4 and the lease timer remain independent of the plugin thread. */
import { NodeRuntime, NodeStream } from "@effect/platform-node"
import { Effect, FiberHandle, Ref, Schema, Stream } from "effect"
import { Socket } from "node:net"
import { parentPort } from "node:worker_threads"
import process from "node:process"
import { CommandJson, Notice } from "./internal/runner/WatchdogProtocol"

// The runner machine is trusted. A suspended machine cannot enforce a deadline until it resumes.
// Killing this live process has no PID lookup; external supervisor kills retain a small PID reuse window.
const die = Effect.sync(() => process.kill(process.pid, "SIGKILL")).pipe(
	Effect.andThen(Effect.never),
)
const notify = (notice: typeof Notice.Type) =>
	Schema.encodeEffect(Notice)(notice).pipe(
		Effect.flatMap((message) =>
			Effect.sync(() => parentPort?.postMessage(message)),
		),
	)
const now = Effect.sync(() => performance.now())
const expire = (deadline: number): Effect.Effect<never> =>
	Effect.gen(function* () {
		const remaining = deadline - (yield* now)
		if (remaining <= 0) return yield* die
		yield* Effect.sleep(Math.min(remaining, 2147483647))
		return yield* expire(deadline)
	})
const main = Effect.scoped(
	Effect.gen(function* () {
		const lease = yield* Ref.make({
			deadline: (yield* now) + 30000,
			stopped: false,
		})
		const timer = yield* FiberHandle.make<never, never>()
		yield* FiberHandle.run(timer, expire((yield* Ref.get(lease)).deadline))
		const input = yield* Effect.acquireRelease(
			Effect.sync(() => new Socket({ fd: 4, readable: true, writable: false })),
			(socket) =>
				Effect.sync(() => {
					socket.destroy()
				}),
		)
		yield* notify("ready")
		yield* NodeStream.fromReadable({ evaluate: () => input }).pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.mapEffect((line) => Schema.decodeEffect(CommandJson)(line)),
			Stream.runForEach((command) =>
				Effect.gen(function* () {
					if (command.kind === "start") return yield* notify("start")
					if (command.kind === "stop") {
						yield* Ref.update(lease, (state) => ({ ...state, stopped: true }))
						return yield* notify("stop")
					}
					const current = yield* Ref.get(lease)
					const time = yield* now
					if (current.stopped || time >= current.deadline) return yield* die
					const deadline = time + command.millis
					yield* Ref.set(lease, { deadline, stopped: false })
					yield* FiberHandle.run(timer, expire(deadline))
				}),
			),
		)
		return yield* die
	}),
).pipe(
	Effect.catchCause((cause) =>
		Effect.logError("Watchdog failed", cause).pipe(Effect.andThen(die)),
	),
)

NodeRuntime.runMain(main)
