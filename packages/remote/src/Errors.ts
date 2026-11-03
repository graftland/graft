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
