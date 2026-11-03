import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Test keys are generated for this run and removed by the global setup teardown. */
export async function certificates(base) {
	await mkdir(base, { recursive: true })
	const root = await mkdtemp(join(base, "tls-"))
	try {
		const openssl = (...args) =>
			execFileSync("openssl", args, { cwd: root, stdio: "pipe" })
		await writeFile(
			join(root, "ca.cnf"),
			"[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Graft test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
		)
		openssl(
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			"ca.key",
			"-out",
			"ca.crt",
			"-days",
			"2",
			"-config",
			"ca.cnf",
		)
		for (const name of ["server", "client", "other", "missing", "ambiguous"]) {
			openssl(
				"req",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				`${name}.key`,
				"-out",
				`${name}.csr`,
				"-subj",
				name === "server" ? "/CN=localhost" : "/CN=Graft test client",
			)
			await writeFile(
				join(root, `${name}.ext`),
				name === "server"
					? "basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n"
					: "basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n" +
							(name === "missing"
								? ""
								: name === "ambiguous"
									? "subjectAltName=URI:graft://test-host,URI:graft://another-host\n"
									: "subjectAltName=URI:graft://test-host\n"),
			)
			openssl(
				"x509",
				"-req",
				"-in",
				`${name}.csr`,
				"-CA",
				"ca.crt",
				"-CAkey",
				"ca.key",
				"-CAcreateserial",
				"-out",
				`${name}.crt`,
				"-days",
				"2",
				"-extfile",
				`${name}.ext`,
			)
		}
		openssl(
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			"rogue.key",
			"-out",
			"rogue.crt",
			"-days",
			"2",
			"-subj",
			"/CN=Graft test client",
		)
		return root
	} catch (error) {
		await rm(root, { recursive: true, force: true })
		throw error
	}
}
