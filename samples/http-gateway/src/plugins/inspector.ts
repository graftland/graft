import { Array, Effect, Option, Stream, String } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { Graft, Plugin, type Fork } from "@graftland/graft"
import * as Http from "@graftland/plugin-http/Http"

const render = (tree: Fork.ForkTree, depth: number): ReadonlyArray<string> => [
	`${String.repeat(depth)("  ")}${tree.name} #${tree.id}: ${tree.state._tag}${
		tree.state._tag === "Pending"
			? ` (waiting for ${Array.join(tree.state.missing, ", ")})`
			: ""
	}`,
	...Array.flatMap(tree.children, (child) => render(child, depth + 1)),
]

/** `GET /_graft` shows the live plugin tree, with each fork's state. */
export default Plugin.make({
	name: "@graftland/sample-http-gateway/plugins/inspector",
	apply: () =>
		Http.mount(
			HttpRouter.add(
				"GET",
				"/_graft",
				Effect.map(Stream.runHead(Graft.forks), (trees) =>
					HttpServerResponse.text(
						`${Array.join(
							Array.flatMap(
								Option.getOrElse(trees, () => []),
								(tree) => render(tree, 0),
							),
							"\n",
						)}\n`,
					),
				),
			),
		).pipe(Effect.asVoid),
})
