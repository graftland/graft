import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Equal,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"
import { assert, describe, it } from "@effect/vitest"

import { Graft, Mount } from "../src/index.ts"
import { Remote } from "../src/rpc/index.ts"
import * as Testing from "../src/testing/index.ts"

class Counter extends Context.Service<
	Counter,
	{
		readonly inc: (n: number) => Effect.Effect<number, Remote.RemoteClientError>
		readonly wait: Effect.Effect<number, Remote.RemoteClientError>
		readonly watch: Stream.Stream<number, Remote.RemoteClientError>
		readonly fail: Effect.Effect<never, string | Remote.RemoteClientError>
		readonly streamFail: Stream.Stream<
			number,
			string | Remote.RemoteClientError
		>
	}
>()("@graftland/graft/test/rpc-mount.test/Counter") {}

class Marker extends Context.Service<Marker, string>()(
	"@graftland/graft/test/rpc-mount.test/Marker",
) {}

const CounterRpcs = RpcGroup.make(
	Rpc.make("Inc", {
		payload: { n: Schema.Finite },
		success: Schema.Finite,
	}),
	Rpc.make("Wait", { payload: {}, success: Schema.Finite }),
	Rpc.make("Watch", { payload: {}, success: Schema.Finite, stream: true }),
	Rpc.make("Fail", {
		payload: {},
		success: Schema.Never,
		error: Schema.String,
	}),
	Rpc.make("StreamFail", {
		payload: {},
		success: Schema.Finite,
		error: Schema.String,
		stream: true,
	}),
)

const CounterRemote = Remote.service(Counter, CounterRpcs, {
	toHandlers: (counter) => ({
		Inc: ({ n }: { readonly n: number }) => counter.inc(n),
		Wait: () => counter.wait,
		Watch: () => counter.watch,
		Fail: () => counter.fail,
		StreamFail: () => counter.streamFail,
	}),
	fromClient: (client) => ({
		inc: (n: number) => client.Inc({ n }),
		wait: client.Wait({}),
		watch: client.Watch({}),
		fail: client.Fail({}),
		streamFail: client.StreamFail({}),
	}),
})

/** The generated client exposes `RemoteUnavailable` for effect and stream RPCs. */
const typeCheckClient = (
	client: RpcClient.RpcClient<
		RpcGroup.Rpcs<typeof CounterRpcs>,
		Remote.RemoteClientError
	>,
) => ({
	effect: client
		.Inc({ n: 1 })
		.pipe(Effect.catchTag("RemoteUnavailable", () => Effect.succeed(0))),
	stream: client
		.Watch({})
		.pipe(Stream.catchTag("RemoteUnavailable", () => Stream.empty)),
})
void typeCheckClient

/** Native socket Protocol layer must be accepted with its requirements. */
const servedWithSocket = Remote.serve({
	services: [CounterRemote],
	protocol: RpcServer.layerProtocolSocketServer,
})
void servedWithSocket

class ProtocolFailure extends Schema.TaggedError<
	ProtocolFailure,
	{ readonly brand: unique symbol }
>()("ProtocolFailure", {}) {
	override get message() {
		return "The protocol could not be opened"
	}
}

const counterValue = Effect.gen(function* () {
	const count = yield* Ref.make(0)
	return {
		inc: (n: number) => Ref.updateAndGet(count, (current) => current + n),
		wait: Effect.never,
		watch: Stream.concat(Stream.make(1), Stream.never),
		fail: Effect.fail("boom"),
		streamFail: Stream.concat(Stream.make(1), Stream.fail("stream boom")),
	}
})

const serverLayer = Layer.fresh(Graft.layer)

/** Runs a server program in its own graph until the test scope closes. */
const startServer = (
	protocol: Testing.InMemoryProtocol,
	stopPublishing: Option.Option<Deferred.Deferred<void>>,
) =>
	Effect.gen(function* () {
		const value = yield* counterValue
		const published = yield* Scope.make()
		yield* Effect.addFinalizer(() => Scope.close(published, Exit.void))
		yield* Scope.provide(Graft.publish(Counter, value), published)
		if (Option.isSome(stopPublishing))
			yield* Effect.forkScoped(
				Effect.andThen(
					Deferred.await(stopPublishing.value),
					Scope.close(published, Exit.void),
				),
			)
		const mount = yield* Remote.serve({
			services: [CounterRemote],
			protocol: protocol.server,
		})
		yield* mount.await
		return yield* Effect.never
	}).pipe(Effect.scoped, Effect.provide(serverLayer), Effect.forkScoped)

const treeIds = (tree: ReadonlyArray<Mount.MountTree>): Array<number> =>
	Array.flatMap(tree, (node) => [node.id, ...treeIds(node.children)])

const awaitTree = (id: number) =>
	Graft.mounts.pipe(
		Stream.filter((tree) => treeIds(tree).includes(id)),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.die(new Error(`Mount ${id} never appeared`)),
				onSome: () => Effect.void,
			}),
		),
	)

const currentTree = () =>
	Graft.mounts.pipe(
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.succeed([] as ReadonlyArray<Mount.MountTree>),
				onSome: (tree) => Effect.succeed(tree),
			}),
		),
	)

const sameCause = (left: Cause.Cause<unknown>, right: Cause.Cause<unknown>) =>
	left.reasons.length === right.reasons.length &&
	Array.every(left.reasons, (reason, index) =>
		Equal.equals(reason._tag, right.reasons[index]?._tag),
	) &&
	Equal.equals(Cause.findErrorOption(left), Cause.findErrorOption(right))

const awaitingFailed = (mount: {
	readonly state: Stream.Stream<Mount.MountState>
}) =>
	mount.state.pipe(
		Stream.filter((state) => state._tag === "Failed"),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.die(new Error("Mount never failed")),
				onSome: (state) => Effect.succeed(state.cause),
			}),
		),
	)

const clientGraph = <A, E>(
	effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>,
) => Effect.provide(effect, Layer.fresh(Graft.layer))

describe("remote mounts", () => {
	it.live(
		"serve and connect are mounts in the graph with their own ids",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				const served = yield* clientGraph(
					Effect.gen(function* () {
						const value = yield* counterValue
						yield* Graft.publish(Counter, value)
						const served = yield* Remote.serve({
							services: [CounterRemote],
							protocol: protocol.server,
						})
						const plain = yield* Graft.mount(Layer.succeed(Marker, "plain"))
						yield* awaitTree(served.id)
						yield* awaitTree(plain.id)
						assert.notStrictEqual(served.id, plain.id)
						return served
					}),
				)
				assert.isNumber(served.id)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"connect is a mount with its own id",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* startServer(protocol, Option.none())
				const mount = yield* clientGraph(
					Effect.gen(function* () {
						const mount = yield* Remote.connect({
							services: [CounterRemote],
							protocol: protocol.client,
						})
						const plain = yield* Graft.mount(Layer.succeed(Marker, "plain"))
						yield* awaitTree(mount.id)
						yield* awaitTree(plain.id)
						assert.notStrictEqual(mount.id, plain.id)
						return mount
					}),
				)
				assert.isNumber(mount.id)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"a protocol construction failure reaches Failed unchanged",
		() =>
			clientGraph(
				Effect.gen(function* () {
					const failure = ProtocolFailure.make({})
					const mount = yield* Remote.connect({
						services: [CounterRemote],
						protocol: Effect.fail(failure),
					})
					const cause = yield* awaitingFailed(mount)
					assert.isTrue(
						sameCause(cause, Cause.fail(failure)),
						`actual=${String(cause.reasons)}`,
					)
				}),
			).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"a presence failure reaches Failed and carries its cause",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* startServer(protocol, Option.none())
				yield* clientGraph(
					Effect.gen(function* () {
						const mount = yield* Remote.connect({
							services: [CounterRemote],
							protocol: protocol.client,
						})
						yield* Graft.await(Counter)
						yield* protocol.disconnect
						const cause = yield* awaitingFailed(mount)
						assert.isTrue(Option.isSome(Cause.findErrorOption(cause)))
					}),
				)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"closing the scope removes the mount and withdraws its services",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* startServer(protocol, Option.none())
				yield* clientGraph(
					Effect.gen(function* () {
						const id = yield* Effect.scoped(
							Effect.gen(function* () {
								const mount = yield* Remote.connect({
									services: [CounterRemote],
									protocol: protocol.client,
								})
								yield* Graft.await(Counter)
								return mount.id
							}),
						)
						const tree = yield* currentTree()
						assert.notInclude(treeIds(tree), id)
						const withdrawn = yield* Graft.watch(Counter).pipe(
							Stream.filter(Option.isNone),
							Stream.runHead,
						)
						assert.isTrue(Option.isSome(withdrawn))
					}),
				)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"retry reconnects and recovers the remote service",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* startServer(protocol, Option.none())
				yield* clientGraph(
					Effect.gen(function* () {
						yield* Remote.connect({
							services: [CounterRemote],
							protocol: protocol.client,
							retry: Schedule.spaced("10 millis"),
						})
						const before = yield* Graft.await(Counter)
						yield* protocol.disconnect
						const after = yield* Graft.watch(Counter).pipe(
							Stream.filter(Option.isSome),
							Stream.map((value) => Option.getOrThrow(value)),
							Stream.filter((value) => value !== before),
							Stream.runHead,
							Effect.map(Option.getOrThrow),
							Effect.timeout("4 seconds"),
						)
						const result = yield* after.inc(7)
						assert.strictEqual(result, 7)
					}),
				)
			}).pipe(Effect.timeout("10 seconds")),
		20_000,
	)

	it.live(
		"the client withdraws a service the server stops providing",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				const stop = yield* Deferred.make<void>()
				yield* startServer(protocol, Option.some(stop))
				yield* clientGraph(
					Effect.gen(function* () {
						yield* Remote.connect({
							services: [CounterRemote],
							protocol: protocol.client,
						})
						const counter = yield* Graft.await(Counter)
						const result = yield* counter.inc(1).pipe(Effect.orDie)
						assert.strictEqual(result, 1)
						yield* Deferred.succeed(stop, void 0)
						const withdrawn = yield* Graft.watch(Counter).pipe(
							Stream.filter(Option.isNone),
							Stream.runHead,
						)
						assert.isTrue(Option.isSome(withdrawn))
					}),
				)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"a disconnect fails in-flight effect calls with RemoteUnavailable",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* startServer(protocol, Option.none())
				yield* clientGraph(
					Effect.gen(function* () {
						yield* Remote.connect({
							services: [CounterRemote],
							protocol: protocol.client,
						})
						const counter = yield* Graft.await(Counter)
						const fiber = yield* Effect.forkChild(Effect.exit(counter.wait))
						yield* Effect.sleep("20 millis")
						yield* protocol.disconnect
						const exit = yield* Fiber.join(fiber)
						if (!Exit.isFailure(exit))
							return assert.fail(`expected failure, got ${String(exit)}`)
						const error = Cause.findErrorOption(exit.cause)
						assert.isTrue(Option.isSome(error))
						if (Option.isSome(error))
							assert.isTrue(Schema.is(Remote.RemoteUnavailable)(error.value))
					}),
				)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"a disconnect fails in-flight stream calls with RemoteUnavailable",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* startServer(protocol, Option.none())
				yield* clientGraph(
					Effect.gen(function* () {
						yield* Remote.connect({
							services: [CounterRemote],
							protocol: protocol.client,
						})
						const counter = yield* Graft.await(Counter)
						const fiber = yield* Effect.forkChild(
							Effect.exit(Stream.runCollect(counter.watch)),
						)
						yield* Effect.sleep("20 millis")
						yield* protocol.disconnect
						const exit = yield* Fiber.join(fiber)
						if (!Exit.isFailure(exit))
							return assert.fail(`expected failure, got ${String(exit)}`)
						const error = Cause.findErrorOption(exit.cause)
						assert.isTrue(Option.isSome(error))
						if (Option.isSome(error))
							assert.isTrue(Schema.is(Remote.RemoteUnavailable)(error.value))
					}),
				)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)

	it.live(
		"declared errors travel as Fail for effect and stream RPCs",
		() =>
			Effect.gen(function* () {
				const protocol = yield* Testing.make
				yield* startServer(protocol, Option.none())
				yield* clientGraph(
					Effect.gen(function* () {
						yield* Remote.connect({
							services: [CounterRemote],
							protocol: protocol.client,
						})
						const counter = yield* Graft.await(Counter)
						const effectExit = yield* Effect.exit(counter.fail)
						if (!Exit.isFailure(effectExit))
							return assert.fail("expected the effect RPC to fail")
						const effectError = Cause.findErrorOption(effectExit.cause)
						assert.isTrue(Option.isSome(effectError))
						if (Option.isSome(effectError))
							assert.strictEqual(effectError.value, "boom")

						const seen = yield* Ref.make<ReadonlyArray<number>>([])
						const streamExit = yield* Effect.exit(
							counter.streamFail.pipe(
								Stream.tap((value) => Ref.update(seen, Array.append(value))),
								Stream.runDrain,
							),
						)
						if (!Exit.isFailure(streamExit))
							return assert.fail("expected the stream RPC to fail")
						const streamError = Cause.findErrorOption(streamExit.cause)
						assert.isTrue(Option.isSome(streamError))
						if (Option.isSome(streamError))
							assert.strictEqual(streamError.value, "stream boom")
						const messages = yield* Ref.get(seen)
						assert.deepStrictEqual(messages, [1])
					}),
				)
			}).pipe(Effect.timeout("5 seconds")),
		20_000,
	)
})
