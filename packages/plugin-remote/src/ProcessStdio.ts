/** The kernel's process stdio, lent to one plugin in one unit at a time. */
import { Context, Schema, type Effect, type Scope, type Stdio } from "effect"

/** The kernel was started without protocol stdio, or another live unit holds it. */
export class StdioDenied extends Schema.TaggedError<
	StdioDenied,
	{ readonly brand: unique symbol }
>()("StdioDenied", {}) {}

export class ProcessStdio extends Context.Service<
	ProcessStdio,
	{
		/**
		 * Claims the kernel's stdin and stdout until the scope closes. Ending the
		 * returned stdout ends the kernel's stdout. Input sent while no unit holds
		 * the stdio waits for the next holder.
		 */
		readonly claim: Effect.Effect<Stdio.Stdio, StdioDenied, Scope.Scope>
	}
>()("@graftland/plugin-remote/ProcessStdio") {}
