import {
	Array,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Logger,
	Option,
	Queue,
	Ref,
	References,
	Result,
	Schema,
	Scope,
	String,
} from "effect"
import { Rpc, RpcMiddleware } from "effect/rpc"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"
import { Contract } from "@graftland/plugin-remote"
import * as Policy from "@graftland/plugin-remote/Policy"

import core from "../src/index.ts"
import { Middleware as CallMiddleware } from "../src/Middleware.ts"
import * as Projection from "../src/Projection.ts"
import { transport } from "./support.ts"

class Local extends Context.Service<
	Local,
	{
		readonly read: (input: {
			readonly city: string
		}) => Effect.Effect<
			string,
			| string
			| Policy.Unapproved
			| { readonly _tag: string; readonly secret: string }
		>
	}
>()("@graftland/plugin-mcp-server/test/contract-projection.test/Local") {}

const metadata: Projection.Metadata = {
	name: "forecast",
	title: "Forecast",
	description: "Read the forecast",
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	output: "json",
}
const rpc = Contract.operation(
	"forecast/read",
	1,
	Rpc.make("Read", {
		payload: { city: Schema.String },
		success: Schema.String,
		error: Schema.String,
	}),
)
const binding = (description = metadata.description) =>
	Projection.operation(
		Local,
		rpc.annotate(Projection.Annotation, { ...metadata, description }),
		(service, input) => service.read(input),
	)
const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

const start = Effect.fnUntraced(function* (
	read: Local["Service"]["read"] = ({ city }) => Effect.succeed(city),
	bindings: ReadonlyArray<Projection.Binding<Local>> = [binding()],
) {
	yield* Graft.provide(Local, { read })
	const ready = yield* Deferred.make<Projection.Controller<Local>>()
	const contributor = yield* Graft.plugin(
		Plugin.make({
			name: "forecast-tools",
			inject: [Local],
			apply: () =>
				Effect.gen(function* () {
					const controller = yield* Projection.offer(bindings)
					yield* Deferred.succeed(ready, controller)
				}),
		}),
	)
	yield* contributor.await
	yield* (yield* Graft.plugin(core, {})).await
	const adapter = yield* transport({ protocolVersion: "2025-11-25" })
	yield* (yield* Graft.plugin(adapter.plugin)).await
	return {
		client: yield* adapter.client,
		controller: yield* Deferred.await(ready),
		contributor,
	}
})

it.effect(
	"projects an annotated local operation with explicit hints and portable output",
	() =>
		run(
			Effect.gen(function* () {
				const { client } = yield* start()
				const tool = (yield* client.listTools()).tools[0]!
				assert.equal(tool.name, "forecast")
				assert.equal(tool.description, metadata.description)
				assert.deepStrictEqual(tool.annotations, {
					title: "Forecast",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				})
				assert.equal(tool.inputSchema["type"], "object")
				const reply = yield* client.callTool({
					name: "forecast",
					arguments: { city: "London" },
				})
				assert.deepStrictEqual(reply.structuredContent, { value: "London" })
				const invalid = yield* Effect.result(
					client.callTool({ name: "forecast", arguments: { city: 1 } }),
				)
				assert.isTrue(Result.isSuccess(invalid) && invalid.success.isError)
			}),
		),
)

class Middleware extends RpcMiddleware.Service<Middleware>()(
	"test/projection/Middleware",
) {}
const cases = [
	[
		"missing identity",
		Rpc.make("Read", {
			payload: { city: Schema.String },
			success: Schema.String,
		}).annotate(Projection.Annotation, metadata),
		"identity",
	],
	["missing annotations", rpc, "Declare the tool"],
	[
		"streaming",
		Contract.operation(
			"forecast/read",
			1,
			Rpc.make("Read", {
				payload: { city: Schema.String },
				success: Schema.String,
				stream: true,
			}),
		).annotate(Projection.Annotation, metadata),
		"Streaming",
	],
	[
		"middleware",
		rpc.middleware(Middleware).annotate(Projection.Annotation, metadata),
		"middleware",
	],
	[
		"opaque payload",
		Contract.operation(
			"forecast/read",
			1,
			Rpc.make("Read", {
				payload: {
					city: Schema.declare<Date>(
						(value): value is Date => value instanceof Date,
					),
				},
				success: Schema.String,
			}),
		).annotate(Projection.Annotation, metadata),
		"payload",
	],
] as const
for (const [name, declaration, reason] of cases) {
	it.effect(`rejects ${name} with the service and operation`, () =>
		Effect.gen(function* () {
			// Each case deliberately erases its distinct payload to exercise runtime validation.
			const item = Projection.operation(
				Local,
				declaration as typeof rpc,
				(service, input) => service.read(input),
			)
			const result = yield* Effect.result(item.prepare)
			assert.isTrue(Result.isFailure(result))
			if (Result.isFailure(result)) {
				assert.equal(result.failure.service, Local.key)
				assert.include(
					String.toLowerCase(result.failure.reason),
					String.toLowerCase(reason),
				)
				assert.isNotEmpty(result.failure.operation)
			}
		}),
	)
}

it.effect(
	"rejects incomplete annotations and duplicate bindings before replacing the view",
	() =>
		run(
			Effect.gen(function* () {
				const { client, controller } = yield* start()
				const invalid = Projection.operation(
					Local,
					rpc.annotate(Projection.Annotation, { ...metadata, title: "" }),
					(service, input) => service.read(input),
				)
				const invalidResult = yield* Effect.result(controller.update([invalid]))
				assert.isTrue(Result.isFailure(invalidResult))
				const duplicateResult = yield* Effect.result(
					controller.update([binding(), binding()]),
				)
				assert.isTrue(Result.isFailure(duplicateResult))
				assert.equal(
					(yield* client.listTools()).tools[0]!.description,
					metadata.description,
				)
				assert.equal((yield* controller.history).length, 1)
			}),
		),
)

for (const [name, effect, kind] of [
	["business error", Effect.fail("No forecast is available"), "business"],
	[
		"system failure",
		Effect.fail({ _tag: "ContractFailure", secret: "private detail" }),
		"system",
	],
	["defect", Effect.die("private detail"), "system"],
	["invalid output", Effect.succeed(42 as unknown as string), "system"],
] as const) {
	it.effect(`maps ${name} to an MCP error result`, () =>
		run(
			Effect.gen(function* () {
				const { client } = yield* start(() => effect)
				const reply = yield* client.callTool({
					name: "forecast",
					arguments: { city: "London" },
				})
				assert.isTrue(reply.isError)
				const text = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(reply.content)
				assert.include(text, kind)
				assert.notInclude(text, "private detail")
				if (kind === "business")
					assert.include(text, "No forecast is available")
			}),
		),
	)
}

it.effect(
	"retains admitted calls while recording and publishing a new description",
	() =>
		run(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const events = yield* Ref.make<ReadonlyArray<Projection.Change>>([])
				yield* Event.on(Projection.Changed, (change) =>
					Ref.update(events, (all) => [...all, change]),
				)
				const { client, controller } = yield* start(() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
						Effect.as("old request"),
					),
				)
				const call = yield* client
					.callTool({ name: "forecast", arguments: { city: "London" } })
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				yield* controller.update([binding("Read the updated forecast")])
				assert.equal(
					(yield* client.listTools()).tools[0]!.description,
					"Read the updated forecast",
				)
				yield* Deferred.succeed(release, undefined)
				assert.deepStrictEqual((yield* Fiber.join(call)).structuredContent, {
					value: "old request",
				})
				const history = yield* controller.history
				assert.equal(
					history[1]!.before[0]!.metadata.description,
					metadata.description,
				)
				assert.equal(
					history[1]!.after[0]!.metadata.description,
					"Read the updated forecast",
				)
				const recorded = yield* Ref.get(events)
				assert.deepStrictEqual(recorded, history)
			}),
		),
)

it.effect(
	"owns accepted action publication after caller interruption and retains rejected views",
	() =>
		run(
			Effect.gen(function* () {
				const { client, controller } = yield* start()
				yield* controller.updateAfter(
					Effect.succeed(false),
					[binding("Rejected")],
					(accepted) => accepted,
				)
				assert.equal((yield* controller.history).length, 1)
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const published = yield* Deferred.make<void>()
				yield* Event.on(Projection.Changed, () =>
					Deferred.succeed(published, undefined).pipe(Effect.asVoid),
				)
				const caller = yield* controller
					.updateAfter(
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(true),
						),
						[binding("Accepted")],
						(accepted) => accepted,
					)
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				yield* Fiber.interrupt(caller)
				yield* Deferred.succeed(release, undefined)
				yield* Deferred.await(published)
				assert.equal(
					(yield* client.listTools()).tools[0]!.description,
					"Accepted",
				)
			}),
		),
)

it.effect("cancels the invocation and waits for its owned finalizer", () =>
	run(
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const closed = yield* Deferred.make<void>()
			const { client } = yield* start(() =>
				Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Effect.never),
					Effect.ensuring(Deferred.succeed(closed, undefined)),
				),
			)
			const call = yield* client
				.callTool({ name: "forecast", arguments: { city: "London" } })
				.pipe(Effect.forkScoped)
			yield* Deferred.await(entered)
			yield* Fiber.interrupt(call)
			yield* Deferred.await(closed)
			const exit = yield* Fiber.await(call)
			assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
		}),
	),
)

it.effect(
	"projects portable values and tuple schemas in the MCP default dialect",
	() =>
		run(
			Effect.gen(function* () {
				const tupleRpc = Contract.operation(
					"forecast/tuple",
					1,
					Rpc.make("Tuple", {
						payload: { pair: Schema.Tuple([Schema.BigInt, Schema.String]) },
						success: Schema.BigInt,
					}),
				).annotate(Projection.Annotation, { ...metadata, name: "tuple" })
				const item = Projection.operation(Local, tupleRpc, (_, { pair }) =>
					Effect.succeed(pair[0]),
				)
				yield* Graft.provide(Local, { read: () => Effect.succeed("unused") })
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "tuple",
						inject: [Local],
						apply: () => Projection.offer([item]).pipe(Effect.asVoid),
					}),
				)).await
				yield* (yield* Graft.plugin(core, {})).await
				const adapter = yield* transport({ protocolVersion: "2025-11-25" })
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				const tools = yield* client.listTools()
				const schemaText = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(tools.tools[0]!.inputSchema)
				assert.include(schemaText, "prefixItems")
				assert.deepStrictEqual(
					(yield* client.callTool({
						name: "tuple",
						arguments: { pair: ["42", "example"] },
					})).structuredContent,
					{ value: "42" },
				)
			}),
		),
)

it.effect("void output discards the value deliberately", () =>
	run(
		Effect.gen(function* () {
			const { client, controller } = yield* start()
			yield* controller.update([
				Projection.operation(
					Local,
					rpc.annotate(Projection.Annotation, { ...metadata, output: "void" }),
					(service, input) => service.read(input),
				),
			])
			const reply = yield* client.callTool({
				name: "forecast",
				arguments: { city: "London" },
			})
			assert.isFalse(reply.isError)
			const advertised = yield* client.listTools()
			assert.isUndefined(advertised.tools[0]!.outputSchema)
			assert.isUndefined(reply.structuredContent)
			const text = yield* Schema.encodeEffect(
				Schema.fromJsonString(Schema.Unknown),
			)(reply)
			assert.notInclude(text, "London")
		}),
	),
)

it.effect(
	"logs the entire defect cause while returning a scrubbed result",
	() => {
		const entries: Array<Logger.Options<unknown>> = []
		return run(
			Effect.gen(function* () {
				const defect = new Error("Private failure")
				const { client } = yield* start(() => Effect.die(defect))
				const result = yield* client.callTool({
					name: "forecast",
					arguments: { city: "London" },
				})
				const text = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(result)
				assert.notInclude(text, "Private failure")
				assert.isTrue(
					Array.some(entries, (entry) =>
						Array.some(
							entry.cause.reasons,
							(reason) => Cause.isDieReason(reason) && reason.defect === defect,
						),
					),
				)
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((entry) => {
						entries.push(entry)
					}),
				]),
			),
		)
	},
)

it.effect("bounds retained descriptions and records every revision", () =>
	run(
		Effect.gen(function* () {
			const { controller } = yield* start()
			const count = yield* Ref.make(0)

			yield* Event.on(Projection.Changed, () => Ref.update(count, (n) => n + 1))
			for (let revision = 0; revision < 40; revision++)
				yield* controller.update([binding(`Forecast revision ${revision}`)])
			const total = yield* Ref.get(count)
			assert.equal(total, 40)
			const history = yield* controller.history
			assert.equal(history.length, 32)
			assert.equal(history.at(-1)!.revision, 41)
		}),
	),
)

it.effect(
	"snapshots metadata before a deployment action can mutate its input",
	() =>
		Effect.gen(function* () {
			const source = { ...metadata }
			const item = Projection.operation(
				Local,
				rpc.annotate(Projection.Annotation, source),
				(service, input) => service.read(input),
			)
			const prepared = yield* item.prepare
			source.description = "Changed after validation"
			source.readOnlyHint = false
			assert.equal(prepared.metadata.description, metadata.description)
			assert.isTrue(prepared.metadata.readOnlyHint)
			assert.isTrue(Object.isFrozen(prepared.metadata))
		}),
)

class Other extends Context.Service<Other, Local["Service"]>()(
	"@graftland/plugin-mcp-server/test/contract-projection.test/Other",
) {}

it.effect(
	"dispatches the same operation identity through distinct service bindings",
	() =>
		run(
			Effect.gen(function* () {
				yield* Graft.provide(Local, {
					read: () => Effect.succeed("first service"),
				})
				yield* Graft.provide(Other, {
					read: () => Effect.succeed("second service"),
				})
				const second = Projection.operation(
					Other,
					rpc.annotate(Projection.Annotation, { ...metadata, name: "second" }),
					(service, input) => service.read(input),
				)
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "two-services",
						inject: [Local, Other],
						apply: () =>
							Projection.offer<Local | Other>([binding(), second]).pipe(
								Effect.asVoid,
							),
					}),
				)).await
				yield* (yield* Graft.plugin(core, {})).await
				const adapter = yield* transport({ protocolVersion: "2025-11-25" })
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				const firstReply = yield* client.callTool({
					name: "forecast",
					arguments: { city: "London" },
				})
				const secondReply = yield* client.callTool({
					name: "second",
					arguments: { city: "London" },
				})
				assert.deepStrictEqual(firstReply.structuredContent, {
					value: "first service",
				})
				assert.deepStrictEqual(secondReply.structuredContent, {
					value: "second service",
				})
			}),
		),
)

it.effect(
	"rejects concurrent view actions without starting or queuing them",
	() =>
		run(
			Effect.gen(function* () {
				const { controller } = yield* start()
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const calls = yield* Ref.make(0)
				const first = yield* controller
					.updateAfter(
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
						),
						[binding("First")],
						() => true,
					)
					.pipe(Effect.forkScoped)
				yield* Deferred.await(entered)
				const rejected = yield* Effect.result(
					controller.updateAfter(
						Ref.update(calls, (n) => n + 1),
						[binding("Second")],
						() => true,
					),
				)
				assert.isTrue(Result.isFailure(rejected))
				if (Result.isFailure(rejected))
					assert.include(rejected.failure.reason, "Another view update")
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.join(first)
				const invoked = yield* Ref.get(calls)
				assert.equal(invoked, 0)
				const history = yield* controller.history
				assert.equal(history.length, 2)
				assert.equal(history[1]!.after[0]!.metadata.description, "First")
			}),
		),
)

it.effect(
	"withdraws disposed tools before notifying the connected client",
	() =>
		run(
			Effect.gen(function* () {
				const { client, contributor } = yield* start()
				assert.equal((yield* client.listTools()).tools.length, 1)
				yield* contributor.dispose
				const notification = yield* Queue.take(client.notifications)
				assert.equal(notification.method, "notifications/tools/list_changed")
				assert.deepStrictEqual((yield* client.listTools()).tools, [])
				const missing = yield* Effect.result(
					client.callTool({
						name: "forecast",
						arguments: { city: "London" },
					}),
				)
				assert.isTrue(Result.isFailure(missing))
			}),
		),
)

for (const stage of [
	"invocation defect",
	"invocation failure",
	"success encoder",
	"business encoder",
] as const) {
	it.effect(`preserves mixed cancellation through MCP during ${stage}`, () => {
		const entries: Array<{
			readonly cause: Cause.Cause<unknown>
			readonly annotations: Readonly<Record<string, unknown>>
		}> = []
		const interrupted =
			stage === "invocation failure"
				? Effect.failCause(
						Cause.combine(Cause.interrupt(), Cause.fail("Cleanup failed")),
					)
				: Effect.interrupt.pipe(Effect.ensuring(Effect.die("Cleanup defect")))
		const encoding = Schema.String.pipe(
			Schema.middlewareEncoding(() =>
				Effect.interrupt.pipe(Effect.ensuring(Effect.die("Cleanup defect"))),
			),
		)
		const declaration = Contract.operation(
			"forecast/read",
			1,
			Rpc.make("Read", {
				payload: { city: Schema.String },
				success: stage === "success encoder" ? encoding : Schema.String,
				error: stage === "business encoder" ? encoding : Schema.String,
			}),
		).annotate(Projection.Annotation, metadata)
		const item = Projection.operation(Local, declaration, (service, input) =>
			service.read(input),
		)
		return run(
			Effect.gen(function* () {
				const completed = yield* Deferred.make<Exit.Exit<unknown, unknown>>()
				yield* Event.on(CallMiddleware, (call, next) =>
					next(call).pipe(
						Effect.onExit((exit) => Deferred.succeed(completed, exit)),
					),
				)
				const { client } = yield* start(
					() =>
						stage === "business encoder"
							? Effect.fail("No forecast")
							: stage === "success encoder"
								? Effect.succeed("London")
								: interrupted,
					[item],
				)
				const exit = yield* Effect.exit(
					client.callTool({
						name: "forecast",
						arguments: { city: "London" },
					}),
				)
				// JSON-RPC has no fiber exit: unsolicited server cancellation becomes
				// a protocol error, never a completed CallToolResult.
				assert.isTrue(Exit.isFailure(exit))
				const serverExit = yield* Deferred.await(completed)
				assert.isTrue(
					Exit.isFailure(serverExit) &&
						Cause.hasInterruptsOnly(serverExit.cause),
				)
				const mixed = Array.findFirst(
					entries,
					({ cause }) =>
						Cause.hasInterrupts(cause) &&
						(stage === "invocation failure"
							? Cause.hasFails(cause)
							: Cause.hasDies(cause)),
				)
				assert.isTrue(Option.isSome(mixed))
				assert.deepInclude(Option.getOrThrow(mixed).annotations, {
					service: Local.key,
					operation: "forecast/read@1",
				})
				assert.equal((yield* client.listTools()).tools.length, 1)
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((entry) => {
						entries.push({
							cause: entry.cause,
							annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
						})
					}),
				]),
			),
		)
	})
}

for (const stage of ["success", "business"] as const) {
	it.effect(`annotates the complete ${stage} encoding failure cause`, () => {
		const entries: Array<{
			readonly cause: Cause.Cause<unknown>
			readonly annotations: Readonly<Record<string, unknown>>
		}> = []
		const defect = new Error("Private encoding defect")
		const encoding = Schema.String.pipe(
			Schema.middlewareEncoding(() => Effect.die(defect)),
		)
		const declaration = Contract.operation(
			"forecast/read",
			1,
			Rpc.make("Read", {
				payload: { city: Schema.String },
				success: stage === "success" ? encoding : Schema.String,
				error: stage === "business" ? encoding : Schema.String,
			}),
		).annotate(Projection.Annotation, metadata)
		const item = Projection.operation(Local, declaration, (service, input) =>
			service.read(input),
		)
		return run(
			Effect.gen(function* () {
				const { client } = yield* start(
					() =>
						stage === "business"
							? Effect.fail("No forecast")
							: Effect.succeed("London"),
					[item],
				)
				const reply = yield* client.callTool({
					name: "forecast",
					arguments: { city: "London" },
				})
				assert.isTrue(reply.isError)
				const logged = Array.findFirst(entries, ({ cause }) =>
					Array.some(
						cause.reasons,
						(reason) => Cause.isDieReason(reason) && reason.defect === defect,
					),
				)
				assert.isTrue(Option.isSome(logged))
				assert.deepInclude(Option.getOrThrow(logged).annotations, {
					service: Local.key,
					operation: "forecast/read@1",
				})
			}),
		).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((entry) => {
						entries.push({
							cause: entry.cause,
							annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
						})
					}),
				]),
			),
		)
	})
}

for (const owner of ["contributor", "caller"] as const) {
	for (const stage of [
		"invocation",
		"success encoder",
		"business encoder",
	] as const) {
		it.effect(
			`preserves ${owner} cancellation during ${stage} with failing cleanup`,
			() => {
				const entries: Array<{
					readonly cause: Cause.Cause<unknown>
					readonly annotations: Readonly<Record<string, unknown>>
				}> = []
				return run(
					Effect.gen(function* () {
						const admitted = yield* Deferred.make<void>()
						const observed = yield* Deferred.make<Exit.Exit<unknown, unknown>>()
						const defect = new Error("Cleanup defect")
						const pending = Deferred.succeed(admitted, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(Effect.die(defect)),
						)
						const encoding = Schema.String.pipe(
							Schema.middlewareEncoding(() => pending),
						)
						const declaration = Contract.operation(
							"forecast/read",
							1,
							Rpc.make("Read", {
								payload: { city: Schema.String },
								success: stage === "success encoder" ? encoding : Schema.String,
								error: stage === "business encoder" ? encoding : Schema.String,
							}),
						).annotate(Projection.Annotation, metadata)
						const item = Projection.operation(
							Local,
							declaration,
							(service, input) => service.read(input),
						)
						yield* Event.on(CallMiddleware, (call, next) =>
							next(call).pipe(
								Effect.onExit((exit) => Deferred.succeed(observed, exit)),
							),
						)
						const { client, contributor } = yield* start(
							() =>
								stage === "invocation"
									? pending
									: stage === "business encoder"
										? Effect.fail("No forecast")
										: Effect.succeed("London"),
							[item],
						)
						const call = yield* client
							.callTool({ name: "forecast", arguments: { city: "London" } })
							.pipe(Effect.forkScoped)
						yield* Deferred.await(admitted)
						if (owner === "contributor") yield* contributor.dispose
						else yield* Fiber.interrupt(call)
						const serverExit = yield* Deferred.await(observed)
						assert.isTrue(
							Exit.isFailure(serverExit) &&
								Cause.hasInterruptsOnly(serverExit.cause),
						)
						const clientExit = yield* Fiber.await(call)
						assert.isTrue(Exit.isFailure(clientExit))
						const logged = Array.findFirst(
							entries,
							({ cause }) =>
								Cause.hasInterrupts(cause) &&
								Array.some(
									cause.reasons,
									(reason) =>
										Cause.isDieReason(reason) && reason.defect === defect,
								),
						)
						assert.isTrue(Option.isSome(logged))
						assert.deepInclude(Option.getOrThrow(logged).annotations, {
							service: Local.key,
							operation: "forecast/read@1",
						})
					}),
				).pipe(
					Effect.provide(
						Logger.layer([
							Logger.make((entry) => {
								entries.push({
									cause: entry.cause,
									annotations: entry.fiber.getRef(
										References.CurrentLogAnnotations,
									),
								})
							}),
						]),
					),
				)
			},
		)
	}
}

it.effect(
	"rejects cached tool calls after a description change until exact reapproval",
	() =>
		run(
			Effect.gen(function* () {
				const artifact = {
					package: "@example/forecast",
					digest: String.repeat(64)("a"),
				}
				yield* Policy.install({
					version: "1",
					entries: [{ entry: "forecast", artifact, tier: "own", grants: [] }],
				})
				yield* Policy.bind("forecast", "current", artifact, [Local.key])
				const count = yield* Ref.make(0)
				const graft = yield* Graft.Graft
				const h = yield* start(({ city }) =>
					Policy.check("forecast", "current").pipe(
						Effect.provideService(Graft.Graft, graft),
						Effect.andThen(Ref.update(count, (n) => n + 1)),
						Effect.as(city),
					),
				)
				const approve = Effect.gen(function* () {
					const expected = yield* Policy.statement("forecast", artifact)
					const record = yield* Policy.review({ expected, who: "operator" })
					yield* Policy.approve(record)
				})
				const tools = yield* h.client.listTools()
				assert.equal(tools.tools[0]?.description, metadata.description)
				yield* approve
				const first = yield* h.client.callTool({
					name: "forecast",
					arguments: { city: "London" },
				})
				assert.notEqual(first.isError, true)
				yield* h.controller.update([binding("Changed description")])
				const notification = yield* Queue.take(h.client.notifications)
				assert.equal(notification.method, "notifications/tools/list_changed")
				const blocked = yield* h.client.callTool({
					name: "forecast",
					arguments: { city: "London" },
				})
				assert.isTrue(blocked.isError)
				const serialized = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(blocked)
				assert.include(serialized, "Unapproved")
				const executed = yield* Ref.get(count)
				assert.equal(executed, 1)
				yield* approve
				const second = yield* h.client.callTool({
					name: "forecast",
					arguments: { city: "Paris" },
				})
				assert.notEqual(second.isError, true)
			}),
		),
)

it.effect(
	"keeps approval when an unchanged projection is withdrawn and remounted",
	() =>
		run(
			Effect.gen(function* () {
				const artifact = {
					package: "@example/forecast",
					digest: String.repeat(64)("a"),
				}
				yield* Policy.install({
					version: "1",
					entries: [{ entry: "forecast", artifact, tier: "own", grants: [] }],
				})
				yield* Policy.bind("forecast", "current", artifact, [Local.key])
				const h = yield* start()
				const before = yield* Policy.statement("forecast", artifact)
				const approval = yield* Policy.review({
					expected: before,
					who: "Operator",
				})
				yield* Policy.approve(approval)
				yield* h.contributor.dispose
				yield* Queue.take(h.client.notifications)
				assert.deepEqual((yield* h.client.listTools()).tools, [])
				yield* Policy.check("forecast", "current")
				const afterWithdrawal = yield* Policy.statement("forecast", artifact)
				assert.deepEqual(afterWithdrawal, before)
				const ready = yield* Deferred.make<Projection.Controller<Local>>()
				const remounted = yield* Graft.plugin(
					Plugin.make({
						name: "remounted-tools",
						inject: [Local],
						apply: () =>
							Projection.offer([binding()]).pipe(
								Effect.flatMap((controller) =>
									Deferred.succeed(ready, controller).pipe(Effect.asVoid),
								),
							),
					}),
				)
				yield* remounted.await
				yield* Queue.take(h.client.notifications)
				yield* Policy.check("forecast", "current")
				const afterRemount = yield* Policy.statement("forecast", artifact)
				assert.deepEqual(afterRemount, before)
				assert.equal(
					(yield* h.client.listTools()).tools[0]?.description,
					metadata.description,
				)
				const controller = yield* Deferred.await(ready)
				yield* controller.update([binding("New operator-visible description")])
				yield* Queue.take(h.client.notifications)
				assert.equal(
					(yield* Policy.check("forecast", "current").pipe(Effect.flip)).reason,
					"ChangedStatement",
				)
			}),
		),
)
