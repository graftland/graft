import { Array, Context, Effect, Schema, String } from "effect"
import { McpSchema, McpServer } from "effect/ai"

import { Plugin } from "@graftland/graft"
import * as Catalog from "@graftland/plugin-mcp-server/Catalog"
import * as Prompts from "@graftland/plugin-mcp-server/Prompts"
import * as Resources from "@graftland/plugin-mcp-server/Resources"

type Question = Parameters<McpServer.McpServer["Service"]["addTool"]>[0]
const questionKind: Catalog.Kind<Question> = {
	key: "@graftland/sample-mcp-tools/Question/kind",
	list: "tools",
	identities: (item) => [item.tool.name],
	install: (item, annotations) =>
		McpServer.McpServer.use((server) =>
			server.addTool({
				...item,
				annotations: Catalog.enabledWhen(annotations, item.annotations),
			}),
		),
}
const answer = Schema.Struct({
	action: Schema.Literals(["accept", "decline", "cancel"]),
	content: Schema.optional(Schema.Struct({ name: Schema.String })),
})
const result = (name?: string) =>
	McpSchema.CallToolResult.make({
		content: [
			{
				type: "text",
				text: name === undefined ? "No name supplied" : "Hello " + name,
			},
		],
	})

export default Plugin.make({
	name: "@graftland/sample-mcp-tools/plugins/content",
	apply: () =>
		Effect.gen(function* () {
			const greeting =
				yield* Resources.template`greeting://${McpSchema.param("name", Schema.String)}`(
					{
						name: "Greeting",
						content: (_uri, name) => Effect.succeed("Hello " + name),
					},
				)
			yield* Resources.offer(greeting)
			yield* Prompts.offer({
				name: "greet",
				description: "Write a short greeting.",
				parameters: { name: Schema.String },
				content: ({ name }) =>
					Effect.succeed("Write a friendly greeting for " + name + "."),
				completion: {
					name: (prefix) =>
						Effect.succeed(
							Array.filter(["Ada", "Grace"], String.startsWith(prefix)),
						),
				},
			})
			const handle = yield* Catalog.own(() =>
				Effect.gen(function* () {
					const context = yield* McpSchema.McpRequestContext
					if (context.protocolVersion !== "2026-07-28") {
						return yield* McpServer.elicit({
							message: "What name should I use?",
							schema: Schema.Struct({ name: Schema.String }),
						}).pipe(
							Effect.map(({ name }) => result(name)),
							Effect.catchTag("ElicitationDeclined", () =>
								Effect.succeed(result()),
							),
							Effect.mapError((error) =>
								McpSchema.InternalError.make({
									message: globalThis.String(error),
								}),
							),
						)
					}
					const response = context.inputResponses?.["name"]
					if (response === undefined)
						return new McpSchema.InputRequired({
							inputRequests: {
								name: {
									method: "elicitation/create",
									params: {
										mode: "form",
										message: "What name should I use?",
										requestedSchema: {
											type: "object",
											properties: { name: { type: "string" } },
											required: ["name"],
										},
									},
								},
							},
						})
					const supplied = yield* Schema.decodeUnknownEffect(answer)(
						response,
					).pipe(
						Effect.mapError((error) =>
							McpSchema.InvalidParams.make({ message: error.message }),
						),
					)
					return result(
						supplied.action === "accept" ? supplied.content?.name : undefined,
					)
				}),
			)
			yield* Catalog.offer(questionKind, {
				tool: McpSchema.Tool.make({
					name: "ask_name",
					description: "Asks the client for a name using form elicitation.",
					inputSchema: { type: "object" },
				}),
				annotations: Context.empty(),
				handle,
			})
		}),
})
