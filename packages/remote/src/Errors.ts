import { Option, Schema } from "effect"

export class ProcessExited extends Schema.TaggedError<
	ProcessExited,
	{ readonly brand: unique symbol }
>()("ProcessExited", {
	pid: Schema.Option(Schema.Int),
	threadId: Schema.optionalKey(Schema.Int),
	exitCode: Schema.NullOr(Schema.Int),
	stderr: Schema.String,
	statusCause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {
	override get message() {
		return this.threadId !== undefined
			? `Remote worker ${this.threadId} exited unexpectedly (${this.exitCode})`
			: `Remote process${Option.isSome(this.pid) ? ` ${this.pid.value}` : ""} exited unexpectedly (${this.exitCode ?? "signal"})`
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

/** A network execution needs a stable logical identity across host restarts. */
export class MissingInstance extends Schema.TaggedError<
	MissingInstance,
	{ readonly brand: unique symbol }
>()("MissingInstance", {}) {
	override get message() {
		return "A runner connection requires an instance or a loader entry id; set connect.instance when loading without Loader."
	}
}

/** Dispose completed, but Node still owns live handles; process-scope cleanup must terminate it. */
export class LocalTerminationTimeout extends Schema.TaggedError<
	LocalTerminationTimeout,
	{ readonly brand: unique symbol }
>()("LocalTerminationTimeout", {
	pid: Schema.optionalKey(Schema.Int),
	threadId: Schema.optionalKey(Schema.Int),
}) {
	override get message() {
		return this.threadId !== undefined
			? `Remote worker ${this.threadId} did not exit within one second after Dispose; terminating it`
			: `Remote process ${this.pid} did not exit within one second after Dispose; terminating it`
	}
}

/** A credential source failed; the original failure remains available. */
export class CredentialsError extends Schema.TaggedError<
	CredentialsError,
	{ readonly brand: unique symbol }
>()("CredentialsError", {
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {}

export class AuthenticationFailed extends Schema.TaggedError<
	AuthenticationFailed,
	{ readonly brand: unique symbol }
>()("AuthenticationFailed", {
	reason: Schema.Literals(["missing", "invalid"]),
	challenge: Schema.optionalKey(Schema.String),
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
}) {}

/** A remote entry could not be resolved or configured at the indicated field. */
export class RemoteEntryError extends Schema.TaggedError<
	RemoteEntryError,
	{ readonly brand: unique symbol }
>()("RemoteEntryError", {
	entry: Schema.Option(Schema.String),
	directory: Schema.Option(Schema.String),
	field: Schema.String,
	cause: Schema.Cause(Schema.Unknown, Schema.Unknown),
}) {
	override get message() {
		return `Remote entry ${Option.getOrElse(this.entry, () => "<programmatic>")} failed at ${this.field}`
	}
}
