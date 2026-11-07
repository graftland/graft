import { Effect, Layer } from "effect"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"
import core from "@graftland/plugin-mcp-server"
import * as Testing from "@graftland/plugin-mcp-server/Testing"

import content from "../src/plugins/content.ts"

for (const protocolVersion of ["2026-07-28", "2025-11-25"] as const) {
	it.effect(
		protocolVersion +
			": serves the content template, prompt, completion and elicitation",
		() =>
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(core, {})).await
				yield* (yield* Graft.plugin(content)).await
				const adapter = yield* Testing.transport
				yield* (yield* Graft.plugin(adapter.plugin)).await
				const client = yield* adapter.client
				const capabilities = { elicitation: { form: {} } }
				const metadata =
					protocolVersion === "2026-07-28"
						? {
								...Testing.metadata,
								"io.modelcontextprotocol/clientCapabilities": capabilities,
							}
						: {}
				if (protocolVersion === "2025-11-25") {
					yield* client.send({
						jsonrpc: "2.0",
						id: 0,
						method: "initialize",
						params: {
							protocolVersion,
							capabilities,
							clientInfo: { name: "sample-test", version: "1" },
						},
					})
					const initialized = yield* Testing.response(client, 0)
					assert.isUndefined(initialized.error)
					yield* client.send({
						jsonrpc: "2.0",
						method: "notifications/initialized",
					})
				}
				const request = (
					id: number,
					method: string,
					params: Record<string, unknown>,
				) =>
					client
						.send({
							jsonrpc: "2.0",
							id,
							method,
							params: { ...params, _meta: metadata },
						})
						.pipe(Effect.andThen(Testing.response(client, id)))
				const read = yield* request(1, "resources/read", {
					uri: "greeting://Ada",
				})
				assert.deepInclude(read.result, {
					contents: [{ uri: "greeting://Ada", text: "Hello Ada" }],
				})
				const prompt = yield* request(2, "prompts/get", {
					name: "greet",
					arguments: { name: "Ada" },
				})
				assert.deepInclude(prompt.result, {
					messages: [
						{
							role: "user",
							content: {
								type: "text",
								text: "Write a friendly greeting for Ada.",
							},
						},
					],
				})
				const completion = yield* request(3, "completion/complete", {
					ref: { type: "ref/prompt", name: "greet" },
					argument: { name: "name", value: "A" },
				})
				assert.deepInclude(completion.result, {
					completion: { values: ["Ada"], total: 1, hasMore: false },
				})
				yield* client.send({
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: { name: "ask_name", arguments: {}, _meta: metadata },
				})
				if (protocolVersion === "2026-07-28") {
					const required = yield* Testing.response(client, 4)
					assert.propertyVal(required.result, "resultType", "input_required")
					assert.deepNestedPropertyVal(
						required.result,
						"inputRequests.name.method",
						"elicitation/create",
					)
					const accepted = yield* request(5, "tools/call", {
						name: "ask_name",
						arguments: {},
						inputResponses: {
							name: { action: "accept", content: { name: "Ada" } },
						},
					})
					assert.deepInclude(accepted.result, {
						content: [{ type: "text", text: "Hello Ada" }],
					})
				} else {
					const elicitation = yield* client.receive
					assert.propertyVal(elicitation, "method", "elicitation/create")
					if ("id" in elicitation)
						yield* client.send({
							jsonrpc: "2.0",
							id: elicitation.id!,
							result: { action: "accept", content: { name: "Ada" } },
						})
					const accepted = yield* Testing.response(client, 4)
					assert.deepInclude(accepted.result, {
						content: [{ type: "text", text: "Hello Ada" }],
					})
				}
			}).pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer))),
	)
}
