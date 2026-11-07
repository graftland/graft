/** Revocation and policy closure wait at most five seconds per unit, with four concurrent retirements. */
export const termination = Object.freeze({
	timeout: "5 seconds",
	concurrency: 4,
} as const)
