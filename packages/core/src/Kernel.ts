/** Kernel control is separate from the embedded plugin runtime. */
import { Array, Context, Effect, Layer, Option, Schema, Stream } from "effect"

import * as Core from "./internal/decisionCore"
import * as Interpreter from "./internal/kernel"
import { UnitControl } from "./internal/unitControl"

export type {
	Input as Request,
	Target,
	Budget,
	Requirements,
	Status,
	MemberFact,
	Conclusion,
	Outcome,
	Phase,
	Strategy,
	Placement,
	Cleanup,
	Settlement,
	Token,
	Command,
	CommandKind,
	Report,
	Timer,
	TimerPurpose,
	Rejection,
	Reply,
} from "./internal/decisionState"
export { UnitControl } from "./internal/unitControl"
export class ChangeRejected extends Schema.TaggedError<
	ChangeRejected,
	{ readonly brand: unique symbol }
>()("ChangeRejected", {
	reason: Schema.String,
	conflicts: Schema.Array(Schema.String),
}) {}
export interface Handle {
	readonly id: string
	readonly await: Effect.Effect<Core.Conclusion>
	readonly cancel: Effect.Effect<void>
}
export interface Deployment {
	readonly authority: string
	readonly maxUnits: number
	readonly instances: ReadonlyArray<{
		readonly id: string
		readonly target: Core.Target
	}>
}
export class Kernel extends Context.Service<
	Kernel,
	{
		readonly submit: (
			request: Core.Input,
		) => Effect.Effect<Handle, ChangeRejected>
		readonly get: (id: string) => Effect.Effect<Option.Option<Core.Status>>
		readonly changes: Stream.Stream<Core.Status>
		readonly shutdown: Effect.Effect<void>
	}
>()("@graftland/graft/Kernel") {}

const submit = Effect.fnUntraced(function* (
	controller: Interpreter.Controller,
	request: Core.Input,
) {
	const result = yield* controller.submit(request)
	if (result.reply._tag === "Rejected")
		return yield* ChangeRejected.make({
			reason: result.reply.reason,
			conflicts: Array.fromIterable(result.reply.conflicts),
		})
	if (Option.isNone(result.completion))
		return yield* Effect.die(
			new Error("Admitted Change has no completion owner"),
		)
	return result.completion.value
})
/** Installs the fixed control interpreter; the placement layer supplies UnitControl. */
export const layer = (
	deployment: Deployment,
): Layer.Layer<Kernel, never, UnitControl> =>
	Layer.effect(
		Kernel,
		Effect.gen(function* () {
			const controller = yield* Interpreter.make(Core.empty(deployment))
			return Kernel.of({
				submit: (request) => submit(controller, request),
				get: controller.get,
				changes: controller.changes,
				shutdown: controller.shutdown,
			})
		}),
	)
