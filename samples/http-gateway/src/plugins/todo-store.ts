import { Array, Effect, Ref, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { TodoStore, type Todo } from "../TodoStore.ts"

/** Publishes an in-memory `TodoStore`, seeded from its config. */
export default Plugin.make({
	name: "todo-store",
	config: Schema.Struct({ seed: Schema.Array(Schema.String) }),
	apply: Effect.fn("todo-store.apply")(function* ({ seed }) {
		const todos = yield* Ref.make<ReadonlyArray<Todo>>(
			Array.map(seed, (title, index) => ({ id: index + 1, title })),
		)
		yield* Effect.acquireRelease(Effect.log("Todo store opened"), () =>
			Effect.log("Todo store closed"),
		)
		yield* Graft.provide(TodoStore, {
			list: Ref.get(todos),
			add: (title) =>
				Ref.modify(todos, (current) => {
					const todo = { id: current.length + 1, title }
					return [todo, Array.append(current, todo)]
				}),
		})
	}),
})
