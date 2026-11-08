/** Native units use data-only deployments and the kernel control protocol. */
import type { Schema } from "effect"

import type { Kernel } from "@graftland/graft"

import type * as Artifact from "./Artifact"

export { layer } from "./internal/nativeControl"
export interface TargetOptions {
	readonly artifact: Artifact.Artifact
	readonly contractArtifact?: Artifact.Artifact
	readonly contract?: string
	readonly input: Schema.Json
	readonly placement: Kernel.Placement
	readonly runner?: { readonly socket: string; readonly owner: string }
}
/** Selects captured bytes. Description and decoding take place inside an inspection unit. */
export const target = (options: TargetOptions): Kernel.Target => ({
	identity: `sha256-v1:${options.artifact.identity.digest}:${options.contractArtifact?.identity.digest ?? options.artifact.identity.digest}:${options.artifact.identity.entry.length}:${options.artifact.identity.entry}:${options.contract?.length ?? 0}:${options.contract ?? ""}`,
	placement: options.placement,
	overlap: false,
	deployment: {
		artifact: options.artifact,
		...(options.contractArtifact === undefined
			? {}
			: { contractArtifact: options.contractArtifact }),
		...(options.contract === undefined ? {} : { contract: options.contract }),
		input: options.input,
		...(options.runner === undefined ? {} : { runner: options.runner }),
	},
})

export {
	serveRunner,
	type RunnerAddress,
	type RunnerOwner,
} from "./internal/runnerOwner"
