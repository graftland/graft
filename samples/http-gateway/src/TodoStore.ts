import { Context, type Effect } from "effect"

export interface Todo {
	readonly id: number
	readonly title: string
}

export class TodoStore extends Context.Service<
	TodoStore,
	{
		readonly list: Effect.Effect<ReadonlyArray<Todo>>
		readonly remove: (id: number) => Effect.Effect<boolean>
		readonly add: (title: string) => Effect.Effect<Todo>
	}
>()("@graftland/sample-http-gateway/TodoStore") {}
