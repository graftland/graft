import { Cause, Deferred, Effect } from "effect"
import { Worker } from "node:worker_threads"
import { failure } from "./model"

/**
 * fd 4 belongs exclusively to this worker. A blocked plugin main thread cannot
 * delay EOF or lease expiry. SIGKILL targets the process, not only this worker.
 */
const source = String.raw`
const { parentPort } = require("node:worker_threads");
const { Socket } = require("node:net");
let timer;
let ended = false;
let deadline = Infinity;
const die = () => process.kill(process.pid, "SIGKILL");
process.on("uncaughtException", die);
process.on("unhandledRejection", die);
const tick = () => {
  const remaining = deadline - performance.now();
  if (remaining <= 0) die();
  else timer = setTimeout(tick, Math.min(remaining, 2147483647));
};
const arm = (millis) => {
  if (performance.now() >= deadline || ended || !Number.isFinite(millis) || millis <= 0) return die();
  deadline = performance.now() + millis;
  clearTimeout(timer);
  tick();
};
let buffer = "";
arm(30000);
// A pollable pipe avoids an outstanding fs.read blocking Worker.terminate().
const input = new Socket({ fd: 4, readable: true, writable: false });
input.on("end", die);
input.on("error", die);
input.on("data", (bytes) => {
  buffer += bytes.toString("utf8");
  if (buffer.length > 4096) return die();
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n");
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const command = JSON.parse(line);
      if (command.kind === "renew") arm(command.millis);
      else if (command.kind === "start") parentPort.postMessage("start");
      else if (command.kind === "stop") { ended = true; parentPort.postMessage("stop"); }
      else die();
    } catch { die(); }
  }
});
parentPort.postMessage("ready");
`

export const start = Effect.gen(function* () {
	const ready = yield* Deferred.make<void>()
	const begin = yield* Deferred.make<void>()
	const stop = yield* Deferred.make<void>()
	const failed = yield* Deferred.make<never, ReturnType<typeof failure>>()
	const worker = yield* Effect.acquireRelease(
		Effect.try({
			try: () => new Worker(source, { eval: true }),
			catch: (cause) =>
				failure(
					"Execution",
					"Starting the child watchdog failed",
					Cause.die(cause),
				),
		}),
		(worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
	)
	worker.on("message", (message: unknown) => {
		if (message === "ready") Deferred.doneUnsafe(ready, Effect.void)
		else if (message === "start") Deferred.doneUnsafe(begin, Effect.void)
		else if (message === "stop") Deferred.doneUnsafe(stop, Effect.void)
	})
	worker.on("error", (error) =>
		Deferred.doneUnsafe(
			failed,
			Effect.fail(
				failure("Execution", "Child watchdog failed", Cause.die(error)),
			),
		),
	)
	worker.on("exit", (code) =>
		Deferred.doneUnsafe(
			failed,
			Effect.fail(failure("Execution", "Child watchdog exited: " + code)),
		),
	)
	yield* Effect.raceFirst(Deferred.await(ready), Deferred.await(failed))
	return {
		begin: Effect.raceFirst(Deferred.await(begin), Deferred.await(failed)),
		stop: Effect.raceFirst(Deferred.await(stop), Deferred.await(failed)),
	}
})
