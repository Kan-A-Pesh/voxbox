// Writes latest.json, the manifest the in-app updater reads from
// https://github.com/<repo>/releases/latest/download/latest.json.
//   node scripts/updater_manifest.mjs <bundle dir> <version> <owner/repo> <tauri.conf.json>
// The bundle dir holds exactly one signed NSIS installer (<name>.exe + <name>.exe.sig).
// The signature is verified against the public key the app ships with (tauri.conf.json),
// so a release signed with any other key is never published.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version, repo, configPath] = process.argv.slice(2);
if (!dir || !version || !repo || !configPath) {
  console.error("usage: updater_manifest.mjs <bundle dir> <version> <owner/repo> <tauri.conf.json>");
  process.exit(2);
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** Second line of a base64-encoded minisign file (the first is an untrusted comment). */
function minisignLines(base64) {
  return Buffer.from(base64, "base64").toString("utf8").split("\n").map((l) => l.trim());
}

/**
 * Minisign verification as done by the Tauri updater: key id must match, the Ed25519
 * signature covers the BLAKE2b-512 hash of the file ("ED") or the file itself ("Ed"),
 * and the global signature covers signature + trusted comment.
 */
function verifySignature(file, signatureB64, pubkeyB64) {
  const key = Buffer.from(minisignLines(pubkeyB64)[1] ?? "", "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed") fail("public key in tauri.conf.json is not a minisign key");
  const [, sigLine = "", trusted = "", globalLine = ""] = minisignLines(signatureB64);
  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74) fail("signature file is malformed");
  const algorithm = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    fail("installer was signed with another key than the one in tauri.conf.json (TAURI_SIGNING_PRIVATE_KEY does not match)");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const data = readFileSync(file);
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, publicKey, sig.subarray(10))) fail("installer signature does not verify");
  const comment = trusted.replace(/^trusted comment: /, "");
  const global = Buffer.from(globalLine, "base64");
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment)]), publicKey, global)) {
    fail("signature trusted comment does not verify");
  }
  return comment;
}

/**
 * The trusted comment is authenticated: it must name the version published (the updater
 * rejects an installer whose signed version is missing or differs), and the file when it names one.
 */
function checkTrustedComment(comment, exe) {
  const values = (name) =>
    comment
      .split("\t")
      .filter((part) => part.startsWith(`${name}:`))
      .map((part) => part.slice(name.length + 1));
  const versions = values("version");
  const files = values("file");
  // The updater reads the first field: a repeated one could hide a mismatch behind a match.
  if (versions.length > 1 || files.length > 1) fail("signature names several versions or files");
  // The app requires it (plugins.updater.requireSignedVersion): without it, the manifest's
  // version claim is not authenticated.
  if (versions.length === 0) fail("signature carries no version (build with a Tauri CLI that signs the version)");
  if (versions[0] !== version) {
    fail(`installer is signed as version ${versions[0]}, not ${version}`);
  }
  if (files.length === 1 && files[0] !== exe) fail(`signature is for ${files[0]}, not ${exe}`);
}
const installers = readdirSync(dir).filter((f) => f.endsWith("-setup.exe"));
if (installers.length !== 1) {
  fail(`expected one *-setup.exe in ${dir}, found: ${installers.join(", ") || "none"}`);
}
const [exe] = installers;
if (!exe.includes(`_${version}_`)) {
  fail(`${exe} was not built as version ${version}`);
}
const signature = readFileSync(join(dir, `${exe}.sig`), "utf8").trim();
if (!signature) fail(`${exe}.sig is empty`);
const pubkey = JSON.parse(readFileSync(configPath, "utf8"))?.plugins?.updater?.pubkey;
if (typeof pubkey !== "string" || !pubkey) fail(`no plugins.updater.pubkey in ${configPath}`);
checkTrustedComment(verifySignature(join(dir, exe), signature, pubkey), exe);
const manifest = {
  version,
  notes: `https://github.com/${repo}/releases/tag/v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(exe)}`,
    },
  },
};
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json -> ${manifest.platforms["windows-x86_64"].url}`);
