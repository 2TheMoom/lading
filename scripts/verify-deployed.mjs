// Proves the contract source in this repo is exactly what runs on Bradbury: it downloads the deployed code of each contract from the
// network and compares it with the file in this repo (line endings ignored). Needs no wallet.
//   node scripts/verify-deployed.mjs
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const CONTRACTS = [
  ["Escrow   (contracts/lading.py)", "0xd325abD9d0cAE02594Ec7dEe53091CCa2356983e", "contracts/lading.py"],
  ["Verifier (contracts/lineage.py)", "0x6508856DE231e094BfD121Eb5A30D5C3c03972A9", "contracts/lineage.py"],
];
const client = createClient({ chain: testnetBradbury });
const norm = (s) => s.replace(/\r\n/g, "\n");
const sha = (s) => createHash("sha256").update(s).digest("hex");
let allSame = true;
for (const [label, address, file] of CONTRACTS) {
  const onchain = norm(await client.getContractCode(address));
  const local = norm(readFileSync(file, "utf8"));
  const same = onchain === local;
  allSame &&= same;
  console.log(`${same ? "IDENTICAL" : "DIFFERENT"}  ${label}  ${address}\n           on chain sha256 ${sha(onchain)}  (${onchain.length} chars)\n           in repo  sha256 ${sha(local)}  (${local.length} chars)`);
}
process.exit(allSame ? 0 : 1);
