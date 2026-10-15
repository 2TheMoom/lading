# Lading frontend

Next.js app and landing page for Lading, escrow that pays when a real release matches the publisher's checksum list. It reads the Lading escrow and the verifier (Lineage) on GenLayer Bradbury (chain 4221).

- Reads use an account-free client. Writes use a second client that carries the injected wallet provider and is connected to Bradbury before signing.
- A write is only "done" after its transaction is accepted, its GenVM result is successful, the state reads back as expected, and then the transaction is FINALIZED and the state is read again. Until then the app says "recorded, not final".
- `/api/preflight` downloads and hashes the artifact and the publisher's list on the server before any money is sent, because a refused payable call keeps its value on Bradbury.

```
cp .env.example .env     # NEXT_PUBLIC_CONTRACT_ADDRESS (escrow) and NEXT_PUBLIC_VERIFIER_ADDRESS
npm install && npm run dev
npm test                 # logic tests; limits are checked against contracts/lading.py
```
