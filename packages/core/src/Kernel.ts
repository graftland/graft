/** Kernel control is separate from the embedded plugin runtime. */
import {
	Array,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"

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
	ArtifactData,
	DeploymentData,
	ResolvedInput,
	Description,
	BindingDeclaration,
	PreparationPhase,
	PreparationStatus,
	PreparationResult,
	Policy,
	Unit,
} from "./internal/decisionState"
export type { UnitEvent } from "./internal/unitControl"
export { UnitControl } from "./internal/unitControl"
export class ChangeRejected extends Schema.TaggedError<
	ChangeRejected,
	{ readonly brand: unique symbol }
>()("ChangeRejected", {
	reason: Schema.String,
	conflicts: Schema.Array(Schema.String),
	cause: Schema.optionalKey(Schema.Cause(Schema.Unknown, Schema.Unknown)),
	preparation: Schema.optionalKey(Schema.String),
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
		readonly inspect: (
			request: Core.Input,
		) => Effect.Effect<Core.PreparationStatus, ChangeRejected>
		readonly getPreparation: (
			id: string,
		) => Effect.Effect<Option.Option<Core.PreparationStatus>>
		readonly preparations: Stream.Stream<Core.PreparationStatus>
		readonly inspections: Effect.Effect<ReadonlyArray<Core.PreparationStatus>>
		readonly units: Effect.Effect<ReadonlyArray<Core.Unit>>
		readonly setPolicy: (policy: {
			readonly instance: string
			readonly allowed: ReadonlyArray<string>
			readonly values: Readonly<Record<string, Schema.Json>>
		}) => Effect.Effect<void>
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
			...(result.reply.cause === undefined
				? {}
				: { cause: result.reply.cause }),
			...(result.reply.preparation === undefined
				? {}
				: { preparation: result.reply.preparation }),
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
				preparations: controller.preparations,
				getPreparation: controller.getPreparation,
				inspections: Effect.map(controller.snapshot, (s) =>
					Array.flatMap(
						Array.fromIterable(HashMap.keys(s.preparations)),
						(id) => Option.toArray(Core.getPreparation(s, id)),
					),
				),
				units: Effect.map(controller.snapshot, (s) =>
					Array.fromIterable(HashMap.values(s.units)),
				),
				setPolicy: (policy) =>
					controller.time.pipe(
						Effect.flatMap((now) =>
							controller.apply({
								_tag: "PolicyChanged",
								...policy,
								now,
							}),
						),
						Effect.asVoid,
					),
				inspect: Effect.fnUntraced(function* (request: Core.Input) {
					const result = yield* controller.inspect(request)
					if (result.reply._tag === "Rejected")
						return yield* ChangeRejected.make({
							reason: result.reply.reason,
							conflicts: Array.fromIterable(result.reply.conflicts),
							...(result.reply.cause === undefined
								? {}
								: { cause: result.reply.cause }),
							...(result.reply.preparation === undefined
								? {}
								: { preparation: result.reply.preparation }),
						})
					return yield* Effect.fromOption(result.inspection).pipe(Effect.orDie)
				}),
				shutdown: controller.shutdown,
			})
		}),
	)
