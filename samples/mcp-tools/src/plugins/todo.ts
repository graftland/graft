import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

import { plugin as tools } from "@graftland/plugin-mcp-server/Tools"

import { TodoStore } from "../TodoStore.ts"

const TodoTools = Toolkit.make(
	Tool.make("add_todo", {
		description: "Adds a todo.",
		parameters: Schema.Struct({ title: Schema.String }),
		success: Schema.String,
	}),
	Tool.make("list_todos", {
		description: "Lists the todos, oldest first.",
		success: Schema.Array(Schema.String),
	}),
)

// Served only while a TodoStore exists: the plugin is Pending without one.
export default tools({
	name: "@graftland/sample-mcp-tools/plugins/todo",
	toolkit: TodoTools,
	inject: [TodoStore],
	handlers: Effect.map(TodoStore, (store) =>
		TodoTools.of({
			add_todo: ({ title }) => Effect.as(store.add(title), `Added ${title}`),
			list_todos: () => store.list,
		}),
	),
})
