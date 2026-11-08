import { Array } from "effect"

import type { ConfigurationModule, DeploymentData } from "./decisionState"

const configurationIdentity = (
	modules: ReadonlyArray<ConfigurationModule>,
): string =>
	Array.join(
		Array.map(modules, (module) =>
			Array.join(
				Array.map(
					[
						module.artifact.identity.digest,
						module.artifact.identity.module,
						module.export,
					],
					(field) => `${field.length}:${field}`,
				),
				"",
			),
		),
		"",
	)

/** Binds the complete ordered executable module selection to authorization. */
export const deploymentIdentity = (deployment: DeploymentData): string =>
	`sha256-v1:${deployment.artifact.identity.digest}:${deployment.contractArtifact?.identity.digest ?? deployment.artifact.identity.digest}:${(deployment.module ?? deployment.artifact.identity.module).length}:${deployment.module ?? deployment.artifact.identity.module}:${deployment.contract?.length ?? 0}:${deployment.contract ?? ""}:${deployment.inspection ?? "Execution"}:${deployment.moduleKind ?? "Plugin"}:${deployment.moduleSuffix?.length ?? 0}:${deployment.moduleSuffix ?? ""}:environment:${configurationIdentity(deployment.environment ?? [])}${deployment.confinement === "Sandbox" ? ":sandbox" : ""}`
