import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { crypto, issue } from "./credentials.ts"

// Generates demo credentials without starting a runner or a host.
NodeRuntime.runMain(
	Config.String("CREDENTIALS_DIR").pipe(
		Effect.flatMap(issue),
		Effect.asVoid,
		Effect.provide(Layer.merge(NodeServices.layer, crypto)),
	),
)
