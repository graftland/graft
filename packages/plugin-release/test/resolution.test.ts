import {
	Array,
	Cause,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	Ref,
	Schema,
	String,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

import { resolve } from "../src/internal/candidates"
import { ReleaseError } from "../src/Model"

it.effect(
	"resolves rotated references for recovery from the retained desired input",
	() =>
		Effect.gen(function* () {
			const token = yield* Ref.make("initial-credential")
			const provider = ConfigProvider.make((path) =>
				Ref.get(token).pipe(
					Effect.map((value) =>
						path[0] === "TOKEN" ? ConfigProvider.makeValue(value) : undefined,
					),
				),
			)
			const allocated = yield* Ref.make<ReadonlyArray<string>>([])
			const desired = Remote.candidate({
				artifact: {
					identity: {
						version: 1,
						algorithm: "sha256",
						digest: String.repeat(64)("a"),
						entry: "index.js",
					},
					directory: "fixture",
				},
				contractModule: "file:///fixture/contract.js",
				target: { _tag: "Worker" },
				input: { token: { $env: "TOKEN" } },
			})
			const config = Schema.Struct({ token: Schema.String })
			const decode = (
				deployment: Remote.CandidateOptions,
				input: Schema.Json,
			) =>
				Schema.decodeUnknownEffect(config)(input).pipe(
					Effect.asVoid,
					Effect.mapError((cause) =>
						ReleaseError.make({
							code: "Configuration",
							message: `Invalid input for ${deployment.artifact.identity.entry}`,
							cause: Cause.fail(cause),
						}),
					),
				)
			const resolver = (candidate: Change.Candidate) =>
				resolve(candidate, false, decode).pipe(
					Effect.scoped,
					Effect.provideService(ConfigProvider.ConfigProvider, provider),
					Effect.mapError((cause) =>
						Transition.DriverError.make({ cause: Cause.fail(cause) }),
					),
				)
			const driver: Transition.Driver = {
				name: desired.driver,
				allocate: (candidate, generation, acknowledgement) =>
					Effect.gen(function* () {
						const deployment = yield* Schema.decodeUnknownEffect(
							Remote.CandidateOptions,
						)(candidate.deployment).pipe(
							Effect.mapError((cause) =>
								Transition.DriverError.make({ cause: Cause.fail(cause) }),
							),
						)
						const input = yield* Schema.decodeUnknownEffect(config)(
							deployment.input,
						).pipe(
							Effect.mapError((cause) =>
								Transition.DriverError.make({ cause: Cause.fail(cause) }),
							),
						)
						yield* Ref.update(allocated, Array.append(input.token))
						const exited = yield* Deferred.make<Change.Termination>()
						const stop = Deferred.succeed(exited, {
							unit: `unit-${generation}`,
							state: "Exited",
						}).pipe(Effect.asVoid)
						return {
							acknowledgement,
							start:
								generation === 2
									? Ref.set(token, "recovery-credential").pipe(
											Effect.andThen(
												Transition.DriverError.make({
													cause: Cause.fail("Candidate startup failed"),
												}),
											),
										)
									: Effect.void,
							describe: Effect.succeed({ overlap: false, provides: [] }),
							serve: Effect.void,
							ready: Effect.succeed(Context.empty()),
							probe: () => Effect.void,
							stop,
							terminate: stop,
							exited: Deferred.await(exited),
							failure: Effect.never,
						}
					}),
			}
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "reference-resolution",
					apply: () =>
						Transition.registerDriver(driver, {
							instance: "a",
							initial: desired,
							resolve: resolver,
							required: [],
							facades: [],
						}),
				}),
			)
			yield* fork.await
			yield* Ref.set(token, "candidate-credential")
			const outcome = yield* Change.run({ instance: "a", candidate: desired })
			assert.strictEqual(outcome._tag, "Recovered")
			const observed = yield* Ref.get(allocated)
			assert.deepStrictEqual(observed, [
				"initial-credential",
				"candidate-credential",
				"recovery-credential",
			])
			const retained = yield* Schema.decodeUnknownEffect(
				Remote.CandidateOptions,
			)(desired.deployment)
			assert.deepStrictEqual(retained.input, { token: { $env: "TOKEN" } })
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
