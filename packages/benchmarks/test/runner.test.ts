// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests need fresh native Node processes to verify import isolation.
import { execFileSync } from "node:child_process"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Inspect the native runner output directory outside measured work.
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const directory = fileURLToPath(new URL("..", import.meta.url))
const evaluate = (code: string) =>
	execFileSync(process.execPath, ["--input-type=module", "-e", code], {
		cwd: directory,
		encoding: "utf8",
	})

describe("runner isolation and startup", () => {
	it("imports executable modules without running them or writing results", () => {
		const before = readdirSync(new URL("../results", import.meta.url))
		expect(
			evaluate(
				'await Promise.all([import("./runner.mjs"), import("./worker.mjs"), import("./import-worker.mjs"), import("./profile.mjs")])',
			),
		).toBe("")
		expect(readdirSync(new URL("../results", import.meta.url))).toEqual(before)
	})
	for (const library of [
		"@graftland/graft",
		"cordis",
		"avvio",
		"effect",
		"node:events",
		"emittery",
	])
		it(`completes a fresh-process import of ${library}`, () => {
			// @effect-diagnostics-next-line globalJson:off -- Validate the native child process JSON protocol outside measured work.
			const result: unknown = JSON.parse(
				execFileSync(process.execPath, ["import-worker.mjs", library], {
					cwd: directory,
					encoding: "utf8",
				}),
			)
			expect(result).toEqual({
				elapsed: expect.any(Number),
				exports: expect.any(Number),
			})
			if (
				typeof result !== "object" ||
				result === null ||
				!("elapsed" in result) ||
				!("exports" in result)
			)
				throw new Error("Invalid import result")
			expect(Number(result.elapsed)).toBeGreaterThan(0)
			expect(Number(result.exports)).toBeGreaterThan(0)
		})
	it("retains signed heap samples and computes quantiles without clamping", () => {
		// @effect-diagnostics-next-line globalJson:off -- Validate the native child process JSON protocol outside measured work.
		const result: unknown = JSON.parse(
			evaluate(
				'const {statistics} = await import("./statistics.mjs"); process.stdout.write(JSON.stringify(statistics([-10, 0, 10])))',
			),
		)
		expect(result).toMatchObject({
			mean: 0,
			p50: 0,
			p99: 9.8,
			rme: null,
			samplesCount: 3,
			samples: [-10, 0, 10],
		})
	})
	it("preserves both work and cleanup failures", () => {
		expect(
			evaluate(
				'const {withCleanup} = await import("./cleanup.mjs"); try { await withCleanup(() => { throw new Error("work failed") }, () => { throw new Error("cleanup failed") }) } catch (error) { process.stdout.write(error.errors.map((item) => item.message).join(";")) }',
			),
		).toBe("work failed;cleanup failed")
	})
	it("audits only processes carrying this run's ownership token", () => {
		expect(
			evaluate(`
			const {spawn} = await import("node:child_process");
			const {once} = await import("node:events");
			const {randomUUID} = await import("node:crypto");
			const {ownedProcesses} = await import("./runner.mjs");
			const {withCleanup} = await import("./cleanup.mjs");
			const assert = (await import("node:assert/strict")).default;
			const token = randomUUID();
			const start = (id) => spawn(process.execPath, ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
				stdio: ["ignore", "pipe", "pipe"], env: {...process.env, GRAFT_BENCH_RUN_ID: id}
			});
			const owned = start(token);
			const other = start(token + "-other");
			await withCleanup(async () => {
				await Promise.all([once(owned.stdout,"data"), once(other.stdout,"data")]);
				assert.deepEqual(await ownedProcesses(token), [owned.pid]);
				process.stdout.write("ownership verified");
			}, async () => {
				await Promise.all([owned,other].map(async child => {
					const exited = once(child,"exit"); child.kill(); await exited;
				}));
			});
		`),
		).toContain("ownership verified")
	})
	it("resolves compressed sample files relative to nested result outputs", () => {
		expect(
			evaluate(`
			const {run} = await import("./runner.mjs");
			const {withCleanup} = await import("./cleanup.mjs");
			const {execFileSync} = await import("node:child_process");
			const {readFile,mkdir,rm} = await import("node:fs/promises");
			const {resolve,dirname} = await import("node:path");
			const {gunzipSync} = await import("node:zlib");
			const assert = (await import("node:assert/strict")).default;
			const root = resolve(".cache/path-check-" + process.pid);
			const checkout = resolve(root,"checkout");
			await mkdir(checkout,{recursive:true});
			let data;
			await withCleanup(async () => {
				// The test also runs in source copies whose host worktree metadata is unavailable.
				execFileSync("git",["init","--quiet",checkout]);
				execFileSync("git",["-C",checkout,"-c","user.name=Benchmark test","-c","user.email=benchmark@example.test","-c","commit.gpgsign=false","commit","--quiet","--allow-empty","-m","Benchmark fixture"],{env:{...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null"}});
				process.env.GIT_DIR = resolve(checkout,".git");
				process.env.GIT_WORK_TREE = checkout;
				const output = resolve(root,"nested/result");
				data = await run(["--quick","--scenario","config-update","--implementation","effect","--output",output]);
				const row = data.results[0];
				assert.equal(row.status,"completed");
				const samples = JSON.parse(gunzipSync(await readFile(resolve(dirname(output + ".json"),row.measurement.sampleFile))).toString());
				assert.equal(samples.length,row.measurement.samplesCount);
				assert.ok(samples.every(Number.isFinite));
				process.stdout.write("samples verified");
			}, async () => {
				await rm(root,{recursive:true});
				if(data) await rm(resolve(".cache/samples",data.cleanupAudit.runToken),{recursive:true});
			});
		`),
		).toContain("samples verified")
	})

	it("keeps the required size matrix in quick mode", () => {
		// @effect-diagnostics-next-line globalJson:off -- Validate the native child process JSON protocol outside measured work.
		const result: unknown = JSON.parse(
			evaluate(
				'const {cases} = await import("./catalog.mjs"); process.stdout.write(JSON.stringify(cases(true)))',
			),
		)
		expect(result).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ scenario: "cold-load", size: 1000 }),
				expect.objectContaining({ scenario: "events-parallel", size: 100 }),
			]),
		)
	})
})
