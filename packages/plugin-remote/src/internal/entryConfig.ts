import {
	Reference,
	RunnerAuthentication,
	type Authentication,
	type Connect,
	type Listen,
} from "../Config"

export * from "../Config"
const capability = (
	side: "host" | "runner",
	name: string,
	config: unknown,
): Reference => ({ name: `@graftland/plugin-remote/${side}/${name}`, config })
export const authentication = (
	side: "host" | "runner",
	input:
		typeof Authentication.Type | typeof RunnerAuthentication.Type | undefined,
): Reference => {
	if (input === undefined) return capability(side, "auth/none", {})
	if (input.name !== undefined) return input
	if (input.mtls !== undefined) return capability(side, "auth/mtls", input.mtls)
	if (input.bearer !== undefined)
		return capability(side, "auth/bearer", input.bearer)
	if (input.jwt !== undefined) return capability(side, "auth/jwt", input.jwt)
	return capability(side, "auth/none", input.none)
}
export const hostTransport = (
	input: Exclude<
		Connect,
		{ readonly local: object } | { readonly worker: object }
	>,
): Reference => {
	if (input.transport !== undefined) return input.transport
	if (input.url !== undefined)
		return capability("host", "websocket", {
			url: input.url,
			...(input.ca === undefined ? {} : { ca: input.ca }),
			...(input.servername === undefined
				? {}
				: { servername: input.servername }),
		})
	if (input.unix !== undefined)
		return capability("host", "unix", { path: input.unix })
	return capability("host", "command", {
		argv: input.command,
		...("cwd" in input && input.cwd !== undefined ? { cwd: input.cwd } : {}),
		...("env" in input && input.env !== undefined ? { env: input.env } : {}),
	})
}
export const runnerTransport = (input: Listen): Reference => {
	if (input.transport !== undefined) return input.transport
	if (input.url !== undefined)
		return capability("runner", "websocket", {
			url: input.url,
			...(input.cert === undefined ? {} : { cert: input.cert }),
			...(input.key === undefined ? {} : { key: input.key }),
		})
	if (input.unix !== undefined)
		return capability("runner", "unix", { path: input.unix })
	return capability("runner", "stdio", {})
}
export const runnerAuthentication = (input: Listen): Reference =>
	input.stdio !== undefined
		? capability("runner", "auth/none", {
				identity: input.identity ?? "anonymous",
			})
		: authentication("runner", input.auth)
