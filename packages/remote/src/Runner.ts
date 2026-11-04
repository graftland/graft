import { ModuleImportFailed, ContractNotFound } from "./internal/childErrors"
import type { Graft } from "@graftland/graft"
import { NodeSink } from "@effect/platform-node"
import { Cause, Effect, Logger, Option, Stdio, Stream } from "effect"
import { RpcServer } from "effect/rpc"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's extra inherited descriptor is the dedicated protocol output, separate from console output.
import { createWriteStream } from "node:fs"
import { fromModule, type RunnerContract } from "./Contract"
import { TransportError } from "./Errors"
import * as Port from "./internal/port"
import * as Services from "./internal/services"
import * as Child from "./internal/child"
import * as Multiplex from "./internal/runner/Multiplex"
import * as Wire from "./internal/runner/Wire"
import type { Bootstrap } from "./internal/runner/Bootstrap"
import type { ExecutionError } from "./internal/runner/model"
import { endpoint } from "./internal/control"

/** Import a contract in the runner installation; importing this module performs no I/O. */
export const load = (specifier: string) =>
	Effect.gen(function* () {
		const module = yield* Effect.tryPromise({
			try: () => import(specifier),
			catch: (cause) => ModuleImportFailed.make({ module: specifier, cause }),
		})
		const contract = fromModule(module)
		if (Option.isNone(contract))
			return yield* ContractNotFound.make({ module: specifier })
		return contract.value
	})

const bytes = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const output = yield* Effect.sync(() =>
		createWriteStream("", { fd: 3, autoClose: false }),
	)
	return {
		input: stdio.stdin.pipe(
			Stream.mapError((error) =>
				TransportError.make({ cause: Cause.fail(error) }),
			),
		),
		output: NodeSink.fromWritable({
			evaluate: () => output,
			onError: (cause) => TransportError.make({ cause: Cause.die(cause) }),
			endOnDone: false,
		}),
	} satisfies Port.Channel
})
const connect = (
	contract: RunnerContract,
	session: string,
	bootstrap: Bootstrap | undefined,
) =>
	Effect.gen(function* () {
		const channel = yield* bytes
		const mux =
			bootstrap === undefined ? undefined : yield* Multiplex.make(channel)
		return yield* Port.make(
			mux === undefined ? channel : Wire.channel(mux, 1),
			{
				session,
				serve: {
					...Services.endpoints(contract.provides),
					[endpoint]: contract.control,
				},
				call: Services.endpoints(contract.inject),
				...(bootstrap === undefined ? {} : { limits: bootstrap.limits }),
			},
		)
	})

/** One execution unit; the executable supplies the platform and Graft services. */
export const run = (
	contract: RunnerContract,
	session = "local",
	bootstrap?: Bootstrap,
	stop: Effect.Effect<unknown, ExecutionError> = Effect.never,
): Effect.Effect<void, ExecutionError, Graft.Graft | Stdio.Stdio> =>
	Effect.scoped(
		Effect.gen(function* () {
			const telemetry = yield* Child.telemetry(contract)
			const loggers = yield* Logger.CurrentLoggers
			yield* Effect.gen(function* () {
				const peer = yield* connect(contract, session, bootstrap)
				const instance = yield* Child.lifecycle(
					contract,
					peer,
					bootstrap?.identity ?? { id: session, generation: 1 },
					telemetry,
				)
				const handlers = yield* contract.control.toHandlers({
					Load: ({ input }) => instance.load(input),
					Dispose: () => instance.dispose,
					Events: () => telemetry.eventStream,
					Logs: () => telemetry.logStream,
				})
				yield* RpcServer.make(contract.control, {
					disableFatalDefects: true,
				}).pipe(
					Effect.provideContext(handlers),
					Effect.provideService(
						RpcServer.Protocol,
						peer.serverProtocol(endpoint),
					),
					Effect.forkScoped,
				)
				yield* Effect.raceFirst(Effect.flip(peer.await), stop).pipe(
					// Release exports before closing the instance scope, including on interruption.
					Effect.ensuring(instance.release),
				)
			}).pipe(
				Effect.provideService(
					Logger.CurrentLoggers,
					new Set([...loggers, telemetry.logger]),
				),
			)
		}),
	)
