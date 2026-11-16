import { Context, Effect, Layer, Schedule, Schema, Scope } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcServer from "effect/rpc/RpcServer"

import { Remote } from "@graftland/graft/rpc"

class Pricing extends Context.Service<
	Pricing,
	{ readonly quote: (sku: string) => Effect.Effect<number> }
>()("fixture/Pricing") {}

const Quote = Rpc.make("Quote", {
	payload: Schema.Struct({ sku: Schema.String }),
	success: Schema.Finite,
})

const group = RpcGroup.make(Quote)

export const pricing = Remote.service(Pricing, group, {
	toHandlers: (pricing) => ({
		Quote: ({ sku }: { readonly sku: string }) =>
			pricing.quote(sku).pipe(Effect.orDie),
	}),
	fromClient: (client) => ({
		quote: (sku) => client.Quote({ sku }).pipe(Effect.orDie),
	}),
})

export const serve = (protocol: Layer.Layer<RpcServer.Protocol>) =>
	Remote.serve({ services: [pricing], protocol })

export const connect = (
	protocol: Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope>,
) =>
	Remote.connect({
		services: [pricing],
		protocol,
		retry: Schedule.exponential("100 millis"),
	})

export const any = (service: Remote.AnyRemoteService) => service.prefix
export const unavailable = (error: Remote.RemoteUnavailable) => error
