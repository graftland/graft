import { Schema } from "effect"

export class ProcessExited extends Schema.TaggedError<
	ProcessExited,
	{ readonly brand: unique symbol }
>()("ProcessExited", {
	pid: Schema.Int,
	exitCode: Schema.NullOr(Schema.Int),
	stderr: Schema.String,
	statusCause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {
	override get message() {
		return `Remote process ${this.pid} exited unexpectedly (${this.exitCode ?? "signal"})`
	}
}
export class TransportError extends Schema.TaggedError<
	TransportError,
	{ readonly brand: unique symbol }
>()("TransportError", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

/** The remote export lease was withdrawn; host consumers must drain before Dispose. */
export class RemoteWithdrawn extends Schema.TaggedError<
	RemoteWithdrawn,
	{ readonly brand: unique symbol }
>()("RemoteWithdrawn", {}) {
	override get message() {
		return "Remote services were withdrawn"
	}
}

/** Infrastructure failure at the plugin boundary; the complete underlying cause remains inspectable. */
export class RemoteError extends Schema.TaggedError<
	RemoteError,
	{ readonly brand: unique symbol }
>()("RemoteError", { cause: Schema.Cause(Schema.Unknown, Schema.Unknown) }) {}
