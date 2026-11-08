/** Submit, await and observe Changes owned by a kernel. */
import { Effect, Stream, type Option } from "effect"

import {
	Kernel,
	type ChangeRejected,
	type Conclusion,
	type Handle,
	type Request,
	type Status,
} from "./Kernel"

export type {
	Request,
	Handle,
	Status,
	Conclusion,
	Outcome,
	MemberAttempt,
	MemberFact,
	Budget,
	Requirements,
	Target,
	Phase,
	Strategy,
	Placement,
	Cleanup,
	Settlement,
} from "./Kernel"
export { ChangeRejected } from "./Kernel"

export const submit = (
	request: Request,
): Effect.Effect<Handle, ChangeRejected, Kernel> =>
	Effect.flatMap(Kernel, (kernel) => kernel.submit(request))
export const run = (
	request: Request,
): Effect.Effect<Conclusion, ChangeRejected, Kernel> =>
	submit(request).pipe(Effect.flatMap((handle) => handle.await))
export const get = (
	id: string,
): Effect.Effect<Option.Option<Status>, never, Kernel> =>
	Effect.flatMap(Kernel, (kernel) => kernel.get(id))
export const changes: Stream.Stream<Status, never, Kernel> = Stream.unwrap(
	Effect.map(Kernel, (kernel) => kernel.changes),
)
