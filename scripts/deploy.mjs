// Deploys one contract with a dedicated testnet wallet kept outside the repo. Constructor args are a JSON array so numbers stay numbers.
//   node scripts/deploy.mjs contracts/lineage.py                                   (the verifier, no arguments)
//   node scripts/deploy.mjs contracts/lading.py '["0x<verifier address>"]'         (the escrow: its verifier is fixed in the constructor, there is no setter)
//   NETWORK=studionet node scripts/deploy.mjs ...                                    deploys to the hosted Studio network instead of Bradbury
import { readFileSync } from "fs";
import { createAccount, createClient } from "genlayer-js";
import { chain, NETWORK } from "./network.mjs";

const [file, argsJson] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/deploy.mjs <contract.py> ['[args json]']");
  process.exit(1);
}
const args = argsJson ? JSON.parse(argsJson).map((a) => (typeof a === "number" ? BigInt(a) : a)) : [];
const wallets = JSON.parse(readFileSync("C:/Users/olumi/.genlayer-test-wallets/wallets.json", "utf8"));
const client = createClient({ chain, account: createAccount(wallets["gl-test-1"].privateKey) });
const code = new Uint8Array(readFileSync(file));
console.log(`deploying ${file} (${code.length} bytes) to ${NETWORK}, args=${JSON.stringify(args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
if (!chain.isStudio) await client.initializeConsensusSmartContract();
const hash = await client.deployContract({ code, args });
console.log("tx", hash);
const receipt = await client.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 200, interval: 5000 });
console.log("status", receipt.statusName, receipt.txExecutionResultName);
console.log("ADDRESS", receipt.txDataDecoded?.contractAddress ?? receipt.data?.contract_address);
