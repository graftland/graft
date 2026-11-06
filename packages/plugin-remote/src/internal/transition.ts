import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	Ref,
	Schema,
	Scope,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"

import { Plugin, Transition } from "@graftland/graft"

import * as Artifact from "../Artifact"
import * as Contract from "../Contract"
import { candidate, CandidateOptions, driverName } from "./candidate"
import { type Execution } from "./directTransport"
import { layer as localLayer } from "./localTransport"
import * as Unit from "./unit"
import { layer as workerLayer } from "./workerTransport"

export interface ManagedOptions extends Omit<CandidateOptions, "input"> {
	readonly policy?: Partial<Transition.Policy> | undefined
	/** Must be between 1 and the direct transport capacity (16). Defaults to 16. */
	readonly maxInFlight?: number | undefined
}
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catchCause((cause) => Transition.DriverError.make({ cause })),
	)
export const driver = Effect.fnUntraced(function* <
	S extends Contract.ConfigSchema,
	E extends Contract.ErrorSchema,
>(contract: Contract.Contract<S, E>) {
	const environment =
		yield* Effect.context<Effect.Services<ReturnType<typeof Unit.open<S, E>>>>()
	return {
		name: driverName,
		allocate: (value, attempt) =>
			failure(
				Effect.gen(function* () {
					const options = yield* Schema.decodeUnknownEffect(CandidateOptions)(
						value.deployment,
					)
					if (candidate(options).identity !== value.identity)
						return yield* Effect.die(
							new Error("Candidate identity does not match its deployment"),
						)
					yield* Artifact.verify(options.artifact).pipe(
						Effect.provideContext(environment),
					)
					type Handle = Effect.Success<ReturnType<typeof Unit.open<S, E>>>
					const handle = yield* Deferred.make<Handle, Transition.DriverError>()
					const execution = yield* Ref.make<Option.Option<Execution>>(
						Option.none(),
					)
					const started = yield* Deferred.make<void>()
					const spawned = yield* Ref.make(false)
					const startCause = yield* Ref.make<Cause.Cause<unknown>>(Cause.empty)
					const changed = yield* Deferred.make<Execution>()
					const attemptScope = yield* Deferred.make<Scope.Scope>()
					const unit = `direct-${attempt}`
					const observed = Effect.raceFirst(
						Deferred.await(changed),
						Deferred.await(started).pipe(Effect.andThen(Ref.get(execution))),
					).pipe(
						Effect.flatMap((result) => {
							if (Option.isOption(result)) {
								if (Option.isNone(result))
									return Ref.get(spawned).pipe(
										Effect.flatMap((spawned) =>
											spawned
												? Effect.never
												: Ref.get(startCause).pipe(
														Effect.map((cause): Transition.Termination => ({
															unit,
															state: "NotStarted",
															cause,
														})),
													),
										),
									)
								return result.value.exited.pipe(
									Effect.map((status): Transition.Termination => ({
										unit,
										state: "Exited",
										cause: Cause.fail(status),
									})),
								)
							}
							return result.exited.pipe(
								Effect.map((status): Transition.Termination => ({
									unit,
									state: "Exited",
									cause: Cause.fail(status),
								})),
							)
						}),
					)
					const use = <A, E2, R>(
						f: (handle: Handle) => Effect.Effect<A, E2, R>,
					) => failure(Deferred.await(handle).pipe(Effect.flatMap(f)))
					return {
						start: Effect.gen(function* () {
							const scope = yield* Effect.scope
							yield* Deferred.succeed(attemptScope, scope)
							const result = yield* Effect.exit(
								failure(
									Unit.open(contract, {
										...options,
										onSpawn: Ref.set(spawned, true),
										onExecution: (current) =>
											Ref.set(execution, Option.some(current)).pipe(
												Effect.andThen(Deferred.succeed(changed, current)),
												Effect.asVoid,
											),
									}).pipe(
										Scope.provide(scope),
										Effect.provideContext(environment),
									),
								),
							)
							yield* Deferred.done(handle, result)
							return yield* result
						}).pipe(
							Effect.onExit((exit) =>
								Ref.set(
									startCause,
									Exit.isFailure(exit) ? exit.cause : Cause.empty,
								).pipe(Effect.andThen(Deferred.succeed(started, undefined))),
							),
						),
						describe: use((handle) =>
							handle.describe.pipe(
								Effect.map((description) => ({
									overlap: description.overlap,
									provides: Array.flatMap(
										description.provides,
										(service) => service.operations,
									),
								})),
							),
						),
						serve: use((handle) => handle.serve(options.input)),
						ready: use((handle) =>
							Effect.gen(function* () {
								yield* handle.ready
								// The unit owns its clients; only descriptor facades publish into the live graph.
								const scope = yield* Deferred.await(attemptScope)
								const contexts = yield* Effect.forEach(
									contract.provides,
									(service) => service.clients(handle),
								).pipe(Scope.provide(scope))
								const context = Array.reduce(
									contexts,
									Context.empty(),
									(all, next) => Context.merge(all, next),
								)
								return context
							}),
						),
						probe: (name) => use((handle) => handle.probe(name)),
						stop: use((handle) =>
							handle.stop.pipe(
								Effect.flatMap((cause) =>
									cause.reasons.length === 0
										? Effect.void
										: Transition.DriverError.make({ cause }),
								),
								Effect.andThen(handle.terminate("graceful")),
								Effect.asVoid,
							),
						),
						terminate: failure(
							Effect.raceFirst(
								Deferred.await(changed),
								Deferred.await(started).pipe(
									Effect.andThen(Ref.get(execution)),
								),
							).pipe(
								Effect.flatMap((result) =>
									Option.isOption(result)
										? Option.match(result, {
												onNone: () => Effect.void,
												onSome: (current) => Effect.asVoid(current.terminate),
											})
										: Effect.asVoid(result.terminate),
								),
							),
						),
						exited: failure(observed),
						failure: use((handle) => handle.failure),
					} satisfies Transition.Unit
				}),
			),
	} satisfies Transition.Driver
})

export const managedPlugin = <
	S extends Contract.ConfigSchema,
	E extends Contract.ErrorSchema,
>(
	contract: Contract.Contract<S, E>,
	options: ManagedOptions,
) =>
	Plugin.make({
		name: contract.name,
		config: Schema.toEncoded(contract.config),
		inject: [
			FileSystem.FileSystem,
			Path.Path,
			SecureRandom.SecureRandom,
			ChildProcessSpawner.ChildProcessSpawner,
		],
		apply: (input) =>
			Effect.gen(function* () {
				const maxInFlight = options.maxInFlight ?? 16
				if (
					!Number.isSafeInteger(maxInFlight) ||
					maxInFlight < 1 ||
					maxInFlight > 16 ||
					contract.inject.length > 0 ||
					!Array.every(contract.provides, (service) => service.unary)
				)
					return yield* Transition.DriverError.make({
						cause: Cause.die(
							new Error(
								"Managed Remote plugins require unary contracts without injected services and an admission limit between 1 and 16",
							),
						),
					})
				const transports = yield* Layer.build(
					Layer.merge(localLayer, workerLayer),
				)
				const execution = yield* driver(contract).pipe(
					Effect.provideContext(transports),
				)
				yield* Transition.registerDriver(execution, {
					initial: candidate({
						artifact: options.artifact,
						contractModule: options.contractModule,
						target: options.target,
						input,
					}),
					required: Array.flatMap(
						contract.provides,
						(service) => service.operations,
					),
					facades: Array.map(contract.provides, (service) => service.facade),
					maxInFlight,
					policy: options.policy,
				})
			}),
	})
