/** The public contract for a subtree's trace exporter. */
import { Context, Schema, type Tracer } from "effect"

/** Publish one stable tracer; update its destination in place and flush on close. */
export class Exporter extends Context.Service<Exporter, Tracer.Tracer>()(
	"@graftland/plugin-otlp/Exporter",
) {}

/** A selected exporter failed; the original cause is retained. */
export class ExporterError extends Schema.TaggedError<
	ExporterError,
	{ readonly brand: unique symbol }
>()("ExporterError", { cause: Schema.Cause(Schema.Unknown, Schema.Unknown) }) {}
