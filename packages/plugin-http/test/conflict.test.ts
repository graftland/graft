import { Array, Cause, Effect, Exit, String } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import * as Http from "../src/Http.ts"
import { logs, logText, request, run, start } from "./utils.ts"

const routes = (name: string, entries: ReadonlyArray<Http.Route>) =>
	Plugin.make({
		name,
		apply: () =>
			Http.mount(
				HttpRouter.addAll(
					Array.map(entries, ({ method, path }) =>
						HttpRouter.route(method, path, HttpServerResponse.text(name)),
					),
				),
			).pipe(Effect.asVoid),
	})

it.live("excludes every conflicting mount and restores a survivor", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const a = yield* Graft.plugin(
			routes("a", [
				{ method: "GET", path: "/x" },
				{ method: "GET", path: "/only-a" },
			]),
		)
		yield* a.await
		const b = yield* Graft.plugin(routes("b", [{ method: "GET", path: "/x" }]))
		yield* b.await
		assert.strictEqual((yield* request(`${url}/x`)).status, 404)
		assert.strictEqual((yield* request(`${url}/only-a`)).status, 404)
		const entries = yield* logs
		assert.isTrue(
			Array.some(
				entries,
				(entry) =>
					entry.level === "Warn" &&
					String.includes("Several plugins mount GET /x")(logText(entry)),
			),
		)
		yield* b.dispose
		assert.strictEqual((yield* request(`${url}/x`)).text, "a")
		assert.strictEqual((yield* request(`${url}/only-a`)).text, "a")
	}).pipe(run),
)

for (const [a, b, path, conflict] of [
	[
		{ method: "GET", path: "/a/:id" },
		{ method: "GET", path: "/a/:name" },
		"/a/42",
		true,
	],
	[{ method: "GET", path: "/*" }, { method: "GET", path: "/x" }, "/x", false],
	[{ method: "*", path: "/x" }, { method: "GET", path: "/x" }, "/x", true],
] as const)
	it.live(
		`matches router conflicts for ${a.method} ${a.path} and ${b.method} ${b.path}`,
		() =>
			Effect.gen(function* () {
				const { url } = yield* start
				const left = yield* Graft.plugin(routes("a", [a]))
				yield* left.await
				const right = yield* Graft.plugin(routes("b", [b]))
				yield* right.await
				assert.strictEqual(
					(yield* request(`${url}${path}`)).status,
					conflict ? 404 : 200,
				)
				if (!conflict)
					assert.strictEqual((yield* request(`${url}/other`)).text, "a")
			}).pipe(run),
	)

it.live("fails apply for duplicate routes within a mount", () =>
	Effect.gen(function* () {
		const { url } = yield* start
		const fork = yield* Graft.plugin(
			routes("duplicate", [
				{ method: "GET", path: "/x" },
				{ method: "GET", path: "/x" },
			]),
		)
		const exit = yield* Effect.exit(fork.await)
		assert.isTrue(Exit.isFailure(exit))
		if (Exit.isFailure(exit))
			assert.include(Cause.pretty(exit.cause), "already declared")
		assert.strictEqual((yield* request(`${url}/x`)).status, 404)
	}).pipe(run),
)
