import { Event, Graft, type Fork, type Plugin } from "@graftland/graft"
import { Context, Effect, References, type Scope } from "effect"
import { ready } from "./lifecycle.ts"
import {
	NoteRequest,
	NoteStore,
	Plan,
	Tenant,
	type Command,
} from "./services.ts"
import { tenant } from "./tenant.ts"

export interface TenantConfig {
	readonly id: string
	readonly plan: "free" | "pro"
	readonly file: string
}

export const onboard: (
	config: TenantConfig,
) => Effect.Effect<
	Fork.Fork<Plugin.InputOf<typeof tenant>, Plugin.ErrorOf<typeof tenant>>,
	Plugin.ErrorOf<typeof tenant>,
	Graft.Graft | Scope.Scope
> = Effect.fn("onboard")(function* (config: TenantConfig) {
	const fork = yield* Graft.plugin(
		tenant,
		{ file: config.file },
		{
			isolate: [NoteStore],
			intercept: [
				Graft.intercept(Tenant, () => config.id),
				Graft.intercept(Plan, () => config.plan),
				Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
					...outer,
					tenant: config.id,
				})),
			],
		},
	)
	yield* ready(fork)
	return fork
})

// The trusted request boundary selects a tenant; business operations never take its ID.
export const request = (id: string, command: Command) =>
	Event.bail(NoteRequest, command).pipe(
		Event.filtered((owner) => Context.get(owner, Tenant) === id),
	)
