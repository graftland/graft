#!/usr/bin/env node
/** The graft-remote executable owns the local runner runtime. */
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Console, Effect } from "effect"
import process from "node:process"
import { load, run } from "./Runner"

NodeRuntime.runMain(
	Effect.suspend(() => {
		const [, , specifier, session = "local", ...rest] = process.argv
		if (specifier === undefined || rest.length !== 0)
			return Effect.die(
				new Error("Usage: graft-remote <contract-module-specifier> [session]"),
			)
		return load(specifier).pipe(
			Effect.flatMap((contract) => run(contract, session)),
		)
	}).pipe(Effect.tapCause((cause) => Console.error(Cause.pretty(cause)))),
)
