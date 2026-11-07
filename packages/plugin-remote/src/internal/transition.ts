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
	Schema,
	Scope,
	TxRef,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"

import { Graft, Plugin, Transition } from "@graftland/graft"

import * as Artifact from "../Artifact"
import * as Capabilities from "../Capabilities"
import * as Contract from "../Contract"
import * as Policy from "../Policy"
import * as Sandbox from "../Sandbox"
import { candidate, CandidateOptions, driverName } from "./candidate"
import { type Execution } from "./directTransport"
import { layer as localLayer } from "./localTransport"
import * as Unit from "./unit"
import { layer as workerLayer } from "./workerTransport"

export interface ManagedOptions extends Omit<CandidateOptions, "input"> {
	/** Required outside Loader; must match the entry id when Loader supplies one. */
	readonly instance?: string | undefined
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
>(contract: Contract.Contract<S, E>, instance?: string) {
	const environment =
		yield* Effect.context<Effect.Services<ReturnType<typeof Unit.open<S, E>>>>()
	const ambient = yield* Effect.context<never>()
	const runtime = Context.getOption(ambient, Graft.Graft)
	const selection = yield* Sandbox.Current
	const launcher = Option.fromUndefinedOr(selection)
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
					const binding = Effect.gen(function* () {
						if (instance === undefined) return undefined
						if (Option.isNone(runtime))
							return yield* Effect.die("Managed Remote requires Graft")
						if (
							!(yield* Policy.enabled.pipe(
								Effect.provideService(Graft.Graft, runtime.value),
							))
						)
							return undefined
						const fs = Context.get(environment, FileSystem.FileSystem)
						const path = Context.get(environment, Path.Path)
						const json = yield* fs.readFileString(
							path.join(options.artifact.directory, "package.json"),
						)
						const pkg = yield* Schema.decodeEffect(
							Schema.fromJsonString(
								Schema.Struct({ name: Schema.NonEmptyString }),
							),
						)(json)
						return yield* Policy.bind(
							instance,
							value.identity,
							{
								package: pkg.name,
								digest: options.artifact.identity.digest,
							},
							Array.map(contract.provides, (service) => service.key.key),
						).pipe(Effect.provideService(Graft.Graft, runtime.value))
					})
					const assignment = yield* binding

					const sandbox: Effect.Effect<
						Sandbox.Launch | undefined,
						Sandbox.SandboxError,
						Scope.Scope
					> =
						assignment?.tier !== "untrusted"
							? Effect.undefined
							: Effect.gen(function* () {
									if (options.target._tag !== "Local")
										return yield* Sandbox.SandboxError.make({
											reason: "UnsupportedPlacement",
											message:
												"Untrusted entries require a sandboxed child process; Workers are not a security boundary",
										})
									if (Option.isNone(launcher))
										return yield* Sandbox.SandboxError.make({
											reason: "LauncherUnavailable",
											message:
												"No sandbox launcher is installed; untrusted execution is disabled",
										})
									if (assignment.contractEntry === undefined)
										return yield* Sandbox.SandboxError.make({
											reason: "UnsupportedLayout",
											message:
												"Untrusted entries need a bundled contractEntry inside the artifact",
										})
									return yield* launcher.value.prepare({
										artifact: options.artifact,
										contractEntry: assignment.contractEntry,
									})
								})
					type Handle = Effect.Success<ReturnType<typeof Unit.open<S, E>>>
					const handle = yield* Deferred.make<Handle, Transition.DriverError>()
					type Lifecycle =
						| { readonly _tag: "Allocated" }
						| {
								readonly _tag: "NotStarted"
								readonly cause: Cause.Cause<unknown>
						  }
						| {
								readonly _tag: "Starting" | "Settled"
								readonly spawned: boolean
								readonly execution: Option.Option<Execution>
								readonly cause: Cause.Cause<unknown>
						  }
					const lifecycle = yield* TxRef.make<Lifecycle>({ _tag: "Allocated" })
					const attemptScope = yield* Deferred.make<Scope.Scope>()
					const unit = `direct-${attempt}`
					const settled = Effect.tx(
						Effect.gen(function* () {
							const state = yield* TxRef.get(lifecycle)
							if (state._tag === "Allocated") return yield* Effect.txRetry
							if (state._tag === "Starting" && Option.isNone(state.execution))
								return yield* Effect.txRetry
							return state
						}),
					)
					const observed = settled.pipe(
						Effect.flatMap((state) => {
							if (state._tag === "NotStarted")
								return Effect.succeed<Transition.Termination>({
									unit,
									state: "NotStarted",
									cause: state.cause,
								})
							if (Option.isSome(state.execution))
								return state.execution.value.exited.pipe(
									Effect.map((status): Transition.Termination => ({
										unit,
										state: "Exited",
										cause: Cause.fail(status),
									})),
								)
							// Losing the transport after spawn is not proof that the execution exited.
							return state.spawned
								? Effect.never
								: Effect.succeed<Transition.Termination>({
										unit,
										state: "NotStarted",
										cause: state.cause,
									})
						}),
					)

					const use = <A, E2, R>(
						f: (handle: Handle) => Effect.Effect<A, E2, R>,
					) => failure(Deferred.await(handle).pipe(Effect.flatMap(f)))
					return {
						start: Effect.uninterruptibleMask((restore) =>
							Effect.gen(function* () {
								yield* Effect.tx(
									Effect.gen(function* () {
										const state = yield* TxRef.get(lifecycle)
										if (state._tag !== "Allocated")
											return yield* Transition.DriverError.make({
												cause: Cause.die(
													new Error(
														"The execution unit cannot start after startup or termination",
													),
												),
											})
										yield* TxRef.set(lifecycle, {
											_tag: "Starting",
											spawned: false,
											execution: Option.none(),
											cause: Cause.empty,
										})
									}),
								)
								const scope = yield* Effect.scope
								yield* Deferred.succeed(attemptScope, scope)
								const result = yield* Effect.exit(
									restore(
										failure(
											sandbox.pipe(
												Effect.flatMap((launch) =>
													Effect.gen(function* () {
														const broker =
															assignment === undefined
																? undefined
																: yield* Capabilities.make(
																		assignment.entry,
																		value.identity,
																		assignment,
																	).pipe(
																		Effect.provideService(
																			Graft.Graft,
																			Option.getOrThrow(runtime),
																		),
																	)
														return yield* Unit.open(contract, {
															...options,
															clearEnvironment: assignment !== undefined,
															...(launch === undefined
																? {}
																: { sandbox: launch }),
															onSpawn: TxRef.update(lifecycle, (state) =>
																state._tag === "Starting"
																	? { ...state, spawned: true }
																	: state,
															),
															onExecution: (current) =>
																Effect.gen(function* () {
																	yield* TxRef.update(lifecycle, (state) =>
																		state._tag === "Starting"
																			? {
																					...state,
																					execution: Option.some(current),
																				}
																			: state,
																	)
																	if (assignment !== undefined)
																		yield* Policy.onRevoke(
																			assignment.entry,
																			value.identity,
																			current.terminate.pipe(
																				Effect.andThen(current.exited),
																				Effect.asVoid,
																				Effect.catchCause((cause) =>
																					Policy.PolicyError.make({
																						message:
																							"Revoked execution exit is unconfirmed",
																						cause,
																					}),
																				),
																			),
																		).pipe(
																			Scope.provide(scope),
																			Effect.provideService(
																				Graft.Graft,
																				Option.getOrThrow(runtime),
																			),
																		)
																}).pipe(Effect.orDie),
														}).pipe((effect) =>
															broker === undefined
																? effect
																: Effect.provideService(
																		effect,
																		Capabilities.Broker,
																		broker,
																	),
														)
													}),
												),
												Scope.provide(scope),
												Effect.provideContext(environment),
											),
										),
									),
								)
								yield* TxRef.update(lifecycle, (state) =>
									state._tag === "Starting"
										? {
												...state,
												_tag: "Settled" as const,
												cause: Exit.isFailure(result)
													? result.cause
													: Cause.empty,
											}
										: state,
								)
								yield* Deferred.done(handle, result)
								return yield* result
							}),
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
							Effect.uninterruptibleMask((restore) =>
								Effect.gen(function* () {
									const cancelled = yield* Effect.tx(
										Effect.gen(function* () {
											const state = yield* TxRef.get(lifecycle)
											if (state._tag !== "Allocated") return false
											yield* TxRef.set(lifecycle, {
												_tag: "NotStarted",
												cause: Cause.empty,
											})
											return true
										}),
									)
									if (cancelled)
										yield* Deferred.fail(
											handle,
											Transition.DriverError.make({
												cause: Cause.die(
													new Error(
														"The execution unit was terminated before startup",
													),
												),
											}),
										)
									const state = yield* restore(settled)
									if (
										state._tag !== "NotStarted" &&
										Option.isSome(state.execution)
									)
										yield* restore(state.execution.value.terminate)
								}),
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
					!Array.every(
						contract.inject,
						(service) => service.key.key === Capabilities.Broker.key,
					) ||
					!Array.every(contract.provides, (service) => service.unary)
				)
					return yield* Transition.DriverError.make({
						cause: Cause.die(
							new Error(
								"Managed Remote plugins require unary contracts with only host capability injection and an admission limit between 1 and 16",
							),
						),
					})
				const transports = yield* Layer.build(
					Layer.merge(localLayer, workerLayer),
				)
				const bound = yield* Transition.CurrentInstance
				const instance = options.instance ?? Option.getOrUndefined(bound)
				const execution = yield* driver(contract, instance).pipe(
					Effect.provideContext(transports),
				)
				yield* Transition.registerDriver(execution, {
					instance: options.instance,
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
