/** Native units use data-only deployments and the kernel control protocol. */
import type { Schema } from "effect"

import { Kernel } from "@graftland/graft"

import type * as Artifact from "./Artifact"

export { layer } from "./internal/nativeControl"
/** Lends the kernel's stdio to the unit that claims it through `ProcessStdio`. Provide it before `layer`. */
export {
	layer as stdio,
	StdioBridge,
	type Bridge,
	type Holder,
	type Input as StdioInput,
} from "./internal/stdioBridge"
export interface TargetOptions {
	readonly module?: string
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
	/** `Sandbox` runs a Process unit under Linux bubblewrap; elsewhere the unit does not start. */
	readonly confinement?: "Sandbox"
}
/** Selects captured bytes. Description and decoding take place inside an inspection unit. */
export const target = (options: TargetOptions): Kernel.Target => {
	const deployment: Kernel.DeploymentData = {
		...(options.module === undefined ? {} : { module: options.module }),
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
		...(options.confinement === undefined
			? {}
			: { confinement: options.confinement }),
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
