/** Native units use data-only deployments and the kernel control protocol. */
import type { Schema } from "effect"

import { Kernel } from "@graftland/graft"

import type * as Artifact from "./Artifact"

export { layer } from "./internal/nativeControl"
export interface TargetOptions {
	readonly environment?: ReadonlyArray<Kernel.ConfigurationModule>
	readonly moduleSuffix?: string
	readonly inspection?: "Module"
	readonly moduleKind?: "Environment" | "Resolver"
	readonly artifact: Artifact.Artifact
	readonly contractArtifact?: Artifact.Artifact
	readonly contract?: string
	readonly input: Schema.Json
	readonly placement: Kernel.Placement
	readonly runner?: { readonly socket: string; readonly owner: string }
}
/** Selects captured bytes. Description and decoding take place inside an inspection unit. */
export const target = (options: TargetOptions): Kernel.Target => {
	const deployment: Kernel.DeploymentData = {
		...(options.moduleKind === undefined
			? {}
			: { moduleKind: options.moduleKind }),
		...(options.environment === undefined
			? {}
			: { environment: options.environment }),
		...(options.moduleSuffix === undefined
			? {}
			: { moduleSuffix: options.moduleSuffix }),
		...(options.inspection === undefined
			? {}
			: { inspection: options.inspection }),
		artifact: options.artifact,
		...(options.contractArtifact === undefined
			? {}
			: { contractArtifact: options.contractArtifact }),
		...(options.contract === undefined ? {} : { contract: options.contract }),
		input: options.input,
		...(options.runner === undefined ? {} : { runner: options.runner }),
	}
	return {
		identity: Kernel.deploymentIdentity(deployment),
		placement: options.placement,
		overlap: false,
		deployment,
	}
}

export {
	serveRunner,
	type RunnerAddress,
	type RunnerOwner,
} from "./internal/runnerOwner"
