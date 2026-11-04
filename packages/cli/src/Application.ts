import { ProtocolStdio } from "./internal/protocolOutput"
import { NodeServices } from "@effect/platform-node"
import {
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Stdio,
	Scope,
} from "effect"
import { Digest, SecureRandom, Signature } from "effect/crypto"
import { FetchHttpClient } from "effect/http"

/** Set before argument parsing when stdout belongs to a byte protocol. */
export const ProtocolOutput = Context.Reference(
	"@graftland/cli/ProtocolOutput",
	{ defaultValue: () => false },
)

/** An application requested a failed process exit, preserving its original cause. */
export class ApplicationError extends Schema.TaggedError<
	ApplicationError,
	{ readonly brand: unique symbol }
>()("ApplicationError", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

/** Applications can request process completion and report cleanup independently of loader diagnostics. */
export class Application extends Context.Service<
	Application,
	{
		/** Exclusively reserves the process protocol channel until the caller releases its scope. */
		readonly claimProtocol: Effect.Effect<void, ApplicationError, Scope.Scope>
		readonly finish: (exit: Exit.Exit<void, unknown>) => Effect.Effect<void>
		readonly onExit: (release: Effect.Effect<void>) => Effect.Effect<void>
	}
>()("@graftland/cli/Application") {}

/** Node capabilities shared by application and command hosts. */
export const platform = Layer.mergeAll(
	Layer.effect(
		Stdio.Stdio,
		Effect.gen(function* () {
			const reserved = yield* ProtocolStdio
			return Option.isSome(reserved) ? reserved.value : yield* Stdio.Stdio
		}),
	).pipe(Layer.provideMerge(NodeServices.layer)),
	FetchHttpClient.layer,
	Digest.layerWebCrypto,
	SecureRandom.layerWebCrypto,
	Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto)),
)
