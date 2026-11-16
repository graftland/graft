import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Stream,
	type Scope,
} from "effect"
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcServer } from "effect/rpc"
import { TestClock } from "effect/testing"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { Remote } from "../src/rpc/index.ts"
import * as Testing from "../src/testing/index.ts"
import { reach } from "./utils.ts"

/** Runs a test with a scope, which protocols and graphs need. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
	effect.pipe(Effect.scoped)

/**
 * Advances virtual time in 1ms steps, yielding between steps so the retry
 * sleep is registered before the next adjustment wakes it.
 */
const advanceRetry = Effect.repeat(
	Effect.andThen(Effect.yieldNow, TestClock.adjust("1 millis")),
	Schedule.recurs(9),
)

/* In-memory protocol */

const Add = Rpc.make("Add", {
	payload: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
	success: Schema.Finite,
})

const Fail = Rpc.make("Fail", {
	error: Schema.String,
})

const Count = Rpc.make("Count", {
	success: Schema.Finite,
	stream: true,
})

const Slow = Rpc.make("Slow", {
	success: Schema.Finite,
})

const Calculator = RpcGroup.make(Add, Fail, Count, Slow)

type CalculatorRpcs = RpcGroup.Rpcs<typeof Calculator>

const connectCalculator = (
	protocol: Testing.InMemoryProtocol,
): Effect.Effect<
	RpcClient.RpcClient<CalculatorRpcs, RpcClientError.RpcClientError>,
	never,
	Scope.Scope
> =>
	Effect.gen(function* () {
		const connection = yield* protocol.client
		return yield* RpcClient.make(Calculator).pipe(
			Effect.provideService(RpcClient.Protocol, connection),
		)
	})

const calculatorHandlers = (slow: () => Effect.Effect<number, never>) =>
	Calculator.toLayer({
		Add: ({ a, b }) => Effect.succeed(a + b),
		Fail: () => Effect.fail("boom"),
		Count: () => Stream.make(1, 2, 3),
		Slow: slow,
	})

describe("in-memory protocol", () => {
	it.effect("round-trips calls, declared errors, and streams", () =>
		run(
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* RpcServer.make(Calculator).pipe(
					Effect.provide([
						calculatorHandlers(() => Effect.succeed(0)),
						protocol.server,
					]),
					Effect.forkScoped,
				)
				const client = yield* connectCalculator(protocol)
				const sum = yield* client.Add({ a: 1, b: 2 })
				assert.strictEqual(sum, 3)
				const failed = yield* Effect.exit(client.Fail())
				assert.isTrue(Exit.isFailure(failed))
				if (Exit.isFailure(failed))
					assert.strictEqual(
						Option.getOrThrow(Cause.findErrorOption(failed.cause)),
						"boom",
					)
				const counted = yield* Stream.runCollect(client.Count())
				assert.deepStrictEqual(Array.fromIterable(counted), [1, 2, 3])
			}),
		),
	)

	it.effect(
		"disconnect fails in-flight calls and lets a new connection in",
		() =>
			run(
				Effect.gen(function* () {
					const protocol = yield* Testing.make
					const started = yield* Deferred.make<void>()
					const gate = yield* Deferred.make<void>()
					yield* RpcServer.make(Calculator).pipe(
						Effect.provide([
							calculatorHandlers(() =>
								Effect.andThen(
									Deferred.succeed(started, undefined),
									Effect.andThen(Deferred.await(gate), Effect.succeed(1)),
								),
							),
							protocol.server,
						]),
						Effect.forkScoped,
					)
					const client = yield* connectCalculator(protocol)
					const call = yield* Effect.forkScoped(client.Slow())
					yield* Deferred.await(started)
					yield* protocol.disconnect
					const exit = yield* Fiber.await(call)
					assert.isTrue(Exit.isFailure(exit))
					if (Exit.isFailure(exit)) {
						const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
						assert.isTrue(Schema.is(RpcClientError.RpcClientError)(error))
						assert.include(error.message, "connection was closed")
					}
					const reconnected = yield* connectCalculator(protocol)
					const sum = yield* reconnected.Add({ a: 2, b: 3 })
					assert.strictEqual(sum, 5)
				}),
			),
	)
})

/* Remote services */

class QuoteError extends Schema.TaggedError<
	QuoteError,
	{ readonly brand: unique symbol }
>()("QuoteError", {
	sku: Schema.String,
}) {
	override get message(): string {
		return `Unknown SKU "${this.sku}"`
	}
}

const Quote = Rpc.make("Quote", {
	payload: Schema.Struct({ sku: Schema.String }),
	success: Schema.Finite,
	error: QuoteError,
})

const Block = Rpc.make("Block", {
	success: Schema.Finite,
})

const PricingRpcs = RpcGroup.make(Quote, Block)

interface PricingShape {
	readonly quote: (
		sku: string,
	) => Effect.Effect<
		number,
		QuoteError | Remote.RemoteUnavailable | RpcClientError.RpcClientError
	>
	readonly block: Effect.Effect<
		number,
		Remote.RemoteUnavailable | RpcClientError.RpcClientError
	>
}

class Pricing extends Context.Service<Pricing, PricingShape>()(
	"@graftland/graft/test/rpc.test/Pricing",
) {}

class Downstream extends Context.Service<Downstream, string>()(
	"@graftland/graft/test/rpc.test/Downstream",
) {}

/**
 * `ServerService` strips the transport errors from the shape, so the handlers
 * only carry the RPC's declared error.
 */
const PricingRemote = Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({
		Quote: ({ sku }: { readonly sku: string }) => pricing.quote(sku),
		Block: () => pricing.block,
	}),
	fromClient: (client) => ({
		quote: (sku) => client.Quote({ sku }),
		block: client.Block(),
	}),
})

const pricingOf = (
	quote: PricingShape["quote"],
	block: PricingShape["block"] = Effect.succeed(0),
): PricingShape => ({ quote, block })

/** Two independent Graft runtimes sharing one in-memory protocol pair. */
const world = Effect.gen(function* () {
	const protocol = yield* Testing.make
	const server = yield* Layer.build(Graft.layer)
	const client = yield* Layer.build(Graft.layer)
	const serve = () =>
		Remote.serve({
			services: [PricingRemote],
			protocol: protocol.server,
		}).pipe(Effect.provideContext(server))
	const connect = (retry?: Schedule.Schedule<unknown, unknown>) =>
		Remote.connect({
			services: [PricingRemote],
			protocol: protocol.client,
			retry,
		}).pipe(Effect.provideContext(client))
	return { protocol, server, client, serve, connect }
})

describe("remote services", () => {
	it.effect("round-trips calls and declared errors across two runtimes", () =>
		run(
			Effect.gen(function* () {
				const { server, client, serve, connect } = yield* world
				yield* Graft.publish(
					Pricing,
					pricingOf((sku) =>
						sku === "known"
							? Effect.succeed(10)
							: Effect.fail(QuoteError.make({ sku })),
					),
				).pipe(Effect.provideContext(server))
				yield* serve()
				yield* connect()
				const pricing = yield* Graft.await(Pricing).pipe(
					Effect.provideContext(client),
				)
				const price = yield* pricing.quote("known")
				assert.strictEqual(price, 10)
				const failed = yield* Effect.exit(pricing.quote("missing"))
				assert.isTrue(Exit.isFailure(failed))
				if (Exit.isFailure(failed)) {
					const error = Option.getOrThrow(Cause.findErrorOption(failed.cause))
					assert.isTrue(Schema.is(QuoteError)(error))
					if (Schema.is(QuoteError)(error))
						assert.strictEqual(error.sku, "missing")
				}
			}),
		),
	)

	it.effect(
		"withdraws a remote service and stops the mounts requiring it",
		() =>
			run(
				Effect.gen(function* () {
					const { server, client, serve, connect } = yield* world
					const published = yield* Graft.publish(
						Pricing,
						pricingOf(() => Effect.succeed(10)),
					).pipe(Effect.provideContext(server))
					yield* serve()
					yield* connect()
					yield* Graft.await(Pricing).pipe(Effect.provideContext(client))

					const releases = yield* Ref.make(0)
					const downstream = yield* Graft.mount(
						Layer.effect(
							Downstream,
							Effect.acquireRelease(Effect.succeed("downstream"), () =>
								Ref.update(releases, (n) => n + 1),
							),
						),
						{ requires: [Pricing], name: "downstream" },
					).pipe(Effect.provideContext(client))
					yield* reach(downstream, "Active")

					const seen = yield* Ref.make<ReadonlyArray<boolean>>([])
					const watched = yield* Effect.forkScoped(
						Graft.watch(Pricing).pipe(
							Stream.map(Option.isSome),
							Stream.tap((available) =>
								Ref.update(seen, Array.append(available)),
							),
							Stream.changes,
							Stream.take(2),
							Stream.runCollect,
							Effect.provideContext(client),
						),
					)
					yield* Effect.yieldNow
					yield* published.unmount.pipe(Effect.provideContext(server))
					yield* Fiber.join(watched)

					const availability = yield* Ref.get(seen)
					assert.deepStrictEqual(availability, [true, false])
					yield* reach(downstream, "Pending")
					const releaseCount = yield* Ref.get(releases)
					assert.strictEqual(releaseCount, 1)
				}),
			),
	)

	it.effect(
		"interrupts an in-flight call and releases the handler when its service is withdrawn",
		() =>
			run(
				Effect.gen(function* () {
					const { server, client, serve, connect } = yield* world
					const started = yield* Deferred.make<void>()
					const gate = yield* Deferred.make<void>()
					const releases = yield* Ref.make(0)
					const published = yield* Graft.publish(
						Pricing,
						pricingOf(
							() => Effect.succeed(10),
							Effect.scoped(
								Effect.acquireRelease(Effect.succeed(1), () =>
									Ref.update(releases, (n) => n + 1),
								).pipe(
									Effect.andThen(Deferred.succeed(started, undefined)),
									Effect.andThen(Deferred.await(gate)),
									Effect.as(7),
								),
							),
						),
					).pipe(Effect.provideContext(server))
					yield* serve()
					yield* connect()
					const pricing = yield* Graft.await(Pricing).pipe(
						Effect.provideContext(client),
					)
					const call = yield* Effect.forkScoped(pricing.block)
					yield* Deferred.await(started)
					const withdrawn = yield* Effect.forkScoped(
						Graft.watch(Pricing).pipe(
							Stream.filter(Option.isNone),
							Stream.runHead,
							Effect.provideContext(client),
						),
					)
					yield* Effect.yieldNow
					yield* published.unmount.pipe(Effect.provideContext(server))
					yield* Fiber.join(withdrawn)

					// Withdrawing the service stops its lease, so the server interrupts
					// the handler instead of leaving the call running.
					const exit = yield* Fiber.await(call)
					assert.isTrue(Exit.isFailure(exit))
					if (Exit.isFailure(exit)) {
						const pretty = Cause.pretty(exit.cause)
						assert.include(pretty, "ServiceWithdrawn")
						assert.include(pretty, "was withdrawn while in use")
						// The lease interruption reaches the caller as a defect.
						assert.isTrue(
							Array.every(
								exit.cause.reasons,
								(reason) => reason._tag === "Die",
							),
						)
					}
					const releaseCount = yield* Ref.get(releases)
					assert.strictEqual(releaseCount, 1)
				}),
			),
	)

	it.effect(
		"fails in-flight calls with RemoteUnavailable on disconnect, releases server resources, and reconnects",
		() =>
			run(
				Effect.gen(function* () {
					const { protocol, server, client, serve, connect } = yield* world
					const started = yield* Deferred.make<void>()
					const gate = yield* Deferred.make<void>()
					const released = yield* Deferred.make<void>()
					yield* Graft.publish(
						Pricing,
						pricingOf(
							() => Effect.succeed(10),
							Effect.scoped(
								Effect.acquireRelease(Effect.succeed(1), () =>
									Effect.asVoid(Deferred.succeed(released, undefined)),
								).pipe(
									Effect.andThen(Deferred.succeed(started, undefined)),
									Effect.andThen(Deferred.await(gate)),
									Effect.as(7),
								),
							),
						),
					).pipe(Effect.provideContext(server))
					yield* serve()
					yield* connect(Schedule.recurs(10))
					const pricing = yield* Graft.await(Pricing).pipe(
						Effect.provideContext(client),
					)
					const call = yield* Effect.forkScoped(pricing.block)
					yield* Deferred.await(started)
					yield* protocol.disconnect
					const exit = yield* Fiber.await(call)
					assert.isTrue(Exit.isFailure(exit))
					if (Exit.isFailure(exit)) {
						const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
						assert.isTrue(Schema.is(Remote.RemoteUnavailable)(error))
						if (Schema.is(Remote.RemoteUnavailable)(error)) {
							// The disconnect cause travels with the error, not swallowed.
							assert.isDefined(error.cause)
							if (error.cause !== undefined)
								assert.include(
									Cause.pretty(error.cause),
									"The in-memory connection was closed",
								)
						}
					}
					// The server interrupts the blocked handler, which releases its resource.
					yield* Deferred.await(released)
					// The mount reconnects through its retry schedule; the schedule
					// asks for no delay, so each retry needs one virtual millisecond.
					yield* advanceRetry
					// Reconnection publishes a fresh service value; wait for it rather than
					// reusing the withdrawn one.
					const again = yield* Graft.watch(Pricing).pipe(
						Stream.filter(Option.isSome),
						Stream.map((value) => Option.getOrThrow(value)),
						Stream.filter((value) => value !== pricing),
						Stream.runHead,
						Effect.map(Option.getOrThrow),
						Effect.provideContext(client),
					)
					const price = yield* again.quote("known")
					assert.strictEqual(price, 10)
				}),
			),
	)

	it.effect(
		"puts the mount in Failed with the cause of a failing internal fiber",
		() =>
			run(
				Effect.gen(function* () {
					const { client } = yield* world
					const mount = yield* Remote.connect({
						services: [PricingRemote],
						protocol: Effect.die(new Error("transport exploded")),
					}).pipe(Effect.provideContext(client))
					yield* reach(mount, "Failed")
					const failed = yield* Effect.exit(mount.await)
					assert.isTrue(Exit.isFailure(failed))
					if (Exit.isFailure(failed))
						assert.include(Cause.pretty(failed.cause), "transport exploded")
				}),
			),
	)
})
