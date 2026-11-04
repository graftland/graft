import { Effect, Schema } from "effect"
import { PositiveDuration } from "./config"

export const Reference = Schema.Struct({
	name: Schema.String,
	config: Schema.optionalKey(Schema.Unknown),
})
export type Reference = typeof Reference.Type
const absent = Schema.optionalKey(Schema.Never)
const authFields = {
	name: absent,
	config: absent,
	mtls: absent,
	bearer: absent,
	jwt: absent,
	none: absent,
}
export const Authentication = Schema.Union([
	Schema.Struct({
		...authFields,
		name: Schema.String,
		config: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({ ...authFields, mtls: Schema.Unknown }),
	Schema.Struct({ ...authFields, bearer: Schema.Unknown }),
	Schema.Struct({ ...authFields, jwt: Schema.Unknown }),
	Schema.Struct({ ...authFields, none: Schema.Unknown }),
])
const transportFields = {
	url: absent,
	unix: absent,
	command: absent,
	stdio: absent,
	local: absent,
	worker: absent,
	transport: absent,
}
const auth = Schema.optionalKey(Authentication)
const common = {
	instance: Schema.optionalKey(Schema.String),
	lease: Schema.optionalKey(PositiveDuration),
	margin: Schema.optionalKey(PositiveDuration),
	expect: Schema.optionalKey(
		Schema.Struct({
			version: Schema.optionalKey(Schema.String),
			digest: Schema.optionalKey(Schema.String),
		}),
	),
}
const network = {
	...transportFields,
	...common,
	auth,
	url: Schema.String,
	ca: Schema.optionalKey(Schema.String),
	servername: Schema.optionalKey(Schema.String),
}
export const Connect = Schema.Union([
	Schema.Struct(network),
	Schema.Struct({ ...transportFields, ...common, auth, unix: Schema.String }),
	Schema.Struct({
		...transportFields,
		...common,
		command: Schema.NonEmptyArray(Schema.String),
		auth: Schema.optionalKey(
			Schema.Never.annotate({
				message: "Direct and stdio transports do not accept auth",
			}),
		),
		cwd: Schema.optionalKey(Schema.String),
		env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	}),
	Schema.Struct({
		...transportFields,
		auth: Schema.optionalKey(
			Schema.Never.annotate({
				message: "Direct and stdio transports do not accept auth",
			}),
		),
		local: Schema.Struct({
			command: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
		}),
	}),
	Schema.Struct({
		...transportFields,
		auth: Schema.optionalKey(
			Schema.Never.annotate({
				message: "Direct and stdio transports do not accept auth",
			}),
		),
		worker: Schema.Struct({
			execArgv: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	}),
	Schema.Struct({ ...transportFields, ...common, auth, transport: Reference }),
])
export type Connect = typeof Connect.Type
export const Listen = Schema.Union([
	Schema.Struct({
		...transportFields,
		auth,
		url: Schema.String,
		cert: Schema.optionalKey(Schema.String),
		key: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({ ...transportFields, auth, unix: Schema.String }),
	Schema.Struct({
		...transportFields,
		stdio: Schema.Literal(true),
		auth: Schema.optionalKey(
			Schema.Never.annotate({
				message: "Direct and stdio transports do not accept auth",
			}),
		),
		identity: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({ ...transportFields, auth, transport: Reference }),
])
export type Listen = typeof Listen.Type
const capability = (
	side: "host" | "runner",
	name: string,
	config: unknown,
): Reference => ({ name: `@graftland/plugin-remote/${side}/${name}`, config })
export const authentication = (
	side: "host" | "runner",
	input: typeof Authentication.Type | undefined,
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
export const Host = Schema.Struct({
	contract: Schema.String,
	connect: Connect,
	config: Schema.Json.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
})
export const Runner = Schema.Struct({
	root: Schema.String,
	state: Schema.String,
	lease: Schema.optionalKey(PositiveDuration),
	grace: Schema.optionalKey(PositiveDuration),
	listen: Schema.Array(Listen),
})

export const runnerAuthentication = (input: Listen): Reference =>
	input.stdio !== undefined
		? capability("runner", "auth/none", {
				identity: input.identity ?? "anonymous",
			})
		: authentication("runner", input.auth)
