import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Schema,
	Scope,
} from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { assert, it } from "@effect/vitest"

import { Event, Graft, Plugin } from "@graftland/graft"

import * as Catalog from "../src/Catalog.ts"
import core from "../src/index.ts"
import * as Prompts from "../src/Prompts.ts"
import * as Resources from "../src/Resources.ts"
import * as Tools from "../src/Tools.ts"
import * as Testing from "./support.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))
const connect = (protocolVersion: "2026-07-28" | "2025-11-25") =>
	Effect.gen(function* () {
		yield* (yield* Graft.plugin(core, {})).await
		const transport = yield* Testing.transport({ protocolVersion })
		yield* (yield* Graft.plugin(transport.plugin)).await
		return yield* transport.client
	})
const source = (
	name: string,
	apply: Effect.Effect<void, never, Graft.Graft | Scope.Scope>,
) => Plugin.make({ name, apply: () => apply })
const template = (name: string, value: string): Resources.Template => ({
	uriTemplate: `note://{${name}}`,
	completionKeys: [],
	register: (annotations) =>
		McpServer.registerResource`note://${McpSchema.param(name, Schema.String)}`({
			name,
			annotations,
			content: () => Effect.succeed(value),
		}),
})

for (const version of ["2026-07-28", "2025-11-25"] as const) {
	it.effect(
		`${version}: sentinels advertise empty lists and later prompts`,
		() =>
			Effect.gen(function* () {
				const client = yield* connect(version)
				assert.deepStrictEqual((yield* client.listTools()).tools, [])
				assert.deepStrictEqual((yield* client.listResources()).resources, [])
				assert.deepStrictEqual((yield* client.listPrompts()).prompts, [])
				const fork = yield* Graft.plugin(
					source(
						"test/prompt",
						Prompts.offer({
							name: "greeting",
							parameters: { name: Schema.String },
							content: ({ name }) => Effect.succeed("Hello " + name),
							completion: { name: () => Effect.succeed(["Ada", "Grace"]) },
						}),
					),
				)
				yield* fork.await
				assert.equal(
					(yield* client.getPrompt({
						name: "greeting",
						arguments: { name: "Ada" },
					})).messages.length,
					1,
				)
				assert.deepStrictEqual(
					(yield* client.complete({
						ref: { type: "ref/prompt", name: "greeting" },
						argument: { name: "name", value: "A" },
					})).completion.values,
					["Ada", "Grace"],
				)
				yield* fork.dispose
				const completed = yield* Effect.flip(
					client.complete({
						ref: { type: "ref/prompt", name: "greeting" },
						argument: { name: "name", value: "A" },
					}),
				)
				assert.equal(completed.code, McpSchema.INVALID_PARAMS_ERROR_CODE)
			}).pipe(run),
	)

	it.effect(
		`${version}: a withdrawn template falls through to a live overlapping template (C5)`,
		() =>
			Effect.gen(function* () {
				const client = yield* connect(version)
				const first = yield* Graft.plugin(
					source(
						"test/first-template",
						Resources.offer(template("first", "first")),
					),
				)
				yield* first.await
				yield* (yield* Graft.plugin(
					source(
						"test/second-template",
						Resources.offer(template("second", "second")),
					),
				)).await
				assert.deepStrictEqual(
					(yield* client.readResource({ uri: "note://entry" })).contents,
					[{ uri: "note://entry", text: "first" }],
				)
				yield* first.dispose
				assert.deepStrictEqual(
					(yield* client.readResource({ uri: "note://entry" })).contents,
					[{ uri: "note://entry", text: "second" }],
				)
			}).pipe(run),
	)

	it.effect(
		`${version}: a withdrawn static resource falls through to a template`,
		() =>
			Effect.gen(function* () {
				const client = yield* connect(version)
				const first = yield* Graft.plugin(
					source(
						"test/static",
						Resources.offer({
							name: "entry",
							uri: "note://entry",
							content: Effect.succeed("static"),
						}),
					),
				)
				yield* first.await
				yield* (yield* Graft.plugin(
					source(
						"test/template",
						Resources.offer(template("name", "template")),
					),
				)).await
				assert.deepStrictEqual(
					(yield* client.readResource({ uri: "note://entry" })).contents,
					[{ uri: "note://entry", text: "static" }],
				)
				yield* first.dispose
				assert.deepStrictEqual(
					(yield* client.readResource({ uri: "note://entry" })).contents,
					[{ uri: "note://entry", text: "template" }],
				)
				assert.equal(
					(yield* Effect.flip(client.readResource({ uri: "missing://entry" })))
						.code,
					version === "2026-07-28"
						? McpSchema.INVALID_PARAMS_ERROR_CODE
						: -32002,
				)
			}).pipe(run),
	)

	it.effect(
		`${version}: conflicts hide static resources and restore the survivor`,
		() =>
			Effect.gen(function* () {
				const client = yield* connect(version)
				const item = {
					name: "entry",
					uri: "note://entry",
					content: Effect.succeed("entry"),
				}
				yield* (yield* Graft.plugin(source("test/one", Resources.offer(item))))
					.await
				const second = yield* Graft.plugin(
					source("test/two", Resources.offer(item)),
				)
				yield* second.await
				assert.deepStrictEqual((yield* client.listResources()).resources, [])
				yield* second.dispose
				assert.equal((yield* client.listResources()).resources.length, 1)
			}).pipe(run),
	)

	it.effect(
		`${version}: liveness preserves a tool's own EnabledWhen predicate`,
		() =>
			Effect.gen(function* () {
				const client = yield* connect(version)
				const toolkit = Toolkit.make(
					Tool.make("hidden", { success: Schema.String }).annotate(
						McpSchema.EnabledWhen,
						() => false,
					),
				)
				yield* (yield* Graft.plugin(
					Tools.plugin({
						name: "test/hidden",
						toolkit,
						handlers: Effect.succeed(
							toolkit.of({ hidden: () => Effect.succeed("hidden") }),
						),
					}),
				)).await
				assert.deepStrictEqual((yield* client.listTools()).tools, [])
			}).pipe(run),
	)
}

it.effect(
	"catalog synchronization awaits both transport projections (C7)",
	() =>
		Effect.gen(function* () {
			yield* (yield* Graft.plugin(core, {})).await
			const first = yield* Testing.transport({ name: "test/first" })
			const second = yield* Testing.transport({ name: "test/second" })
			yield* (yield* Graft.plugin(first.plugin)).await
			yield* (yield* Graft.plugin(second.plugin)).await
			const started = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const count = yield* Ref.make(0)
			const kind: Catalog.Kind<string> = {
				key: "test/slow-kind",
				list: "tools",
				identities: (name) => [name],
				install: (name, annotations) =>
					Effect.gen(function* () {
						const n = yield* Ref.updateAndGet(count, (n) => n + 1)
						if (n === 2) {
							yield* Deferred.succeed(started, undefined)
							yield* Deferred.await(release)
						}
						const server = yield* McpServer.McpServer
						yield* server.addTool({
							tool: McpSchema.Tool.make({
								name,
								inputSchema: { type: "object" },
							}),
							annotations: Catalog.enabledWhen(annotations),
							handle: () =>
								Effect.succeed(McpSchema.CallToolResult.make({ content: [] })),
						})
					}),
			}
			yield* Event.on(Catalog.Offered, () =>
				Effect.succeed([{ kind, item: "fanout" }]),
			)
			const emitted = yield* Effect.forkChild(Event.emit(Catalog.Changed))
			yield* Deferred.await(started)
			assert.isUndefined(emitted.pollUnsafe())
			assert.equal((yield* (yield* first.client).listTools()).tools.length, 1)
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(emitted)
			assert.equal((yield* (yield* second.client).listTools()).tools.length, 1)
		}).pipe(run),
)

it.effect(
	"a partial failed install stays hidden and does not fail the emitter",
	() =>
		Effect.gen(function* () {
			const client = yield* connect("2026-07-28")
			const kind: Catalog.Kind<string> = {
				key: "test/failed-install",
				list: "resources",
				identities: (uri) => [uri],
				install: (uri, annotations) =>
					McpServer.registerResource({
						uri,
						name: uri,
						annotations,
						content: Effect.succeed("hidden"),
					}).pipe(Effect.andThen(Effect.die("installation failed"))),
			}
			yield* Event.on(Catalog.Offered, () =>
				Effect.succeed([{ kind, item: "note://broken" }]),
			)
			const emitted = yield* Effect.exit(Event.emit(Catalog.Changed))
			assert.isTrue(Exit.isSuccess(emitted))
			assert.deepStrictEqual((yield* client.listResources()).resources, [])
		}).pipe(run),
)
