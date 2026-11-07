// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer requires a native server factory.
import { createServer } from "node:http"

import { ConfigProvider, Effect, Layer, Ref, String } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

import { Capabilities } from "../src/index"
import * as Policy from "../src/Policy"

it.live(
	"brokers credentials on the host and rejects redirects and foreign origins",
	() =>
		Effect.gen(function* () {
			const observed = yield* Ref.make("")
			const server = yield* NodeHttpServer.make(createServer, {
				host: "127.0.0.1",
				port: 0,
			})
			yield* server.serve(
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					yield* Ref.set(observed, request.headers["authorization"] ?? "")
					return request.url === "/redirect"
						? HttpServerResponse.redirect("http://127.0.0.1:1/")
						: HttpServerResponse.text("Authenticated response")
				}),
			)
			const port =
				server.address._tag !== "UnixPathAddress" ? server.address.port : 0
			const origin = "http://127.0.0.1:" + port
			const artifact = {
				package: "@example/client",
				digest: String.repeat(64)("a"),
			}
			const assignment: Policy.Assignment = {
				entry: "client",
				artifact,
				tier: "untrusted",
				grants: [
					{ _tag: "Http", id: "weather", origin, credential: "WEATHER_KEY" },
				],
			}
			yield* Policy.install({ version: "1", entries: [assignment] })
			yield* Policy.bind("client", "candidate", artifact, [])
			const expected = yield* Policy.statement("client", artifact)
			const approval = yield* Policy.review({ expected, who: "operator" })
			yield* Policy.approve(approval)
			const broker = yield* Capabilities.make("client", "candidate", assignment)
			const request = (url: string) =>
				broker
					.http({ grant: "weather", url })
					.pipe(
						Effect.provideService(
							ConfigProvider.ConfigProvider,
							ConfigProvider.fromEnvRecord({ WEATHER_KEY: "Bearer host-only" }),
						),
					)
			const response = yield* request(origin + "/forecast")
			assert.equal(response, "Authenticated response")
			const credential = yield* Ref.get(observed)
			assert.equal(credential, "Bearer host-only")
			const redirect = yield* request(origin + "/redirect").pipe(Effect.flip)
			assert.equal(redirect._tag, "CapabilityDenied")
			if (redirect._tag === "CapabilityDenied")
				assert.equal(redirect.reason, "DestinationDenied")
			const foreign = yield* request("http://127.0.0.1:1/").pipe(Effect.flip)
			assert.equal(foreign._tag, "CapabilityDenied")
			if (foreign._tag === "CapabilityDenied")
				assert.equal(foreign.reason, "DestinationDenied")
			yield* Policy.revoke(["env:WEATHER_KEY"])
			const revoked = yield* request(origin + "/forecast").pipe(Effect.flip)
			assert.equal(revoked._tag, "CapabilityDenied")
			if (revoked._tag === "CapabilityDenied")
				assert.equal(revoked.reason, "Revoked")
		}).pipe(
			Effect.scoped,
			Effect.provide(Graft.layer.pipe(Layer.provideMerge(NodeServices.layer))),
		),
)
