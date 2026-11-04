import { Plugin } from "@graftland/graft"
import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/http"
import { route } from "../Gateway.ts"
import { TodoStore } from "../TodoStore.ts"

const NewTodo = Schema.Struct({ title: Schema.String })

/**
 * `GET /todos` and `POST /todos`. They need a `TodoStore`; while none is
 * loaded, this plugin is `Pending` and the routes answer 404.
 */
export default Plugin.make({
	name: "todos",
	inject: [TodoStore],
	apply: Effect.fn("todos.apply")(function* () {
		const store = yield* TodoStore
		yield* route("GET", "/todos", () =>
			Effect.flatMap(store.list, (todos) =>
				HttpServerResponse.json(todos),
			).pipe(Effect.orDie),
		)
		yield* route("POST", "/todos", (request) =>
			request.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(NewTodo)),
				Effect.flatMap(({ title }) =>
					store.add(title).pipe(
						Effect.flatMap((todo) =>
							HttpServerResponse.json(todo, { status: 201 }),
						),
						Effect.orDie,
					),
				),
				// Only a body that cannot be read or decoded is the client's fault.
				Effect.catchTag(["HttpServerError", "SchemaError"], () =>
					Effect.succeed(
						HttpServerResponse.text('Expected {"title": "..."}\n', {
							status: 400,
						}),
					),
				),
			),
		)
	}),
})
