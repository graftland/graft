import process from "node:process"

import { Context, Effect, Layer, String } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import * as Sandbox from "../src/Sandbox"

it.live.skipIf(process.platform === "linux")(
	"fails closed when the Linux launcher is selected on an unsupported platform",
	() =>
		Effect.gen(function* () {
			const services = yield* Layer.build(Sandbox.linux)
			const launcher = Context.get(services, Sandbox.Launcher)
			const error = yield* launcher
				.prepare({
					artifact: {
						directory: "/unused",
						identity: {
							version: 1,
							algorithm: "sha256",
							digest: String.repeat(64)("a"),
							entry: "index.js",
						},
					},
					contractEntry: "contract.js",
				})
				.pipe(Effect.flip)
			assert.equal(error.reason, "LauncherUnavailable")
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
