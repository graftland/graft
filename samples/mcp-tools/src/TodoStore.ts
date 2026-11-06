import { Context, type Effect } from "effect"

/** In-memory todos, published by the `todo-store` plugin. */
export class TodoStore extends Context.Service<
	TodoStore,
	{
		readonly list: Effect.Effect<ReadonlyArray<string>>
		readonly add: (title: string) => Effect.Effect<void>
	}
>()("@graftland/sample-mcp-tools/TodoStore") {}
