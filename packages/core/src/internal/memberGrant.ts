import { Array, Option } from "effect"

import * as Snapshot from "./decisionInput"
import type { MemberDeclaration, Request, UnitMember } from "./decisionState"

/** Encoded address and execution authority for a member, not its runtime state. */
export const requested = (
	request: Request,
	term: number,
	generation: number,
): UnitMember => ({
	instance: request.instance,
	declaration: "self",
	parent: Option.none(),
	realm: request.realm ?? "root",
	target: Snapshot.target(request.target),
	term,
	generation,
	colocate: Array.copy(request.colocate ?? []),
	placement:
		request.placement === undefined
			? request.target.placement === "Worker"
				? Option.none()
				: Option.some({
						kind: request.target.placement,
						...(request.target.deployment?.runner === undefined
							? {}
							: {
									destination: request.target.deployment.runner.socket,
									security: request.target.deployment.runner.owner,
								}),
					})
			: Option.some(Object.freeze({ ...request.placement })),
})
export const declared = (
	member: MemberDeclaration,
	term: number,
	generation: number,
): UnitMember => ({
	instance: member.instance,
	declaration: member.declaration,
	parent: member.parent,
	realm: member.realm,
	target: Snapshot.target(member.target),
	term,
	generation,
	colocate: Array.copy(member.colocate),
	placement: member.placement,
})
