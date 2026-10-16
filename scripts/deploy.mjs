// Deploys the escrow to Bradbury with a dedicated testnet wallet kept outside the repo.
//   VERIFIER=0x... node scripts/deploy.mjs
// The verifier address is fixed in the constructor: there is no setter, so a different verifier means a different escrow.
import { readFileSync } from "fs";
import { createAccount, createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const VERIFIER = process.env.VERIFIER || "0x6508856DE231e094BfD121Eb5A30D5C3c03972A9";
const wallets = JSON.parse(readFileSync("C:/Users/olumi/.genlayer-test-wallets/wallets.json", "utf8"));
const client = createClient({ chain: testnetBradbury, account: createAccount(wallets["gl-test-1"].privateKey) });
const code = new Uint8Array(readFileSync("contracts/lading.py"));
console.log(`deploying ${code.length} bytes, verifier ${VERIFIER}`);

await client.initializeConsensusSmartContract();
const hash = await client.deployContract({ code, args: [VERIFIER] });
console.log("tx", hash);
const receipt = await client.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 200, interval: 5000 });
console.log("status", receipt.statusName, receipt.txExecutionResultName);
const address = receipt.txDataDecoded?.contractAddress ?? receipt.data?.contract_address;
console.log("ESCROW", address);
