import { Array, Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { TodoStore } from "../TodoStore.ts"

/** Publishes an in-memory `TodoStore`. Disable it, and the todo tools go away. */
export default Plugin.make({
	name: "@graftland/sample-mcp-tools/plugins/todo-store",
	apply: () =>
		Effect.gen(function* () {
			const todos = yield* Ref.make<ReadonlyArray<string>>([])
			yield* Graft.provide(TodoStore, {
				list: Ref.get(todos),
				add: (title) => Ref.update(todos, Array.append(title)),
			})
		}),
})
