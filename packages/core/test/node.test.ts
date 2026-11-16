/**
 * `./node` transports against real processes.
 *
 * A child process serves the counter over its standard input and output, and a
 * `worker_threads` worker serves it over the worker channel. Both fixtures run
 * the same `Remote.serve` program, so these tests cover the transport adapters
 * and the whole client/server path at once.
 */
import { Effect, Layer, Schedule, type Scope } from "effect"
import type * as RpcClient from "effect/rpc/RpcClient"
import { assert, describe, it } from "@effect/vitest"

import { Graft } from "../src/index.ts"
import * as Node from "../src/node/index.ts"
import { Remote } from "../src/rpc/index.ts"
import { Counter, CounterRemote } from "./fixtures/node-service.ts"

const loader = new URL("./fixtures/loader.mjs", import.meta.url).pathname
const childEntry = new URL("./fixtures/node-child.ts", import.meta.url).pathname
const workerEntry = new URL("./fixtures/node-worker.ts", import.meta.url)

/** Connects, waits for the mirrored counter, and checks two calls against it. */
const connectAndIncrement = <E>(
	protocol: Effect.Effect<RpcClient.Protocol["Service"], E, Scope.Scope>,
) =>
	Effect.gen(function* () {
		const mount = yield* Remote.connect({
			services: [CounterRemote],
			protocol,
			retry: Schedule.exponential("100 millis"),
		})
		yield* mount.await
		const counter = yield* Graft.await(Counter)
		const first = yield* counter.inc(20).pipe(Effect.orDie)
		const second = yield* counter.inc(22).pipe(Effect.orDie)
		assert.strictEqual(first, 20)
		assert.strictEqual(second, 42)
		yield* mount.unmount
	}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

describe("node transports", () => {
	it.live(
		"round trips a call through a real child process",
		() =>
			connectAndIncrement(
				Node.subprocessProtocol({
					entry: childEntry,
					execArgv: ["--import", loader],
					stderr: "inherit",
				}),
			).pipe(Effect.timeout("20 seconds")),
		30_000,
	)

	it.live(
		"round trips a call through a real worker thread",
		() =>
			connectAndIncrement(
				Node.workerProtocol({
					entry: workerEntry,
					execArgv: ["--import", loader],
				}),
			).pipe(Effect.timeout("20 seconds")),
		30_000,
	)
})
