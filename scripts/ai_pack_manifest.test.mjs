// node --test scripts/ai_pack_manifest.test.mjs
// Writes pack manifests for fake installers, signs them like the Tauri CLI (minisign, Ed25519
// over BLAKE2b-512) and checks which ones ai_pack_manifest.mjs accepts.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("./ai_pack_manifest.mjs", import.meta.url));
const b64 = (text) => Buffer.from(text).toString("base64");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

function keyPair(idHex = "0123456789abcdef") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const id = Buffer.from(idHex, "hex");
  const pub = Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64");
  return { privateKey, id, pubkey: b64(`untrusted comment: minisign public key\n${pub}\n`) };
}

function signFile(file, key) {
  const trusted = "timestamp:1\tfile:ai-pack-manifest.json";
  const digest = createHash("blake2b512").update(readFileSync(file)).digest();
  const signature = sign(null, digest, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key.privateKey);
  const line = Buffer.concat([Buffer.from("ED"), key.id, signature]).toString("base64");
  return b64(`untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${trusted}\n${global.toString("base64")}`);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ai-pack-"));
  const exe = join(dir, "VoxBox-Voix-IA-setup.exe");
  writeFileSync(exe, "installer bytes");
  const key = keyPair();
  const config = join(dir, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: key.pubkey } } }));
  return { dir, exe, key, config, manifest: join(dir, "ai-pack-manifest.json") };
}

test("writes the manifest of the installer", () => {
  const { exe, manifest } = setup();
  const result = run("write", exe, "14");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), {
    version: 14,
    file: "VoxBox-Voix-IA-setup.exe",
    size: 15,
    sha256: createHash("sha256").update("installer bytes").digest("hex"),
  });
});

test("refuses a version that is not a positive integer", () => {
  const { exe } = setup();
  for (const version of ["0", "1.2", "v3", "-1"]) {
    const result = run("write", exe, version);
    assert.equal(result.status, 1, version);
    assert.match(result.stderr, /positive integer/);
  }
});

test("verifies a manifest signed with the shipped key", () => {
  const { exe, key, config, manifest } = setup();
  run("write", exe, "14");
  writeFileSync(`${manifest}.sig`, signFile(manifest, key));
  const result = run("verify", manifest, config);
  assert.equal(result.status, 0, result.stderr);
});

test("refuses another signing key", () => {
  const { exe, config, manifest } = setup();
  run("write", exe, "14");
  writeFileSync(`${manifest}.sig`, signFile(manifest, keyPair("fedcba9876543210")));
  const result = run("verify", manifest, config);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /another key/);
});

test("refuses a manifest changed after signing", () => {
  const { exe, key, config, manifest } = setup();
  run("write", exe, "14");
  writeFileSync(`${manifest}.sig`, signFile(manifest, key));
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("14", "15"));
  const result = run("verify", manifest, config);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not verify/);
});

test("refuses a manifest that no longer describes its installer", () => {
  const { exe, key, config, manifest } = setup();
  run("write", exe, "14");
  writeFileSync(`${manifest}.sig`, signFile(manifest, key));
  writeFileSync(exe, "other bytes!!!!");
  const result = run("verify", manifest, config);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not describe/);
});
