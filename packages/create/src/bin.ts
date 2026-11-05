#!/usr/bin/env node
/**
 * The executable run by `npm create @graftland`. Running this module starts
 * the program.
 */
import { Effect, Layer, Logger } from "effect"
import { Command } from "effect/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { version } from "../package.json" with { type: "json" }
import { command } from "./Command"

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(NodeServices.layer)
			return yield* Command.run(command, { version }).pipe(
				Effect.provideContext(context),
			)
		}),
	).pipe(Effect.provideService(Logger.LogToStderr, true)),
)
