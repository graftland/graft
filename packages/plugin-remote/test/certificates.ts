import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import process from "node:process"
import * as Certificates from "../src/internal/Certificates"

/** Exercise the deployment command for ordinary certificates; only invalid identities bypass it. */
export const certificates = (base: string, bin: string, cwd: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			yield* fs.makeDirectory(base, { recursive: true })
			const directory = yield* fs.makeTempDirectory({
				directory: base,
				prefix: "tls-",
			})
			return yield* Effect.gen(function* () {
				for (const name of ["client", "other"]) {
					const code = yield* spawner.exitCode(
						ChildProcess.make(
							process.execPath,
							[
								bin,
								"remote",
								"certificates",
								"--out",
								directory,
								...(name === "client"
									? [
											"--server",
											"localhost",
											"--server",
											"127.0.0.1",
											"--server",
											"::1",
										]
									: []),
								"--identity",
								"test-host",
								"--days",
								"2",
							],
							{ cwd, stdout: "ignore", stderr: "inherit" },
						),
					)
					if (code !== 0)
						return yield* Certificates.CertificateError.make({
							detail: `Certificate command exited with ${code}`,
						})
					for (const extension of [".crt", ".key"])
						yield* fs.rename(
							directory + "/client-test-host" + extension,
							directory + "/" + name + extension,
						)
				}
				const issuer = yield* Certificates.read(directory + "/ca")
				for (const name of ["missing", "ambiguous", "rogue"]) {
					const pair = yield* Certificates.issue({
						name,
						days: 2,
						usage: "client",
						identities:
							name === "missing"
								? []
								: name === "ambiguous"
									? ["test-host", "another-host"]
									: ["test-host"],
						...(name === "rogue" ? {} : { issuer }),
					})
					yield* Certificates.write(directory + "/" + name, pair)
				}
				return directory
			}).pipe(
				Effect.onError(() =>
					fs
						.remove(directory, { recursive: true, force: true })
						.pipe(Effect.orDie),
				),
			)
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto),
			),
		),
	)
