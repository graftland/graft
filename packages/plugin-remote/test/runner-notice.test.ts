import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Queue,
	Ref,
	Scope,
	Sink,
	Stream,
} from "effect"
import { RpcServer } from "effect/rpc"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import { Credentials } from "../src/Auth"
import { ProcessExited } from "../src/Errors"
import * as Runner from "../src/internal/host/runner"
import * as Port from "../src/internal/port"
import {
	defaults,
	SessionStopped,
	stoppedRecord,
	type ExitStatus,
	type LoadedRecord,
	type OpenRecord,
	type Termination,
} from "../src/internal/runner/model"
import * as Multiplex from "../src/internal/runner/Multiplex"
import * as Wire from "../src/internal/runner/Wire"
import { Connector } from "../src/Transport"
import { expectFailure } from "./errors"

const setup = Effect.fnUntraced(function* (
	notice: "advertised" | "unavailable" | "lost",
) {
	const ab = yield* Queue.unbounded<Uint8Array>()
	const ba = yield* Queue.unbounded<Uint8Array>()
	const exited = yield* Deferred.make<void>()
	const watching = yield* Deferred.make<void>()
	const renewals = yield* Ref.make(0)
	const exit: ExitStatus = {
		code: 73,
		signal: null,
		stderr: "Crash stderr tail",
		cause: Cause.die("exit observation marker"),
	}
	const termination: Termination = {
		kind: "Exited",
		exit,
		cause: Cause.die("termination marker"),
	}
	const record: typeof OpenRecord.Type = {
		version: 1,
		phase: "Open",
		handle: {
			key: { identity: "test", instance: "worker" },
			token: "token",
			generation: 1,
		},
		requestId: "request",
		limits: defaults,
		leaseMillis: 15000,
	}
	const code = { name: "fixture", version: "1.0.0", digest: "fixture" }
	const loaded: typeof LoadedRecord.Type = {
		...record,
		phase: "Loaded",
		child: { pid: 42, start: { born: "fixture" } },
		load: { specifier: "fixture" },
		code,
	}
	const mux = yield* Multiplex.make({
		input: Stream.fromQueue(ab),
		output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ba, bytes)),
	})
	const peer = yield* Port.make(Wire.channel(mux, 0), {
		session: "session-v1",
		serve: { session: Wire.Session },
		call: {},
	})
	const handlers = yield* Wire.Session.toHandlers({
		HighWater: () => Effect.succeed(null),
		Open: () =>
			Effect.succeed({
				...record,
				...(notice === "unavailable"
					? {}
					: { terminationNotice: true as const }),
			}),
		Load: () => Effect.succeed(code),
		Status: () =>
			Deferred.isDone(exited).pipe(
				Effect.map((done) =>
					done
						? stoppedRecord(loaded, { _tag: "Exited" }, termination)
						: loaded,
				),
			),
		Renew: () =>
			Ref.update(renewals, (n) => n + 1).pipe(
				Effect.andThen(Deferred.isDone(exited)),
				Effect.flatMap((done) =>
					done
						? Effect.fail(SessionStopped.make({ detail: "The child exited" }))
						: Effect.succeed(record.leaseMillis),
				),
			),
		// The notice carries an observation diagnostic; Dispose itself succeeds cleanly.
		Dispose: () => Effect.succeed({ ...termination, cause: Cause.empty }),
		Terminated: () =>
			Deferred.succeed(watching, undefined).pipe(
				Effect.andThen(
					notice === "advertised"
						? Deferred.await(exited).pipe(Effect.as(exit))
						: Effect.never,
				),
			),
	})
	yield* RpcServer.make(Wire.Session).pipe(
		Effect.provideContext(handlers),
		Effect.provideService(RpcServer.Protocol, peer.serverProtocol("session")),
		Effect.forkScoped,
	)
	const scope = yield* Effect.scope
	const resources = yield* Scope.fork(scope)
	const processScope = yield* Scope.fork(scope)
	const connection = yield* Runner.connect(
		{ _tag: "Connector", instance: "worker" },
		"fixture",
		{ session: "request", serve: {}, call: {} },
		resources,
		processScope,
	).pipe(
		Effect.provideService(Connector, {
			properties: {
				protocol: "unix",
				network: false,
				encrypted: false,
				carries: [],
			},
			connect: () =>
				Effect.succeed({
					input: Stream.fromQueue(ba),
					output: Sink.forEach((bytes: Uint8Array) => Queue.offer(ab, bytes)),
				}),
		}),
		Effect.provideService(Credentials, {
			kind: "None",
			read: Effect.succeed({ _tag: "None" as const }),
		}),
	)
	return { connection, exited, watching, renewals, exit }
})

describe("runner termination notices", () => {
	it.effect("reports the complete process exit before any lease renewal", () =>
		Effect.gen(function* () {
			const { connection, exited, watching, renewals, exit } =
				yield* setup("advertised")
			yield* Deferred.await(watching)
			const observed = yield* Effect.forkScoped(
				Effect.exit(connection.transport.failure),
			)
			yield* Deferred.succeed(exited, undefined)
			const failure = yield* Fiber.join(observed)
			const process = expectFailure(
				Exit.isFailure(failure) ? failure.cause : Cause.empty,
				ProcessExited,
			)
			assert.equal(process.exitCode, 73)
			assert.equal(process.stderr, exit.stderr)
			assert.deepEqual(process.pid, Option.some(42))
			assert.deepEqual(process.statusCause, exit.cause)
			const beforeRenewal = yield* Ref.get(renewals)
			assert.equal(beforeRenewal, 0)
		}),
	)
	for (const notice of ["unavailable", "lost"] as const)
		it.effect(
			`keeps lease detection when termination notices are ${notice}`,
			() =>
				Effect.gen(function* () {
					const { connection, exited, watching, renewals } =
						yield* setup(notice)
					if (notice === "lost") yield* Deferred.await(watching)
					const observed = yield* Effect.forkScoped(
						Effect.exit(connection.transport.failure),
					)
					yield* Deferred.succeed(exited, undefined)
					const beforeRenewal = yield* Ref.get(renewals)
					assert.equal(beforeRenewal, 0)
					yield* TestClock.adjust("5 seconds")
					const failure = yield* Fiber.join(observed)
					const process = expectFailure(
						Exit.isFailure(failure) ? failure.cause : Cause.empty,
						ProcessExited,
					)
					assert.equal(process.exitCode, 73)
					assert.equal(process.stderr, "Crash stderr tail")
					const afterRenewal = yield* Ref.get(renewals)
					assert.equal(afterRenewal, 1)
				}),
		)
})
