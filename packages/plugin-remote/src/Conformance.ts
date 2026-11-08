/** Public checks shared by first-party and independently published plugins. */
import {
	Array,
	Cause,
	Duration,
	Effect,
	Exit,
	Fiber,
	Option,
	Schema,
} from "effect"
import { RpcClientError } from "effect/rpc"

import { Manifest } from "@graftland/graft"

import * as Publication from "./Publication"
import { ConformanceError } from "./Testing"

export { ConformanceError } from "./Testing"
/** An operation is addressed within its Context service binding. */
export interface Operation {
	readonly service: string
	readonly operation: string
}
export interface Request extends Operation {
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
	readonly operations: ReadonlyArray<Operation>
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

const sameOperation = (left: Operation, right: Operation) =>
	left.service === right.service && left.operation === right.operation
const label = (operation: Operation) =>
	`service ${operation.service}, operation ${operation.operation}`
const operations = (
	services: ReadonlyArray<Manifest.Service>,
): ReadonlyArray<Operation> =>
	Array.flatMap(services, (service) =>
		Array.map(service.operations, (operation) => ({
			service: service.key,
			operation,
		})),
	)
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

export interface Suite {
	readonly entry: Manifest.EntryMetadata
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
		const bounded = <A, E, R>(
			effect: Effect.Effect<A, E, R>,
			stage = "Conformance stage",
		) =>
			checked(
				Effect.timeout(effect, duration),
				`${stage} failed or exceeded its deadline`,
			)
		const covered: ReadonlyArray<Operation> = [
			...suite.examples,
			suite.cancellation.request,
			suite.cancellation.started,
			suite.cancellation.released,
		]
		const declared = operations(suite.entry.services.implements)
		for (const operation of declared) {
			yield* assert(
				Array.some(covered, (other) => sameOperation(operation, other)),
				`Missing conformance case for ${label(operation)}`,
			)
			yield* assert(
				Array.some(session.operations, (other) =>
					sameOperation(operation, other),
				),
				`Session does not provide ${label(operation)}`,
			)
		}
		for (const operation of session.operations)
			yield* assert(
				Array.some(declared, (other) => sameOperation(operation, other)),
				`Session provides undeclared ${label(operation)}`,
			)
		for (const operation of covered)
			yield* assert(
				Array.some(declared, (other) => sameOperation(operation, other)),
				`Conformance case addresses undeclared ${label(operation)}`,
			)

		for (const name of suite.entry.probes) yield* bounded(session.probe(name))
		for (const example of suite.examples) {
			yield* bounded(
				session.roundTrip(example, example.payload, "payload"),
				`Payload round trip for ${label(example)}`,
			)
			const result = yield* bounded(
				session.call(example),
				`Call for ${label(example)}`,
			)
			if (example.expected._tag === "Success") {
				yield* assert(
					Exit.isSuccess(result),
					`Expected success for ${label(example)}`,
					Exit.isFailure(result) ? result.cause : undefined,
				)
				if (Exit.isSuccess(result)) {
					yield* bounded(
						session.roundTrip(example, result.value, "success"),
						`Success round trip for ${label(example)}`,
					)
					yield* bounded(
						session.roundTrip(example, example.expected.value, "success"),
						`Expected success round trip for ${label(example)}`,
					)
					const equal = yield* bounded(
						session.equal(
							example,
							result.value,
							example.expected.value,
							"success",
						),
						`Success comparison for ${label(example)}`,
					)
					yield* assert(equal, `Unexpected success value for ${label(example)}`)
				}
			} else {
				yield* assert(
					Exit.isFailure(result),
					`Expected failure for ${label(example)}`,
				)
				if (Exit.isFailure(result)) {
					if (example.expected._tag === "Defect") {
						yield* assert(
							Cause.hasDies(result.cause) && !Cause.hasFails(result.cause),
							`Expected a remote defect for ${label(example)}`,
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
						`Expected a typed boundary failure for ${label(example)}`,
						result.cause,
					)
					const value = failures[0]?.error
					if (example.expected._tag === "InfrastructureFailure")
						yield* assert(
							Schema.is(RpcClientError.RpcClientError)(value),
							`Expected RpcClientError for ${label(example)}`,
							result.cause,
						)
					else {
						yield* assert(
							!Schema.is(RpcClientError.RpcClientError)(value),
							`Business failure became infrastructure failure for ${label(example)}`,
							result.cause,
						)
						yield* bounded(
							session.roundTrip(example, value, "error"),
							`Business-error round trip for ${label(example)}`,
						)
						yield* bounded(
							session.roundTrip(example, example.expected.value, "error"),
							`Expected business-error round trip for ${label(example)}`,
						)
						const equal = yield* bounded(
							session.equal(example, value, example.expected.value, "error"),
							`Business-error comparison for ${label(example)}`,
						)
						yield* assert(
							equal,
							`Unexpected business error for ${label(example)}`,
						)
					}
				}
			}
		}
		const running = yield* Effect.forkScoped(
			session.call(suite.cancellation.request),
			{ startImmediately: true },
		)
		const started = yield* bounded(
			session.call(suite.cancellation.started),
			`Cancellation started call for ${label(suite.cancellation.started)}`,
		)
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
		const released = yield* bounded(
			session.call(suite.cancellation.released),
			`Cancellation released call for ${label(suite.cancellation.released)}`,
		)
		yield* assert(
			Exit.isSuccess(released),
			"The cancelled request did not release its resources",
			Exit.isFailure(released) ? released.cause : undefined,
		)
		yield* bounded(session.terminate)
		const unavailable = yield* bounded(
			session.call(suite.cancellation.started),
			`Cancellation started call for ${label(suite.cancellation.started)}`,
		)
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
