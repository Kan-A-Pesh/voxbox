// Manifest of a « VoxBox - Voix IA » pack release, read by the app's in-app pack update
// (crates/voxbox-aipack). Published with the installer in the ai-pack-<N> release.
//   node scripts/ai_pack_manifest.mjs write <installer.exe> <N>
//     writes ai-pack-manifest.json next to the installer: { version, file, size, sha256 }
//   node scripts/ai_pack_manifest.mjs verify <ai-pack-manifest.json> <tauri.conf.json>
//     checks ai-pack-manifest.json.sig against the public key the app ships with, and that the
//     manifest still describes the installer next to it (a pack signed with any other key, or
//     a manifest out of step with its installer, is never published).
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { verifyMinisign } from "./minisign.mjs";

export const MANIFEST = "ai-pack-manifest.json";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

function describe(exe) {
  return {
    file: basename(exe),
    size: statSync(exe).size,
    sha256: createHash("sha256").update(readFileSync(exe)).digest("hex"),
  };
}

const [command, ...args] = process.argv.slice(2);
if (command === "write" && args.length === 2) {
  const [exe, versionText] = args;
  if (!/^[1-9]\d*$/.test(versionText)) fail(`pack version must be a positive integer, not « ${versionText} »`);
  const manifest = { version: Number(versionText), ...describe(exe) };
  writeFileSync(join(dirname(exe), MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${MANIFEST}: pack ${manifest.version}, ${manifest.file} (${manifest.size} bytes)`);
} else if (command === "verify" && args.length === 2) {
  const [manifestPath, configPath] = args;
  const data = readFileSync(manifestPath);
  const signature = readFileSync(`${manifestPath}.sig`, "utf8").trim();
  if (!signature) fail(`${manifestPath}.sig is empty`);
  const pubkey = JSON.parse(readFileSync(configPath, "utf8"))?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || !pubkey) fail(`no plugins.updater.pubkey in ${configPath}`);
  try {
    verifyMinisign(data, signature, pubkey);
  } catch (error) {
    fail(`pack manifest ${error.message}`);
  }
  const manifest = JSON.parse(data.toString("utf8"));
  const actual = describe(join(dirname(manifestPath), manifest.file ?? ""));
  if (actual.size !== manifest.size || actual.sha256 !== manifest.sha256) {
    fail(`pack manifest does not describe ${manifest.file} (size or SHA-256 differs)`);
  }
  console.log(`${MANIFEST}: signature and installer checked (pack ${manifest.version})`);
} else {
  fail("usage: ai_pack_manifest.mjs write <installer.exe> <N> | verify <ai-pack-manifest.json> <tauri.conf.json>");
}
