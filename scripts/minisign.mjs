// Minisign verification as done by the Tauri updater (and by the app for the Voix IA pack
// manifest): shared by updater_manifest.mjs and ai_pack_manifest.mjs.
import { createHash, createPublicKey, verify } from "node:crypto";

/** Lines of a base64-encoded minisign file (the first is an untrusted comment). */
function minisignLines(base64) {
  return Buffer.from(base64, "base64").toString("utf8").split("\n").map((l) => l.trim());
}

/**
 * Checks `signatureB64` (a Tauri `.sig` file) over `data` against `pubkeyB64` (the
 * `plugins.updater.pubkey` of tauri.conf.json) and returns the authenticated trusted comment.
 * The key id must match, the Ed25519 signature covers the BLAKE2b-512 hash of the data ("ED")
 * or the data itself ("Ed"), and the global signature covers signature + trusted comment.
 * Throws an Error whose message completes "<what was signed> …".
 */
export function verifyMinisign(data, signatureB64, pubkeyB64) {
  const key = Buffer.from(minisignLines(pubkeyB64)[1] ?? "", "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed") {
    throw new Error("cannot be checked: the public key in tauri.conf.json is not a minisign key");
  }
  const [, sigLine = "", trusted = "", globalLine = ""] = minisignLines(signatureB64);
  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74) throw new Error("signature file is malformed");
  const algorithm = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    throw new Error("was signed with another key than the one in tauri.conf.json (TAURI_SIGNING_PRIVATE_KEY does not match)");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, publicKey, sig.subarray(10))) throw new Error("signature does not verify");
  const comment = trusted.replace(/^trusted comment: /, "");
  const global = Buffer.from(globalLine, "base64");
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment)]), publicKey, global)) {
    throw new Error("signature trusted comment does not verify");
  }
  return comment;
}
