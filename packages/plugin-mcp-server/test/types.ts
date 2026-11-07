import { Context, Effect, Schema, Scope } from "effect"
import { McpSchema, Tool, Toolkit } from "effect/ai"

import { plugin as tools } from "../src/Tools.ts"

class Secret extends Context.Service<Secret, string>()(
	"@graftland/plugin-mcp-server/test/types/Secret",
) {}
const NeedsSecret = Toolkit.make(
	Tool.make("secret", {
		success: Schema.String,
		dependencies: [Secret],
	}),
)

// @ts-expect-error -- A tool's service dependency must be supplied through inject.
export const missingDependency = tools({
	name: "missing dependency",
	toolkit: NeedsSecret,
	handlers: Effect.succeed(NeedsSecret.of({ secret: () => Secret })),
})

const Plain = Toolkit.make(Tool.make("plain", { success: Schema.String }))

/** Handlers whose construction needs `Secret`. */
declare const needingSecret: Effect.Effect<
	Toolkit.HandlersFrom<typeof Plain.tools>,
	never,
	Secret
>

const constructionOptions = {
	name: "missing construction dependency",
	toolkit: Plain,
	handlers: needingSecret,
}
type AssertFalse<A extends false> = A
/** Construction requirements must also be declared in inject. */
export type MissingConstructionDependency = AssertFalse<
	typeof constructionOptions extends Parameters<
		typeof tools<typeof Plain.tools>
	>[0]
		? true
		: false
>

const RequestTools = Toolkit.make(
	Tool.make("request", {
		success: Schema.String,
		dependencies: [
			McpSchema.McpRequestContext,
			McpSchema.McpServerClient,
			Scope.Scope,
		],
	}),
)

/** The transport supplies all request services without plugin injection. */
export const requestServices = tools({
	name: "request services",
	toolkit: RequestTools,
	handlers: Effect.succeed(
		RequestTools.of({
			request: () =>
				Effect.gen(function* () {
					yield* McpSchema.McpRequestContext
					yield* McpSchema.McpServerClient
					yield* Scope.Scope
					return "available"
				}),
		}),
	),
})
