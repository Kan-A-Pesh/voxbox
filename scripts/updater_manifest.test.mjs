// node --test scripts/updater_manifest.test.mjs
// Signs fake installers like the Tauri CLI (minisign, Ed25519 over BLAKE2b-512) and checks
// which ones updater_manifest.mjs accepts.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("./updater_manifest.mjs", import.meta.url));
const b64 = (text) => Buffer.from(text).toString("base64");

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const id = Buffer.from("0123456789abcdef", "hex");
  const pub = Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64");
  return { privateKey, id, pubkey: b64(`untrusted comment: minisign public key\n${pub}\n`) };
}

function signFile(file, key, trusted) {
  const digest = createHash("blake2b512").update(readFileSync(file)).digest();
  const signature = sign(null, digest, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key.privateKey);
  const line = Buffer.concat([Buffer.from("ED"), key.id, signature]).toString("base64");
  return b64(`untrusted comment: signature from tauri secret key\n${line}\ntrusted comment: ${trusted}\n${global.toString("base64")}`);
}

function setup({ version = "0.1.50", trusted, signer, tamper = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const exe = `VoxBox_${version}_x64-setup.exe`;
  const key = keyPair();
  writeFileSync(join(dir, exe), "installer bytes");
  writeFileSync(join(dir, `${exe}.sig`), signFile(join(dir, exe), signer ?? key, trusted ?? `timestamp:1\tfile:${exe}\tversion:${version}`));
  if (tamper) writeFileSync(join(dir, exe), "other bytes");
  const config = join(dir, "tauri.conf.json");
  writeFileSync(config, JSON.stringify({ plugins: { updater: { pubkey: key.pubkey } } }));
  const run = spawnSync(process.execPath, [script, dir, "0.1.50", "o/r", config], { encoding: "utf8" });
  return { dir, run };
}

test("writes latest.json for an installer signed with the shipped key", () => {
  const { dir, run } = setup();
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  assert.equal(manifest.version, "0.1.50");
  assert.equal(manifest.platforms["windows-x86_64"].url, "https://github.com/o/r/releases/download/v0.1.50/VoxBox_0.1.50_x64-setup.exe");
});

test("refuses a signature that carries no version", () => {
  const { run } = setup({ trusted: "timestamp:1\tfile:VoxBox_0.1.50_x64-setup.exe" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /carries no version/);
});

test("refuses another signing key", () => {
  const { run } = setup({ signer: { ...keyPair(), id: Buffer.from("fedcba9876543210", "hex") } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /another key/);
});

test("refuses a modified installer", () => {
  const { run } = setup({ tamper: true });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not verify/);
});

test("refuses a signed version that differs from the release", () => {
  const { run } = setup({ trusted: "timestamp:1\tfile:VoxBox_0.1.50_x64-setup.exe\tversion:0.1.49" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /signed as version 0\.1\.49/);
});

test("refuses a signature naming several versions", () => {
  const { run } = setup({ trusted: "timestamp:1\tversion:0.1.49\tversion:0.1.50\tfile:VoxBox_0.1.50_x64-setup.exe" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /several versions/);
});

test("accepts a signature naming the release version", () => {
  const { run } = setup({ trusted: "timestamp:1\tfile:VoxBox_0.1.50_x64-setup.exe\tversion:0.1.50" });
  assert.equal(run.status, 0, run.stderr);
});

test("refuses a signature made for another file", () => {
  const { run } = setup({ trusted: "timestamp:1\tfile:VoxBox_0.1.49_x64-setup.exe\tversion:0.1.50" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /signature is for VoxBox_0\.1\.49/);
});

test("refuses an installer built as another version", () => {
  const { run } = setup({ version: "0.1.49" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not built as version 0\.1\.50/);
});
