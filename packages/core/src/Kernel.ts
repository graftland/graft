/** Kernel control is separate from the embedded plugin runtime. */
import {
	Array,
	Cause,
	Clock,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Random,
	Schema,
	Stream,
} from "effect"

import * as Core from "./internal/decisionCore"
import * as Interpreter from "./internal/kernel"
import { UnknownChange } from "./internal/observation"
import { UnitControl } from "./internal/unitControl"

export { deploymentIdentity } from "./internal/deploymentIdentity"

export { UnknownChange } from "./internal/observation"

export type {
	MemberDeclaration,
	RealmDeclaration,
	PlacementRequirement,
	LocalRequirement,
	ResourceDeclaration,
	ResolvedDependency,
	DeploymentGroup,
	GraphProposal,
	GroupPlan,
	SelectionReason,
	UnitMember,
	MemberExecution,
	MemberIdentity,
	MemberGeneration,
	MemberSignal,
	MemberOperation,
	CallMessage,
	CallMemberIdentity,
	CallEvidence,
	CallFact,
	CallControl,
	CallLimits,
	CallWaiter,
	Input as Request,
	InspectionInput,
	DeploymentOperation,
	Target,
	Budget,
	Requirements,
	Status,
	Completion,
	MemberAttempt,
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
	ConfigurationModule,
	ResolvedInput,
	Description,
	BindingDeclaration,
	FixedBinding,
	Endpoint,
	BindingRoute,
	BindingFault,
	RouteView,
	PreparationPhase,
	PreparationStatus,
	PreparationResult,
	Policy,
	Unit,
	RecordStage,
	RecordingDeclaration,
	RecordingPolicy,
	RecorderGrant,
	RecordFact,
	PriorChange,
	PriorKey,
	RecordPayload,
	RecoveredRecords,
	RecordDuty,
	RecordingStatus,
	RecordingSignal,
	SupervisionDeclaration,
	SupervisionPolicy,
	Supervision,
	PendingRestart,
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
	readonly callLimits?: Partial<Core.CallLimits>
	readonly bindings?: ReadonlyArray<Core.FixedBinding>
	/** Requires an acknowledged record at each stage of Changes that touch the scoped instances. */
	readonly recording?: Core.RecordingDeclaration
	/** Bounds supervisor restarts; defaults to 3 attempts per 60 000 ms. */
	readonly supervision?: Core.SupervisionDeclaration
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
		readonly await: (
			id: string,
		) => Effect.Effect<Core.Conclusion, UnknownChange>
		readonly cancel: (id: string) => Effect.Effect<void>
		readonly waiters: Effect.Effect<ReadonlyArray<Core.CallWaiter>>
		readonly calls: Effect.Effect<ReadonlyArray<Core.CallFact>>
		readonly callChanges: Stream.Stream<Core.CallFact>
		readonly submit: (
			request: Core.Input,
		) => Effect.Effect<Handle, ChangeRejected>
		readonly get: (id: string) => Effect.Effect<Option.Option<Core.Status>>
		readonly changes: Stream.Stream<Core.Status>
		readonly inspect: (
			request: Core.InspectionInput,
		) => Effect.Effect<Core.PreparationStatus, ChangeRejected>
		readonly getPreparation: (
			id: string,
		) => Effect.Effect<Option.Option<Core.PreparationStatus>>
		readonly preparations: Stream.Stream<Core.PreparationStatus>
		readonly inspections: Effect.Effect<ReadonlyArray<Core.PreparationStatus>>
		readonly units: Effect.Effect<ReadonlyArray<Core.Unit>>
		/** Supervisor facts per instance: recent attempted restarts and whether it was escalated. */
		readonly supervision: Effect.Effect<
			ReadonlyArray<{ readonly instance: string } & Core.Supervision>
		>
		/** The current recording grant and every duty not yet acknowledged, including those of ended owners. */
		readonly recording: Effect.Effect<{
			readonly grant: Option.Option<Core.RecorderGrant>
			readonly outstanding: ReadonlyArray<Core.RecordDuty>
		}>
		/** Sets reference values and, when `allowed` is given, the target identities the instance may run. */
		readonly setPolicy: (policy: {
			readonly instance: string
			readonly allowed?: ReadonlyArray<string>
			/** When given, whether this instance may only run sandboxed Process targets. */
			readonly sandbox?: boolean
			readonly values: Readonly<Record<string, Schema.Json>>
		}) => Effect.Effect<void>
		/**
		 * Declares the recording role for a kernel started without one. The same role
		 * again is accepted; a different one fails with `RecordingConflict`.
		 */
		readonly declareRecording: (
			declaration: Core.RecordingDeclaration,
		) => Effect.Effect<void, ChangeRejected>
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
			// Change ids restart in every run, so durable records carry the run as well.
			const started = yield* Clock.currentTimeMillis
			const salt = yield* Random.nextIntBetween(0, 2 ** 31)
			const run = `${started.toString(36)}-${salt.toString(36)}`
			const controller = yield* Interpreter.make(
				Core.empty({ ...deployment, run }),
			)
			return Kernel.of({
				await: controller.await,
				cancel: (id) =>
					controller.time.pipe(
						Effect.flatMap((now) =>
							controller.apply({
								_tag: "Cancel",
								change: id,
								cause: Cause.fail("Cancelled"),
								now,
							}),
						),
						Effect.asVoid,
					),
				waiters: controller.waiters,
				calls: controller.calls,
				callChanges: controller.callChanges,
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
				supervision: Effect.map(controller.snapshot, (s) =>
					Array.map(Array.fromIterable(s.supervision), ([instance, fact]) => ({
						instance,
						...fact,
					})),
				),
				recording: Effect.map(controller.snapshot, (s) => ({
					grant: s.recorder,
					outstanding: Array.filter(
						Array.fromIterable(HashMap.values(s.records)),
						(duty) => !duty.acknowledged,
					),
				})),
				declareRecording: Effect.fnUntraced(function* (
					declaration: Core.RecordingDeclaration,
				) {
					const now = yield* controller.time
					const reply = yield* controller.apply({
						_tag: "RecordingDeclared",
						declaration,
						now,
					})
					if (reply._tag === "Rejected")
						return yield* ChangeRejected.make({
							reason: reply.reason,
							conflicts: Array.fromIterable(reply.conflicts),
						})
				}),
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
				inspect: Effect.fnUntraced(function* (request: Core.InspectionInput) {
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
