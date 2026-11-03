import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { becomesLatest, releaseManifest, releaseVersion } from "./packages.mjs"

const sha = "0123456789abcdef0123456789abcdef01234567"

test("a commit has an exact version and its own tag", () => {
	assert.deepEqual(releaseVersion("", sha), {
		version: `0.0.0-commit-${sha}`,
		tag: `sha-${sha}`,
	})
})

test("only a plain version tag can change latest", () => {
	assert.deepEqual(releaseVersion("v1.2.3", sha), {
		version: "1.2.3",
		tag: "latest",
	})
	for (const ref of ["main", "v01.2.3", "v1.2.3-beta", "v1.2"])
		assert.throws(() => releaseVersion(ref, sha))
	assert.throws(() => releaseVersion("", "0123456"))
})

test("workspace packages use the same exact release", () => {
	const manifest = {
		name: "@graftland/loader",
		version: "0.0.0",
		dependencies: { "@graftland/graft": "workspace:*", yaml: "2.8.1" },
		peerDependencies: { "@graftland/hmr": "workspace:^" },
	}
	const result = releaseManifest(
		manifest,
		"1.2.3",
		new Set(["@graftland/graft", "@graftland/hmr"]),
	)
	assert.equal(result.dependencies["@graftland/graft"], "1.2.3")
	assert.equal(result.peerDependencies["@graftland/hmr"], "1.2.3")
	assert.equal(result.dependencies.yaml, "2.8.1")
	assert.equal(manifest.dependencies["@graftland/graft"], "workspace:*")
	assert.throws(() => releaseManifest(manifest, "1.2.3", new Set()))
})

test("latest never moves back to an older release", () => {
	assert.equal(becomesLatest("1.2.3", undefined), true)
	assert.equal(becomesLatest("1.2.3", "1.2.3"), true)
	assert.equal(becomesLatest("1.10.0", "1.9.9"), true)
	assert.equal(becomesLatest("1.2.3", "2.0.0"), false)
	assert.equal(becomesLatest("1.2.3", "1.2.10"), false)
})

// A fake npm records its calls, so these tests never write to a registry.
const publishWith = (registry, tag, mode, latest = "", tagged = "") => {
	const dir = mkdtempSync(join(tmpdir(), "graft-publish-test-"))
	try {
		writeFileSync(
			join(dir, "release.json"),
			JSON.stringify({
				version: "1.2.3",
				tag,
				artifacts: [
					{
						name: "@graftland/graft",
						file: "core.tgz",
						integrity: "sha512-test",
					},
				],
			}),
		)
		writeFileSync(
			join(dir, "npm"),
			`#!/bin/sh
if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ] && [ -n "$TEST_LATEST" ]; then
  printf '"%s"\\n' "$TEST_LATEST"; exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist-tags.$TEST_TAGGED" ]; then
  echo '"1.2.3"'; exit 0
fi
if [ "$1" = "view" ] && [ "\${3#dist-tags.}" != "$3" ]; then
  echo '{"error":{"code":"E404"}}'; exit 1
fi
if [ "$1" = "view" ]; then
  case "$TEST_MODE" in
    missing) echo '{"error":{"code":"E404"}}'; exit 1;;
    same) echo '"sha512-test"'; exit 0;;
    changed) echo '"sha512-other"'; exit 0;;
    denied) echo '{"error":{"code":"E403","summary":"No access"}}'; exit 1;;
    empty) exit 0;;
  esac
fi
printf '%s\\n' "$*" >> "$TEST_LOG"
`,
			{ mode: 0o755 },
		)
		const log = join(dir, "calls")
		writeFileSync(log, "")
		const result = spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("./packages.mjs", import.meta.url)),
				"publish",
				registry,
				dir,
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH}`,
					TEST_MODE: mode,
					TEST_LATEST: latest,
					TEST_TAGGED: tagged,
					TEST_LOG: log,
				},
			},
		)
		return {
			status: result.status,
			stderr: result.stderr,
			calls: readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line !== ""),
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

for (const mode of ["missing", "same", "changed", "denied"]) {
	test(`publication handles a ${mode} version`, () => {
		const { status, stderr, calls } = publishWith("github", "latest", mode)
		assert.equal(status, mode === "missing" || mode === "same" ? 0 : 1, stderr)
		assert.deepEqual(
			calls.map((call) => call.split(" ")[0]),
			mode === "missing" ? ["publish"] : mode === "same" ? ["dist-tag"] : [],
		)
	})
}

test("an existing version whose tag is already set needs no calls", () => {
	const { status, stderr, calls } = publishWith(
		"github",
		"latest",
		"same",
		"",
		"latest",
	)
	assert.equal(status, 0, stderr)
	assert.deepEqual(calls, [])
})

test("npm gets public releases, and no snapshots", () => {
	const release = publishWith("npm", "latest", "missing")
	assert.equal(release.status, 0, release.stderr)
	assert.match(release.calls[0], /^publish .*--access public/)
	assert.match(release.calls[0], /--registry https:\/\/registry\.npmjs\.org/)
	const snapshot = publishWith("npm", `sha-${sha}`, "missing")
	assert.equal(snapshot.status, 0, snapshot.stderr)
	assert.deepEqual(snapshot.calls, [])
})

test("an older release does not take latest", () => {
	const { status, stderr, calls } = publishWith(
		"npm",
		"latest",
		"missing",
		"2.0.0",
	)
	assert.equal(status, 0, stderr)
	assert.match(calls[0], /^publish .*--tag backport/)
	assert.equal(calls.length, 1)
})

test("an existing version with no contents yet is published", () => {
	const { status, stderr, calls } = publishWith("github", "latest", "empty")
	assert.equal(status, 0, stderr)
	assert.match(calls[0], /^publish /)
	assert.doesNotMatch(calls[0], /--access/)
})

test("an unknown registry is refused", () => {
	assert.notEqual(publishWith("elsewhere", "latest", "missing").status, 0)
})
