import { loadModule } from "./loadModule"
import { ContractNotFound } from "./childErrors"
import type { Graft } from "@graftland/graft"
import { Effect, Logger, Option } from "effect"
import { RpcServer } from "effect/rpc"
import { fromModule, type RunnerContract } from "../Contract"
import * as Port from "./port"
import { prepare, type RunnerContract as PreparedContract } from "./contract"
import * as Services from "./services"
import * as Child from "./child"
import * as Multiplex from "./runner/Multiplex"
import * as Wire from "./runner/Wire"
import type { Bootstrap } from "./runner/Bootstrap"
import { ExecutionError } from "./runner/model"
import { closedNormally } from "./runner/connectionEnded"
import { endpoint } from "./control"

/** Import a contract in the runner installation; importing this module performs no I/O. */
export const load = (specifier: string) =>
	Effect.gen(function* () {
		const module = yield* loadModule(specifier)
		const contract = fromModule(module)
		if (Option.isNone(contract))
			return yield* ContractNotFound.make({ module: specifier })
		return contract.value
	})

const connect = (
	contract: PreparedContract,
	channel: Port.Channel,
	session: string,
	bootstrap: Bootstrap | undefined,
) =>
	Effect.gen(function* () {
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
	descriptor: RunnerContract,
	channel: Port.Channel,
	session = "local",
	bootstrap?: Bootstrap,
	stop: Effect.Effect<unknown, ExecutionError> = Effect.never,
): Effect.Effect<void, ExecutionError, Graft.Graft> =>
	Effect.scoped(
		Effect.gen(function* () {
			const contract = prepare(descriptor)
			const telemetry = yield* Child.telemetry(contract)
			const loggers = yield* Logger.CurrentLoggers
			yield* Effect.gen(function* () {
				const peer = yield* connect(contract, channel, session, bootstrap)
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
				yield* Effect.raceFirst(
					peer.await.pipe(
						Effect.catchIf(
							(error) => closedNormally(error.cause),
							() => Effect.void,
						),
						Effect.mapError((error) =>
							ExecutionError.make({
								detail: "Child transport failed",
								cause: error.cause,
							}),
						),
					),
					stop,
				).pipe(
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
