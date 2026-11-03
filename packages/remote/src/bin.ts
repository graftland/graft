#!/usr/bin/env node
/** The executable owns either a supervised child or a TLS supervisor. */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array,
	Cause,
	Console,
	Effect,
	FileSystem,
	Layer,
	Redacted,
	Schema,
} from "effect"
import { Digest } from "effect/crypto"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { load, run } from "./Runner"
import { Bootstrap } from "./internal/runner/Bootstrap"
import * as Watchdog from "./internal/runner/Watchdog"
import { failure } from "./internal/runner/model"
import * as Server from "./internal/runner/Server"

const serve = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		let values: Readonly<Record<string, string>> = {}
		for (let i = 0; i < args.length; i += 2) {
			const flag = args[i]!
			const value = args[i + 1]
			if (
				value === undefined ||
				![
					"--host",
					"--port",
					"--cert",
					"--key",
					"--ca",
					"--state",
					"--root",
					"--lease",
					"--grace",
				].includes(flag)
			)
				return yield* Effect.die(new Error("Invalid serve option: " + flag))
			values = { ...values, [flag]: value }
		}
		const required = (name: string) =>
			Effect.fromNullishOr(values[name]).pipe(
				Effect.mapError(() =>
					failure("InvalidRequest", "Missing serve option: " + name),
				),
			)
		const fs = yield* FileSystem.FileSystem
		const cert = yield* required("--cert")
		const key = yield* required("--key")
		const ca = yield* required("--ca")
		const state = yield* required("--state")
		const root = yield* required("--root")
		const port = Number(values["--port"] ?? 7443)
		if (!Number.isInteger(port) || port < 0 || port > 65535)
			return yield* Effect.die(new Error("Invalid listen port"))
		const keyText = yield* fs.readFileString(key)
		const privateKey = Redacted.make(keyText)
		const server = yield* Server.serve({
			host: values["--host"] ?? "127.0.0.1",
			port,
			state,
			root,
			tls: {
				cert: yield* fs.readFileString(cert),
				key: privateKey,
				ca: yield* fs.readFileString(ca),
			},
			lease: Number(values["--lease"] ?? 15000),
			grace: Number(values["--grace"] ?? 5000),
		})
		const message = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Unknown),
		)({
			event: "Listening",
			port:
				server.address._tag === "UnixPathAddress" ? null : server.address.port,
		})
		yield* Console.log(message)
		return yield* Effect.never
	}).pipe(
		// @effect-diagnostics-next-line strictEffectProvide:off -- This executable owns its platform and digest services.
		Effect.provide(Layer.merge(NodeServices.layer, Digest.layerWebCrypto)),
	)

NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			const args = Array.drop(process.argv, 2)
			if (args[0] === "serve") return yield* serve(Array.drop(args, 1))
			if (args[0] === "child") {
				const [, specifier, session, encoded] = args
				if (
					specifier === undefined ||
					session === undefined ||
					encoded === undefined ||
					args.length !== 4
				)
					return yield* Effect.die(
						new Error("Invalid supervised child arguments"),
					)
				const bootstrap = yield* Schema.decodeEffect(
					Schema.fromJsonString(Bootstrap),
				)(encoded)
				const watchdog = yield* Watchdog.start
				// Stdio belongs to this executable. Node's shared stdin otherwise
				// keeps the process alive after a supervisor-requested stop.
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						process.stdin.destroy()
					}),
				)
				const begin = yield* Effect.raceFirst(
					watchdog.begin.pipe(Effect.as(true)),
					watchdog.stop.pipe(Effect.as(false)),
				)
				if (!begin) return
				const contract = yield* load(pathToFileURL(specifier).href)
				return yield* run(contract, session, bootstrap, watchdog.stop)
			}
			const [specifier, session = "local"] = args
			if (specifier === undefined || args.length > 2)
				return yield* Effect.die(
					new Error(
						"Usage: graft-remote <contract-module-specifier> [session] | serve --root <directory> --state <directory> --cert <file> --key <file> --ca <file> [--host <host>] [--port <port>] [--lease <milliseconds>] [--grace <milliseconds>]",
					),
				)
			return yield* load(specifier).pipe(
				Effect.flatMap((contract) => run(contract, session)),
			)
		}),
	).pipe(Effect.tapCause((cause) => Console.error(Cause.pretty(cause)))),
)
