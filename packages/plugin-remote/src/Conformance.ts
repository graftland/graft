/** Public checks shared by first-party and independently published plugins. */
import {
	Array,
	Cause,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Schema,
} from "effect"
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcSchema } from "effect/rpc"

import { Manifest } from "@graftland/graft"

import type * as Contract from "./Contract"
import type { CandidateOptions } from "./internal/candidate"
import { layer as localLayer } from "./internal/localTransport"
import { identities } from "./internal/operations"
import * as Unit from "./internal/unit"
import { layer as workerLayer } from "./internal/workerTransport"
import * as Publication from "./Publication"
import { ConformanceError } from "./Testing"

export { ConformanceError } from "./Testing"
export interface Request {
	readonly operation: string
	readonly payload: unknown
}
export interface Example extends Request {
	readonly expected:
		| { readonly _tag: "Success" | "BusinessError"; readonly value: unknown }
		| { readonly _tag: "InfrastructureFailure" }
		| { readonly _tag: "Defect" }
}
export interface Cancellation {
	readonly request: Request
	/** Waits until the request handler has started. */
	readonly started: Request
	/** Waits until the interrupted handler has released its resources. */
	readonly released: Request
}
export interface Session {
	readonly operations: ReadonlyArray<string>
	/** Terminates the unit and waits for independently observed exit. */
	readonly terminate: Effect.Effect<void, ConformanceError>
	readonly call: (
		request: Request,
	) => Effect.Effect<Exit.Exit<unknown, unknown>, ConformanceError>
	readonly roundTrip: (
		request: Request,
		value: unknown,
		part: "payload" | "success" | "error",
	) => Effect.Effect<void, ConformanceError>
	readonly equal: (
		request: Request,
		actual: unknown,
		expected: unknown,
		part: "success" | "error",
	) => Effect.Effect<boolean, ConformanceError>
	readonly probe: (name: string) => Effect.Effect<void, ConformanceError>
}
const error = (message: string, cause?: Cause.Cause<unknown>) =>
	ConformanceError.make({ message, ...(cause === undefined ? {} : { cause }) })
const checked = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
	effect.pipe(Effect.catchCause((cause) => error(message, cause)))
const assert = (
	test: boolean,
	message: string,
	cause?: Cause.Cause<unknown>,
) => (test ? Effect.void : error(message, cause))

/** Uses Remote's JSON codec, including a real JSON serialization boundary. */
export const roundTrip = Effect.fn("Conformance.roundTrip")(
	function* <S extends Schema.Top>(schema: S, value: S["Type"]) {
		const codec = Schema.toCodecJson(schema)
		const encoded = yield* Schema.encodeEffect(codec)(value)
		const wire = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
			encoded,
		)
		const decodedJson = yield* Schema.decodeEffect(
			Schema.fromJsonString(Schema.Json),
		)(wire)
		const decoded = yield* Schema.decodeEffect(codec)(decodedJson)
		yield* assert(
			Schema.toEquivalence(schema)(value, decoded),
			"The portable codec changed the value",
		)
	},
	(effect) => checked(effect, "Portable codec round trip failed"),
)

export type DirectOptions = Pick<
	CandidateOptions,
	"artifact" | "contractModule" | "target" | "input"
>
/** Opens an isolated direct unit; no service is published into a host graph. */
export const direct = Effect.fn("Conformance.direct")(
	function* (contract: Contract.RunnerContract, options: DirectOptions) {
		if (contract.inject.length > 0)
			return yield* error(
				"Direct conformance requires a self-contained fixture; compose injected providers in the fixture package",
			)
		const transports = yield* Layer.build(Layer.merge(localLayer, workerLayer))
		const unit = yield* Unit.open(contract, options).pipe(
			Effect.provideContext(transports),
		)
		const description = yield* unit.describe
		const expected = Array.flatMap(
			contract.provides,
			(service) => service.operations,
		)
		const actual = Array.flatMap(
			description.provides,
			(service) => service.operations,
		)
		yield* assert(
			expected.length === actual.length &&
				Array.every(expected, (op) =>
					Array.some(
						actual,
						(item) => Manifest.operationId(op) === Manifest.operationId(item),
					),
				),
			"The unit declarations disagree with the contract",
		)
		yield* unit.serve(options.input)
		yield* unit.ready
		const methods = yield* Effect.forEach(contract.provides, (service) =>
			Effect.gen(function* () {
				const rpcs = yield* Effect.forEach(
					Array.fromIterable(service.group.requests.values()),
					(item) =>
						Effect.gen(function* () {
							if (
								!Rpc.isRpc(item) ||
								RpcSchema.isStreamSchema(item.successSchema) ||
								item.middlewares.size > 0
							)
								return yield* error(
									"Only unary operations without middleware are supported by direct conformance",
								)
							// Dynamic contract modules erase type parameters. The kit exercises these codecs without
							// external services; an undeclared decoding dependency fails the conformance run.
							return item as Rpc.Rpc<
								string,
								Schema.Codec<unknown>,
								Schema.Codec<unknown>,
								Schema.Codec<unknown>
							>
						}),
				)
				const client = yield* RpcClient.make(RpcGroup.make(...rpcs), {
					flatten: true,
				}).pipe(
					Effect.provideService(
						RpcClient.Protocol,
						unit.clientProtocol(service.key.key),
					),
				)
				return Array.map(rpcs, (rpc) => {
					const schema = (
						part: "payload" | "success" | "error",
					): Schema.Codec<unknown> =>
						part === "payload"
							? rpc.payloadSchema
							: part === "success"
								? rpc.successSchema
								: rpc.errorSchema
					return {
						id: Manifest.operationId(
							identities({ requests: new Map([[rpc._tag, rpc]]) })[0]!,
						),
						call: (
							payload: unknown,
						): Effect.Effect<Exit.Exit<unknown, unknown>, ConformanceError> =>
							// @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Dynamic business errors are captured as Exit data, never exposed in the effect error channel.
							Effect.exit(client(rpc._tag, payload)),
						roundTrip: (
							value: unknown,
							part: "payload" | "success" | "error",
						) => roundTrip(schema(part), value),
						equal: (
							actual: unknown,
							expected: unknown,
							part: "success" | "error",
						) => Schema.toEquivalence(schema(part))(actual, expected),
					}
				})
			}),
		).pipe(Effect.map(Array.flatten))
		const find = (id: string) =>
			Effect.fromOption(
				Array.findFirst(methods, (method) => method.id === id),
				() => error(`Unknown operation: ${id}`),
			)
		return {
			operations: Array.map(methods, (method) => method.id),
			terminate: checked(
				unit.terminate("forced").pipe(Effect.asVoid),
				"Conformance unit termination failed",
			),
			call: (request) =>
				find(request.operation).pipe(
					Effect.flatMap((method) => method.call(request.payload)),
				),
			roundTrip: (request, value, part) =>
				find(request.operation).pipe(
					Effect.flatMap((method) => method.roundTrip(value, part)),
				),
			equal: (request, actual, expected, part) =>
				find(request.operation).pipe(
					Effect.map((method) => method.equal(actual, expected, part)),
				),
			probe: (name) => checked(unit.probe(name), `Probe ${name} failed`),
		} satisfies Session
	},
	(effect) =>
		checked(
			Effect.timeout(effect, "5 seconds"),
			"Direct conformance setup failed",
		),
)

export interface Suite {
	readonly entry: Manifest.Entry
	readonly examples: ReadonlyArray<Example>
	readonly cancellation: Cancellation
	readonly timeout?: Duration.Input
}
/** Runs declared probes and requires cases or handshakes for every implemented operation. */
export const run = Effect.fn("Conformance.run")(
	function* (session: Session, suite: Suite) {
		const parsed = Duration.fromInput(suite.timeout ?? "5 seconds")
		if (Option.isNone(parsed))
			return yield* error("Invalid conformance deadline")
		const duration = parsed.value
		if (!Number.isFinite(Duration.toMillis(duration)))
			return yield* error("Conformance deadlines must be finite")
		const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			checked(
				Effect.timeout(effect, duration),
				"Conformance stage failed or exceeded its deadline",
			)
		const covered = [
			...Array.map(suite.examples, (example) => example.operation),
			suite.cancellation.request.operation,
			suite.cancellation.started.operation,
			suite.cancellation.released.operation,
		]
		for (const operation of suite.entry.services.implements)
			yield* assert(
				covered.includes(operation) && session.operations.includes(operation),
				`Missing conformance case for ${operation}`,
			)
		for (const name of suite.entry.probes) yield* bounded(session.probe(name))
		for (const example of suite.examples) {
			yield* bounded(session.roundTrip(example, example.payload, "payload"))
			const result = yield* bounded(session.call(example))
			if (example.expected._tag === "Success") {
				yield* assert(
					Exit.isSuccess(result),
					`Expected success for ${example.operation}`,
					Exit.isFailure(result) ? result.cause : undefined,
				)
				if (Exit.isSuccess(result)) {
					yield* bounded(session.roundTrip(example, result.value, "success"))
					yield* bounded(
						session.roundTrip(example, example.expected.value, "success"),
					)
					const equal = yield* session.equal(
						example,
						result.value,
						example.expected.value,
						"success",
					)
					yield* assert(
						equal,
						`Unexpected success value for ${example.operation}`,
					)
				}
			} else {
				yield* assert(
					Exit.isFailure(result),
					`Expected failure for ${example.operation}`,
				)
				if (Exit.isFailure(result)) {
					if (example.expected._tag === "Defect") {
						yield* assert(
							Cause.hasDies(result.cause) && !Cause.hasFails(result.cause),
							`Expected a remote defect for ${example.operation}`,
							result.cause,
						)
						continue
					}
					const failures = Array.filter(
						result.cause.reasons,
						Cause.isFailReason,
					)
					yield* assert(
						failures.length === 1 && result.cause.reasons.length === 1,
						`Expected a typed boundary failure for ${example.operation}`,
						result.cause,
					)
					const value = failures[0]?.error
					if (example.expected._tag === "InfrastructureFailure")
						yield* assert(
							Schema.is(RpcClientError.RpcClientError)(value),
							`Expected RpcClientError for ${example.operation}`,
							result.cause,
						)
					else {
						yield* assert(
							!Schema.is(RpcClientError.RpcClientError)(value),
							`Business failure became infrastructure failure for ${example.operation}`,
							result.cause,
						)
						yield* bounded(session.roundTrip(example, value, "error"))
						yield* bounded(
							session.roundTrip(example, example.expected.value, "error"),
						)
						const equal = yield* session.equal(
							example,
							value,
							example.expected.value,
							"error",
						)
						yield* assert(
							equal,
							`Unexpected business error for ${example.operation}`,
						)
					}
				}
			}
		}
		const running = yield* Effect.forkScoped(
			session.call(suite.cancellation.request),
			{ startImmediately: true },
		)
		const started = yield* bounded(session.call(suite.cancellation.started))
		yield* assert(
			Exit.isSuccess(started),
			"The cancellation start handshake failed",
			Exit.isFailure(started) ? started.cause : undefined,
		)
		const completed = running.pollUnsafe()
		const premature =
			completed === undefined || Exit.isFailure(completed)
				? completed
				: completed.value
		yield* assert(
			completed === undefined,
			"The cancellation request completed before interruption",
			premature !== undefined && Exit.isFailure(premature)
				? premature.cause
				: undefined,
		)
		yield* bounded(Fiber.interrupt(running))
		const interrupted = yield* Fiber.await(running)
		const cancellation = Exit.isFailure(interrupted)
			? interrupted
			: interrupted.value
		yield* assert(
			Exit.isFailure(cancellation) &&
				Cause.hasInterruptsOnly(cancellation.cause),
			"The request did not observe interruption",
			Exit.isFailure(cancellation) ? cancellation.cause : undefined,
		)
		const released = yield* bounded(session.call(suite.cancellation.released))
		yield* assert(
			Exit.isSuccess(released),
			"The cancelled request did not release its resources",
			Exit.isFailure(released) ? released.cause : undefined,
		)
		yield* bounded(session.terminate)
		const unavailable = yield* bounded(session.call(suite.cancellation.started))
		yield* assert(
			Exit.isFailure(unavailable) &&
				unavailable.cause.reasons.length === 1 &&
				Array.every(
					unavailable.cause.reasons,
					(reason) =>
						Cause.isFailReason(reason) &&
						Schema.is(RpcClientError.RpcClientError)(reason.error),
				),
			"A call after termination must fail with RpcClientError",
			Exit.isFailure(unavailable) ? unavailable.cause : undefined,
		)
	},
	(effect) => checked(effect, "Plugin conformance failed"),
)

/** Verifies published metadata before activating the author's test fixture. */
export const agreement = Publication.verify
