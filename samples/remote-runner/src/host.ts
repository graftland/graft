import websocket from "@graftland/remote/host/websocket"
import jwt from "@graftland/remote/host/auth/jwt"
/**
 * The host. It loads graft.yml, exports two invoices across two host restarts,
 * and shows the ledger turning away a write from the replaced generation.
 */
import { NodeServices } from "@effect/platform-node"
import { Graft, Plugin } from "@graftland/graft"
import { Include, ModuleResolver } from "@graftland/loader"
import {
	Console,
	ConfigProvider,
	Deferred,
	Effect,
	Layer,
	Result,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { fileURLToPath } from "node:url"
import { Exporter, Ledger, type Receipt } from "./contract.ts"
import exporter from "./exporter.ts"
import ledger from "./ledger.ts"

const graftYml = fileURLToPath(new URL("../graft.yml", import.meta.url))

/**
 * A fresh host runtime, as after a process restart. The table maps graft.yml
 * names to modules bundled with this program; `graft start` resolves them itself.
 */
export const layer = (environment: Readonly<Record<string, string>>) =>
	Layer.provideMerge(
		Layer.fresh(Graft.layer),
		Layer.mergeAll(
			NodeServices.layer,
			SecureRandom.layerWebCrypto,
			ModuleResolver.fromRecord({
				"@graftland/remote/host/websocket": websocket,
				"@graftland/remote/host/auth/jwt": jwt,
				"./src/ledger.ts": ledger,
				"./src/exporter.ts": exporter,
			}),
			ConfigProvider.layer(ConfigProvider.fromEnvRecord(environment)),
		),
	)

/** Loads graft.yml and waits until both services are available. */
export const open = Effect.gen(function* () {
	const include = yield* Graft.plugin(Include.Include, { path: graftYml })
	// This sample ships its graft.yml, so failing to load it is a bug, not a condition to handle.
	yield* Effect.orDie(include.await)
	const services = yield* Deferred.make<{
		readonly exporter: Exporter["Service"]
		readonly ledger: Ledger["Service"]
	}>()
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "billing",
			inject: [Exporter, Ledger],
			apply: () =>
				Effect.gen(function* () {
					yield* Deferred.succeed(services, {
						exporter: yield* Exporter,
						ledger: yield* Ledger,
					})
				}),
		}),
	)
	// A failed exporter leaves this consumer pending; the host logs why.
	return yield* consumer.await.pipe(
		Effect.andThen(Deferred.await(services)),
		Effect.timeout("30 seconds"),
	)
})

/** Runs `effect` in its own host runtime, the way a separate host process would. */
const inHost =
	(environment: Readonly<Record<string, string>>) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.scoped,
			// @effect-diagnostics-next-line strictEffectProvide:off -- each call stands in for a separate host process and its entry point
			Effect.provide(layer(environment)),
		)

const exported = (receipt: typeof Receipt.Type) =>
	Console.log(
		`${receipt.invoice} exported by generation ${receipt.generation} (runner child ${receipt.pid})`,
	)

export const demo = Effect.fn("demo")(function* (
	environment: Readonly<Record<string, string>>,
) {
	const first = yield* open.pipe(
		Effect.flatMap(({ exporter }) => exporter.export("INV-1")),
		Effect.tap(exported),
		inHost(environment),
	)
	// The first host has stopped, and the runner has confirmed that its process exited.
	return yield* open.pipe(
		Effect.flatMap(({ exporter, ledger }) =>
			Effect.gen(function* () {
				const second = yield* exporter.export("INV-2")
				yield* exported(second)
				// A write from the first generation that was delayed somewhere and arrives now.
				const late = yield* Effect.result(
					ledger.append({
						invoice: "INV-1",
						destination: "accounting",
						instance: "exporter",
						generation: first.generation,
					}),
				)
				yield* Result.match(late, {
					onSuccess: () => Console.log("The ledger accepted the late write"),
					onFailure: (error) =>
						Console.log(
							error._tag === "StaleGeneration"
								? `A late write from generation ${error.generation} was rejected: the ledger has seen ${error.latest}`
								: "The ledger was unreachable",
						),
				})
				return { first, second, late }
			}),
		),
		inHost(environment),
	)
})
