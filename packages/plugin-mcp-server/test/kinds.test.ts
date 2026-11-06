import {
	Array,
	Context,
	Effect,
	FileSystem,
	Layer,
	Schema,
	Scope,
} from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import type { Kind } from "../src/Catalog.ts"
import core from "../src/index.ts"
import * as Prompts from "../src/Prompts.ts"
import * as Resources from "../src/Resources.ts"
import * as Testing from "../src/Testing.ts"
import { httpTransport } from "./http-support.ts"
import { stdioTransport, unixTransport } from "./wire.ts"

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		HttpClient.HttpClient | Graft.Graft | Scope.Scope | FileSystem.FileSystem
	>,
) =>
	effect.pipe(
		Effect.scoped,
		Effect.provide(
			Layer.provideMerge(
				Layer.merge(Layer.fresh(Graft.layer), NodeServices.layer),
				FetchHttpClient.layer,
			),
		),
	)
const disabled = Context.make(McpSchema.EnabledWhen, () => false)
const testKind = <Item>(
	label: string,
	kind: Kind<Item>,
	item: Item,
	ownDisabled: Item,
	method: string,
	field: string,
	identity: string,
	notification: string,
) => {
	for (const [transportName, transport] of [
		["Testing", Testing.transport],
		["stdio", stdioTransport],
		["Unix", unixTransport],
		["HTTP", httpTransport],
	] as const) {
		it.effect(
			transportName + ": " + label + " kind conformance and list changes",
			() =>
				Effect.gen(function* () {
					yield* (yield* Graft.plugin(core, {})).await
					const adapter = yield* transport
					yield* (yield* Graft.plugin(adapter.plugin)).await
					const client = yield* adapter.client
					yield* client.send({
						jsonrpc: "2.0",
						id: 1,
						method: "subscriptions/listen",
						params: {
							_meta: Testing.metadata,
							notifications: {
								toolsListChanged: true,
								resourcesListChanged: true,
								promptsListChanged: true,
							},
						},
					})
					const ack = yield* client.receive
					assert.propertyVal(
						ack,
						"method",
						"notifications/subscriptions/acknowledged",
					)
					const changed = Effect.map(client.receive, (message) =>
						assert.propertyVal(message, "method", notification),
					)
					const inspect = Effect.gen(function* () {
						yield* client.send({
							jsonrpc: "2.0",
							id: 2,
							method,
							params: { _meta: Testing.metadata },
						})
						const result = yield* Testing.response(client, 2)
						return Array.map(
							(
								result.result as Record<
									string,
									ReadonlyArray<Record<string, string>>
								>
							)[field]!,
							(item) => item[identity]!,
						)
					})
					yield* Testing.kindConformance(
						kind,
						item,
						inspect,
						ownDisabled,
						changed,
					)
				}).pipe(run),
		)
	}
}
const prompt: Prompts.Registration = {
	name: "conformance",
	content: () => Effect.succeed("prompt"),
}
testKind(
	"prompt",
	Prompts.kind,
	prompt,
	{ ...prompt, annotations: disabled },
	"prompts/list",
	"prompts",
	"name",
	"notifications/prompts/list_changed",
)
const template: Resources.Template = {
	uriTemplate: "test://{name}",
	completionKeys: [],
	register: (annotations) =>
		McpServer.registerResource`test://${McpSchema.param("name", Schema.String)}`(
			{
				name: "conformance",
				annotations,
				content: () => Effect.succeed("content"),
			},
		),
}
testKind(
	"template",
	Resources.templateKind,
	template,
	{ ...template, annotations: disabled },
	"resources/templates/list",
	"resourceTemplates",
	"uriTemplate",
	"notifications/resources/list_changed",
)

const resource: Resources.Resource = {
	name: "conformance",
	uri: "test://static",
	content: Effect.succeed("content"),
}
testKind(
	"static resource",
	Resources.kind,
	resource,
	{ ...resource, annotations: disabled },
	"resources/list",
	"resources",
	"uri",
	"notifications/resources/list_changed",
)
