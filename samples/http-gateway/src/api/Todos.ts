import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

export class Todo extends Schema.Class<Todo, { readonly brand: unique symbol }>(
	"Todo",
)({ id: Schema.Int, title: Schema.String }) {}
export class TodoNotFound extends Schema.TaggedError<
	TodoNotFound,
	{ readonly brand: unique symbol }
>()("TodoNotFound", { id: Schema.Int }, { httpApiStatus: 404 }) {}
export const TodosGroup = HttpApiGroup.make("todos")
	.add(
		HttpApiEndpoint.get("list", "/", { success: Schema.Array(Todo) }),
		HttpApiEndpoint.post("create", "/", {
			payload: Schema.Struct({ title: Schema.String }),
			success: Todo.annotate({ httpApiStatus: 201 }),
		}),
		HttpApiEndpoint.get("get", "/:id", {
			params: { id: Schema.Int },
			success: Todo,
			error: TodoNotFound,
		}),
		HttpApiEndpoint.delete("remove", "/:id", {
			params: { id: Schema.Int },
			error: TodoNotFound,
		}),
	)
	.prefix("/todos")
export const Api = HttpApi.make("todo-api").add(TodosGroup)
