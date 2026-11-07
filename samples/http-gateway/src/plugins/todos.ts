import { Array, Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import { Plugin } from "@graftland/graft"
import * as HttpApis from "@graftland/plugin-http-api/HttpApis"

import { Api, Todo, TodoNotFound } from "../api/Todos.ts"
import { TodoStore } from "../TodoStore.ts"

export const TodosLive = HttpApiBuilder.group(Api, "todos", (handlers) =>
	handlers
		.handle("list", () =>
			Effect.flatMap(TodoStore, (store) =>
				Effect.map(store.list, (todos) =>
					Array.map(todos, (todo) => Todo.make(todo)),
				),
			),
		)
		.handle("create", ({ payload }) =>
			Effect.gen(function* () {
				const store = yield* TodoStore
				const todo = yield* store.add(payload.title)
				return Todo.make(todo)
			}),
		)
		.handle("get", ({ params }) =>
			Effect.gen(function* () {
				const store = yield* TodoStore
				const todos = yield* store.list
				const todo = Array.findFirst(todos, (todo) => todo.id === params.id)
				return Option.isSome(todo)
					? Todo.make(todo.value)
					: yield* TodoNotFound.make({ id: params.id })
			}),
		)
		.handle("remove", ({ params }) =>
			Effect.gen(function* () {
				const store = yield* TodoStore
				if (!(yield* store.remove(params.id)))
					return yield* TodoNotFound.make({ id: params.id })
			}),
		),
)
/** The contract and handlers live exactly as long as the injected store. */
export default Plugin.make({
	name: "@graftland/sample-http-gateway/plugins/todos",
	inject: [TodoStore],
	apply: () => HttpApis.serve(Api, ["todos"], TodosLive),
})
