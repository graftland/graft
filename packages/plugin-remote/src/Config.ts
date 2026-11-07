/** Configuration schemas for remote entries and their built-in capabilities. */
import { Effect, Schema } from "effect"

import * as Artifact from "./Artifact"
import * as Auth from "./internal/auth/config"
import { CandidateOptions } from "./internal/candidate"
import { PositiveDuration } from "./internal/config"

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
const authentication = <
	M extends Schema.Top,
	B extends Schema.Top,
	J extends Schema.Top,
	N extends Schema.Top,
>(schemas: {
	readonly mtls: M
	readonly bearer: B
	readonly jwt: J
	readonly none: N
}) =>
	Schema.Union([
		Schema.Struct({
			...authFields,
			name: Schema.String,
			config: Schema.optionalKey(Schema.Unknown),
		}),
		Schema.Struct({ ...authFields, mtls: schemas.mtls }),
		Schema.Struct({ ...authFields, bearer: schemas.bearer }),
		Schema.Struct({ ...authFields, jwt: schemas.jwt }),
		Schema.Struct({ ...authFields, none: schemas.none }),
	])
export const Authentication = authentication({
	mtls: Auth.Certificate,
	bearer: Auth.Token,
	jwt: Auth.Token,
	none: Auth.None,
})
export const RunnerAuthentication = authentication({
	mtls: Auth.Mtls,
	bearer: Auth.Bearer,
	jwt: Schema.toEncoded(Auth.Jwt),
	none: Auth.None,
})
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
		auth: Schema.optionalKey(RunnerAuthentication),
		url: Schema.String.check(Schema.isStartingWith("ws://")),
		cert: absent,
		key: absent,
	}),
	Schema.Struct({
		...transportFields,
		auth: Schema.optionalKey(RunnerAuthentication),
		url: Schema.String.check(Schema.isStartingWith("wss://")),
		cert: Schema.String,
		key: Schema.String,
	}),
	Schema.Struct({
		...transportFields,
		auth: Schema.optionalKey(RunnerAuthentication),
		unix: Schema.String,
	}),
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
	Schema.Struct({
		...transportFields,
		auth: Schema.optionalKey(RunnerAuthentication),
		transport: Reference,
	}),
])
export type Listen = typeof Listen.Type
export const OrdinaryHost = Schema.Struct({
	artifact: absent,
	target: absent,
	probes: absent,
	maxInFlight: absent,
	contract: Schema.String,
	implementation: Schema.NonEmptyString,
	connect: Connect,
	config: Schema.Json.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
})
/** A pinned direct deployment. Its instance name comes from the Loader entry id. */
export const ManagedHost = Schema.Struct({
	implementation: absent,
	connect: absent,
	contract: Schema.String,
	artifact: Artifact.Artifact,
	target: CandidateOptions.fields.target,
	config: Schema.Json.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	probes: Schema.optionalKey(Schema.Array(Schema.String)),
	maxInFlight: Schema.optionalKey(
		Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
	),
})
export const Host = Schema.Union([ManagedHost, OrdinaryHost])
export const Runner = Schema.Struct({
	root: Schema.String,
	state: Schema.String,
	lease: Schema.optionalKey(PositiveDuration),
	grace: Schema.optionalKey(PositiveDuration),
	listen: Schema.Array(Listen),
})

/** The command plugin has no business configuration. */
export const Cli = Schema.Struct({})
