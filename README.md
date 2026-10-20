# Lading

Escrow that pays when the build matches. A client funds GEN against a software release. GenLayer validators download the real file, hash it, and check it against the checksum list the publisher already ships. A match pays the developer, a mismatch or a later change refunds the client. No model decides money, and no marker line on a page someone wrote for the occasion: the evidence is the file itself.

The name is the bill of lading, the document that proves goods were delivered as described. The logo is the Plimsoll load line painted on ships to show they are safely loaded.

## The whole payout-driving path is in this repo

Lading is two contracts that run together, and **both are in this repository**. The escrow (`contracts/lading.py`) holds the money and never fetches or hashes anything itself. The verifier (`contracts/lineage.py`) is the contract that does: it fetches the artifact and the publisher's checksum list, hashes the bytes, and gets the validators to agree on the verdict. The escrow pays only on what the verifier has FINALIZED.

| Step of the path | Where it is | What it does |
|---|---|---|
| Fetch the artifact and the checksum list | `contracts/lineage.py`, `leader_fn` inside `_read` (lines 136-148), the two `gl.nondet.web.request` calls at lines 138-139 | The leader validator GETs both URLs. An error, a non-200 status, an empty body or an oversized file (artifact over 4,000,000 bytes, list over 500,000) records nothing. |
| Hash | `contracts/lineage.py` line 146 | `hashlib.sha256` over the exact downloaded bytes. The list is parsed by `_entries` (line 59) and the verdict is decided by `_judge` (line 70): verified, mismatch, unlisted or unbound. |
| Validator consensus | `contracts/lineage.py`, `validator_fn` (line 150) and `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` (line 159) | Every other validator repeats the download and the hash on its own and the vote passes only if the kind of verdict, the digest, the listed digest and the size are all identical to the leader's. |
| Record the verdict | `contracts/lineage.py`, `attest` (line 120) and `check` (line 162) | Stores the digest, the status and when it was checked. A later `check` that no longer matches records `drifted`. |
| Read the verdict before paying | `contracts/lading.py`, `_seen` (line 122) | The escrow asks the verifier for `trace` and `is_trusted_from` at `LATEST_FINAL` only, and re-checks every answer's shape before it acts. |
| Pay | `contracts/lading.py`, `release`, `refund_drift`, `reclaim_*`, then `settle` | A decision and its payment are never in the same transaction. |
| The app | `frontend/lib/contracts/Lading.ts` (lines 307 and 314) and `frontend/app/api/preflight/route.ts` | The app sends `attest` and `check` to the verifier and the escrow calls to the escrow. Its preflight route downloads and hashes the file before Fund is enabled, as a safeguard only: the validators decide. |

**The code in this repo is the code that is deployed.** `node scripts/verify-deployed.mjs` downloads the deployed source of both contracts from Bradbury (and with `NETWORK=studionet` from the hosted Studio network) and compares it with the files here. At the time of writing both are identical, byte for byte (output in `scripts/verify-deployed.txt` for Bradbury and `scripts/verify-deployed-studionet.txt` for Studionet):

| Contract | Address | sha256 of the source (the same on chain and in this repo) |
|---|---|---|
| Escrow, Bradbury | [`0xd325abD9d0cAE02594Ec7dEe53091CCa2356983e`](https://explorer-bradbury.genlayer.com/address/0xd325abD9d0cAE02594Ec7dEe53091CCa2356983e) | `df2656eab46cac65...3657a5451` |
| Verifier, Bradbury | [`0x6508856DE231e094BfD121Eb5A30D5C3c03972A9`](https://explorer-bradbury.genlayer.com/address/0x6508856DE231e094BfD121Eb5A30D5C3c03972A9) | `4d4f87374f8ff1ec...fa25b524` |
| Escrow, Studionet | [`0x85223A7f0C589Bd14Eb2207C618de20c8bE4E157`](https://explorer-studio.genlayer.com/address/0x85223A7f0C589Bd14Eb2207C618de20c8bE4E157) | `df2656eab46cac65...3657a5451` |
| Verifier, Studionet | [`0xB1c2504851805F3B2c9F4355bf7B78aeFd95738E`](https://explorer-studio.genlayer.com/address/0xB1c2504851805F3B2c9F4355bf7B78aeFd95738E) | `4d4f87374f8ff1ec...fa25b524` |

The verifier started life as a standalone, reusable contract ([Lineage](https://github.com/2TheMoom/lineage), which anything can use for digest attestations with chains of custody). Lading reuses that exact deployment, and its source and its tests are now part of this repository too (59 tests of the verifier itself, and 31 more that run the validators' vote), so the complete path from a URL to a payout can be reviewed here without leaving it.

## How it works

Two contracts, deliberately separate:

- **Verifier** (`contracts/lineage.py`, also published on its own as [Lineage](https://github.com/2TheMoom/lineage)). It fetches and hashes the files, gets the validators to agree, records, per release, the sha256 validators computed and whether the publisher's checksum list agrees, ties a build to its source, and can pin who vouched. It never touches money.
- **Escrow** (`contracts/lading.py`, this repo). It holds the GEN and reads the verifier's **finalized** state. Its verifier address is fixed at deployment: there is no setter.

```
create_engagement  client funds GEN: artifact URL, publisher's checksum list, filename,
                   optional source it was built from, a publisher pin, optional agreed digest
accept             the provider passes the sha256 of those exact terms
submit             the provider says it is ready
verify             anyone: needs the verifier's FINALIZED state to vouch for the whole chain under the pin
(watch window)     at least an hour; anyone can ask validators to re-check the files
release            anyone, after the window: needs a check of EVERY link made after the window closed
                   (judged by this contract's own clock) and finalized. Records an outcome, moves no money
refund_drift       anyone: the finalized verifier no longer vouches for what was verified. Records a refund
settle             anyone: pays the recorded outcome, once, in its own transaction
reclaim_timeout    client: cancel an unaccepted proposal, or reclaim after the deadline
reclaim_stale      client: a submission that was never verified. Anyone: a verified release nobody could confirm (even split)
```

A decision (`release`, `refund_drift`) and its payment (`settle`) are never in the same transaction, and no transaction contains both a verifier read and a payment. That is the lesson from our earlier work: a leader rotation can leave a stray transfer message behind a nondeterministic block.

### What "verified" means

The verifier's verdict is deterministic: each validator downloads the artifact and the list itself, hashes it with sha256, and they must agree on the verdict (verified, mismatch, unlisted, unbound, drifted). An error, a timeout or a 404 never becomes a verdict: it records nothing. The escrow adds its own rules on top, so it does not take the verifier's word on faith:

- the answer must be about this attestation, with a real status and a 64 digit digest;
- every link of the chain must be vouched for under the **publisher pin** the client chose;
- the verifier's own `trusted` flag must be a real boolean and true;
- an optional **agreed digest** pins the exact sha256: a client who already knows the hash of the build they want can only ever pay for that file.

### What the client is protected from

- **A swapped file after verification.** Release needs every link checked again after the watch window and that check finalized. If the file changed, the check records `drifted`, nobody can release, and `refund_drift` refunds the client.
- **A self-made chain on the provider's own site.** The pin is a prefix every link's list must live under, and the provider accepts the pin in the terms hash.
- **A wrong file under a right name.** An agreed digest, or the publisher's list, must match the computed digest.
- **A provider who never delivers or a release nobody can confirm.** Timeouts and stale recovery, with no way to lock funds indefinitely.

## Live deployment

Deployed on **GenLayer Bradbury Testnet** (chain ID 4221):

- **Escrow:** [`0xd325abD9d0cAE02594Ec7dEe53091CCa2356983e`](https://explorer-bradbury.genlayer.com/address/0xd325abD9d0cAE02594Ec7dEe53091CCa2356983e) (the audited contract; the first deployment, [`0xacc591981a7F4B059aE9E5C9a4Cd79aC7fe56A45`](https://explorer-bradbury.genlayer.com/address/0xacc591981a7F4B059aE9E5C9a4Cd79aC7fe56A45), is superseded and kept only for the round 1 evidence below)
- **Verifier (Lineage v2):** [`0x6508856DE231e094BfD121Eb5A30D5C3c03972A9`](https://explorer-bradbury.genlayer.com/address/0x6508856DE231e094BfD121Eb5A30D5C3c03972A9)
- **App and landing page:** https://lading-frontend.vercel.app (try [a settled delivery](https://lading-frontend.vercel.app/app/d/lad-mvb2wtva-happy))

### Studionet: deployed, but the escrow cannot verify there

Both contracts are also deployed on **Studionet**, the hosted Studio network (chain ID 61999), from the same source and with no change to either contract:

- **Escrow:** [`0x85223A7f0C589Bd14Eb2207C618de20c8bE4E157`](https://explorer-studio.genlayer.com/address/0x85223A7f0C589Bd14Eb2207C618de20c8bE4E157)
- **Verifier (Lineage v2 source):** [`0xB1c2504851805F3B2c9F4355bf7B78aeFd95738E`](https://explorer-studio.genlayer.com/address/0xB1c2504851805F3B2c9F4355bf7B78aeFd95738E)

Funding, accepting, submitting, cancelling and reclaiming all work there, and Studio finalizes in under a minute. The escrow's `verify` does not: it reads the verifier at `LATEST_FINAL`, and on Studionet a contract-to-contract read at `LATEST_FINAL` never returns. [`docs/studionet-nested-final-read-probe.py`](docs/studionet-nested-final-read-probe.py) is a minimal contract that shows it (on Studionet a direct read at that state answers in 1.4 s, a nested read at the default state in 1.3 s, a nested read at `LATEST_FINAL` gave no answer in 120 s). The escrow will not pay on anything less than a finalized verdict, so it was not changed to fit Studio. **The live app, the evidence below and the payout path are Bradbury.**

The scripts and the web app can target either network (`NETWORK=studionet` for the scripts, `NEXT_PUBLIC_GENLAYER_CHAIN_ID=61999` for the app). The tests of the app's receipt and network handling are in `frontend/lib/tx.test.ts`. The Studionet run logs are `scripts/e2e-log-studionet*.json`.

## Security model

The threat list was written before the code and each row is tested.

| Threat | Defense | Test |
|---|---|---|
| Money paid twice, or paid to the wrong party | `settle` is the only path from a decision to money; it needs status `decided`, marks `settled`, and each (engagement, party) payout is recorded once. Direct refunds (`reclaim_*`) also end in `settled`. The amounts must sum to the escrow | settle/terminal-state tests, accounting tests |
| A verifier error mistaken for a verdict | An unreadable or wrong-shaped answer is `read=False`, which refuses everything. In particular `refund_drift` never refunds on an error | `test_an_unreadable_verifier_is_never_taken_for_drift`, junk-answer tests |
| A lying or buggy verifier | The escrow re-checks the leaf's id, status and digest shape, the type of every answer, and that every link's list is under the pin | `test_the_escrow_does_not_take_the_verifiers_trusted_flag_on_faith` |
| A verdict that could still be appealed away | The escrow reads `LATEST_FINAL` only | `test_verify_reads_the_verifiers_finalized_state_for_this_exact_attestation` |
| Paying against a stale check | Freshness is judged by this contract against its own stored window end, not by the verifier's clock (which inside a finalized-state read is not something to rely on) | `test_release_never_relies_on_the_verifiers_clock`, boundary tests |
| The provider changes the terms after accepting | Terms are immutable; `accept` passes a digest of every term including the provider, pin and agreed digest | `test_the_terms_hash_covers_every_term` |
| A transfer inside a transaction with a nondeterministic block | There is no nondeterministic block, no model and no web request in this contract at all | `test_the_contract_has_no_model_and_no_nondeterministic_block` |
| The verifier being swapped for a malicious one | Fixed in the constructor, no setter, no owner | `test_the_verifier_is_fixed_for_the_life_of_the_contract` |
| Attestation id squatting or collision | The id is the sha256 of artifact, list, filename and parent; `\|` is refused in URLs; the escrow derives the id itself with the same URL rules | id and URL tests |
| A caller acting out of role | Provider-only, client-only and permissionless entry points, each tested for the wrong caller | access tests |
| Funds locked forever | Deadline (at most two years out), stale recovery for both stuck states, a bounded window and stale range | timeout and stale tests, live runs |
| A recorded drift turned into half the escrow by waiting for the stale point | Stale recovery of a verified release is refused while the verifier's finalized state shows drift (or a different digest) or a fresh check on every link; it only records the split, and `settle` pays it | `test_a_stale_split_cannot_override_a_drift_the_verifier_already_recorded`, the digest-changed and release-ready variants, the live `driftstale` run |

**Known and disclosed, not hidden:**

- **A refused payable call keeps its value on Bradbury.** The contract cannot return it (a refused call rolls back its own state and can emit nothing), so every rule is checked before anything is sent: the app validates the form and downloads and hashes the file first. A script that sends value with invalid arguments loses that value. `get_accounting` reports any such surplus as `in_flight`, and the live run tracks it as a known amount.
- **The publisher's list is trusted.** If a publisher is compromised and replaces the file and the list together, the first reading is whatever was served. Lading makes later silent changes visible. It does not make the first publication honest. The agreed digest removes this for a client who knows the hash.
- **The parent link is vouched for by the publisher's list, not proven.** Lading checks one list names both files. It cannot show the build was compiled from that source.
- **Artifacts are capped at 4,000,000 bytes** (the verifier's limit, set by the per-transaction gas cap on Bradbury) and lists at 500,000. Larger files are refused, never cut short. This covers source tarballs and single binaries, not container images or installers.
- **Finality is slow.** About 30 minutes on Bradbury, so a watch window is at least an hour and the app says "recorded, not final" until a transaction finalizes.
- Hostnames are filtered by name, so a public name that resolves to a private address (wildcard DNS) is not caught by the contract. Redirects are followed by the platform's fetcher and are not inspected. The app's preflight resolves hosts and refuses private addresses, but it is advisory: the contract and validators decide.
- GitHub's raw host caches for about five minutes, so an edited demo file takes that long to become visible to a re-check.

## Tests

| Test type | Command | What it covers |
|---|---|---|
| Lint | `genvm-lint check contracts/lading.py` | static checks |
| Direct | `python -m pytest tests/direct/ -v` | 121 in-memory tests with a fake verifier that models the real one and records every call |
| Verifier | `python -m pytest tests/direct/test_lineage.py -v` | 59 tests of the verifier itself: the fetch results, unreadable and oversized sources, the checksum list rules, drift, chains of custody and publisher pinning |
| Validator consensus | `python -m pytest tests/direct/test_lineage_consensus.py -v` | 31 tests that run the validators' vote: a validator that downloads the same bytes accepts, and one that sees different bytes, a different list, an unreadable source, or a leader result with any field altered, forged or of the wrong shape rejects |
| Verifier mutation | `python scripts/mutate-verifier.py` | breaks the fetch, hash, vote and verdict code 27 ways, one at a time: all 27 are caught |
| Deployed code | `node scripts/verify-deployed.mjs` | downloads both deployed contracts and compares them with the files in this repo |
| Frontend logic | `cd frontend && npm test` | 53 tests: action rules, limits mirrored from the contract, decoding, finality rules, read errors |
| Live | `LADING=0x... node scripts/e2e.mjs` | the Bradbury run described below, separate client, provider and third-party wallets |

Every rule was mutation-checked: 118 deliberate breakages of the contract, 114 caught by a test. Four survive. Three are the payout bookkeeping (the amounts-sum check, the duplicate-payout guard and the payout record), which sit behind the status machine: no input can reach them, so they stay as a second line of defense. The fourth is an equivalent mutant (dropping a `read` check that an `ok` check already implies), so no test can tell it apart.

## Audit before the demo

Before any demo or wallet run the whole stack was audited again, by reading it, by attacking it, and by running it. Seven things were found and fixed. The first one is the serious one.

| # | Where | What was wrong | Fix |
|---|---|---|---|
| 1 | Contract: `reclaim_stale` on a verified release | It paid an even split without asking the verifier anything. After the stale point the provider (or anyone) could turn a drift the verifier had already recorded into half the escrow, and the client lost the other half they were owed. A failing test proved it first. | The split is now only recorded (`decided`, outcome `split`) and `settle` pays it, so no payment shares a transaction with a verifier read. It is refused while the verifier's finalized state shows drift or a changed digest, and while a fresh check on every link means `release` applies. An unreadable verifier still allows the split, because unreadable means "nobody could confirm it", never drift. |
| 2 | Contract: deadline | A deadline past the u256 range would fail when stored, and a refused payable call keeps its value on Bradbury. | The deadline must be within two years. Boundary tested. |
| 3 | App: the form | The contract checks the whole URL for forbidden characters and length before it drops the fragment. The form dropped the fragment first, so a pasted URL like `...#a b` passed the form and was refused on-chain, stranding the funds. | The form validates the raw URL. A differential fuzz of the contract's own URL and filename rules against the form's, about 52,000 inputs over four seeds, now finds nothing the form allows that the contract refuses. The form is stricter in one place only (U+FEFF). |
| 4 | App: `/api/preflight` | It resolved a host to check it, then resolved again to connect, so a hostile DNS server could answer "public" for the check and "internal" for the connection. | The address is checked at connect time, inside the connection's own lookup, and compression is off so a decompression bomb cannot hide in a small download. Checked live: loopback, link-local metadata and 10.x hosts are refused. |
| 5 | App: reads | Any dropped RPC call was reported as "No delivery called ...", or silently removed a row from the list. | Only a refusal by the contract means "not found"; a network failure is an error, the page keeps what it had, and offers to try again. |
| 6 | App: stale recovery | The buttons, labels and finality checks assumed the split pays at once. The settle button said "refund the client" on a split. | The app now knows the split takes two steps, says so, says why a split is blocked (a drift or a ready release), and labels the settle button correctly. |
| 7 | App: funding | The verifier registration that comes before funding was reported as "Escrow funded: recorded", and its finality toast said "Escrow funded, final", before any money had moved. | A transaction to the verifier is reported in the verifier's words ("Release registered with the verifier"). |

Method, so the claims can be checked: the contract fix was written test first (the new tests failed against the old contract), then the contract was mutation-checked again (118 mutants, 114 caught; four survivors, explained above), the form was fuzzed against the contract's own rules, and then everything below was run live against a fresh deployment of the fixed contract.

<!--LIVE_START-->
## Live evidence, round 2: the audited contract (Bradbury)

Escrow `0xd325abD9d0cAE02594Ec7dEe53091CCa2356983e`, verifier `0x6508856DE231e094BfD121Eb5A30D5C3c03972A9` (Lineage v2, unchanged). Deployed with `scripts/deploy.mjs`. `scripts/e2e.mjs` ran the happy, agreed, stale, drift-then-stale and cancel scenarios with a **separate client wallet, provider wallet and third-party wallet**, and every write was confirmed by reading state back (full machine-readable log: `scripts/e2e-log-v3.json`, run `mvb2wtva`). The plain drift scenario was not repeated on this contract: `refund_drift` was not touched by the audit and its round 1 run below still applies; the new `driftstale` run exercises it again at the stale point.

What round 2 adds that round 1 could not show: the even split is recorded in one transaction and paid in another, and a drift that the verifier has already recorded cannot be turned into half the escrow, even after the stale point, even by the provider.

#### Happy path: the real jq 1.7.1 release (source tarball, then the linux-amd64 binary built from it), agreed digest

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `escrow.create_engagement` | [`0xdea338b13b`](https://explorer-bradbury.genlayer.com/tx/0xdea338b13b3ebae1bf53aefc67f981209293fc642ba56e53a4429a8f00a3edcd) | accepted |
| 2 | `escrow.accept` | [`0x4b3b232b06`](https://explorer-bradbury.genlayer.com/tx/0x4b3b232b06fc5b175e91a804e8e4608f0fe24ff50e6d4247d3ca0a87ab0fe2a8) | accepted |
| 3 | `escrow.submit` | [`0x29d0ba20ad`](https://explorer-bradbury.genlayer.com/tx/0x29d0ba20ada8cd757637eb36d880e912d6005efe527e1543deb8b3f2659cf6ef) | accepted |
| 4 | `escrow.verify` | [`0x93ffa37e1b`](https://explorer-bradbury.genlayer.com/tx/0x93ffa37e1b874292ee5aece6dcc17a2baa0f8fca482bcbeb3325d18adcfaf041) | accepted |
| 5 | `escrow.refund_drift` | [`0x0cb2c8b388`](https://explorer-bradbury.genlayer.com/tx/0x0cb2c8b388bdb61ab6f1feee6b99e224e12af12c625687250b3d4bd449c551eb) | refused by the contract (state unchanged) |
| 6 | `escrow.release` | [`0x5d49e3fa31`](https://explorer-bradbury.genlayer.com/tx/0x5d49e3fa31e66011fb11224dffd7f506fe99907107f0052d3c373fd07e73f239) | refused by the contract (state unchanged) |
| 7 | `verifier.check` | [`0xb38359773d`](https://explorer-bradbury.genlayer.com/tx/0xb38359773d8ef3b93d5825de4a28615cfd99979035ddca0688237d15e9533b30) | accepted |
| 8 | `verifier.check` | [`0xd37b650f19`](https://explorer-bradbury.genlayer.com/tx/0xd37b650f19563f5b489668d2ad0de79b380e1fcee525e45e5c81a02b26df4e61) | accepted |
| 9 | `escrow.release` | [`0x492d704c57`](https://explorer-bradbury.genlayer.com/tx/0x492d704c570efc291dbf931c3e5ea33010236ceb9d05d657a32e9bc8f158181a) | refused by the contract (state unchanged) |
| 10 | `escrow.release` | [`0xefef5f6189`](https://explorer-bradbury.genlayer.com/tx/0xefef5f61895d538bf0ce825802fb7a66d09875ac1daec7e25325b9b3404a37c5) | accepted |
| 11 | `escrow.release` | [`0xfe46a00d90`](https://explorer-bradbury.genlayer.com/tx/0xfe46a00d90b64ccad299864f5278afc967e9fb2d7dbdc9f43d69028dae3f0a0a) | refused by the contract (state unchanged) |
| 12 | `escrow.settle` | [`0x67e0987dd5`](https://explorer-bradbury.genlayer.com/tx/0x67e0987dd54fd82ca65b80262e9a90322394cb559303fb77031fa60eef0efc3a) | accepted |
| 13 | `escrow.settle` | [`0x15f7e84919`](https://explorer-bradbury.genlayer.com/tx/0x15f7e84919ddb87b8272d30679c5a5d8bca37a8c47ed7f5c6c8841d5aef9aee1) | refused by the contract (state unchanged) |

- verified on attempt 1: digest 5942c9b0934e510e..., links 2, window ends 2026-10-16T15:48:15.000Z
- watch window open until 2026-10-16T15:48:15.000Z, waiting 60 min
- post-window check of the source FINALIZED 29.4 min after the wait began
- post-window check of the build FINALIZED 0.4 min after the wait began
- release attempt 1 not accepted (exec FINISHED_WITH_RETURN), waiting
- settle FINALIZED 30.1 min after the wait began

#### The verdict is fine but is not the digest the client agreed to

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `escrow.create_engagement` | [`0x555b37c047`](https://explorer-bradbury.genlayer.com/tx/0x555b37c047f16f20d120611627704d6f45d62fe29ce839fee32d2a930416ae14) | accepted |
| 2 | `escrow.accept` | [`0x806983b0a3`](https://explorer-bradbury.genlayer.com/tx/0x806983b0a346f11369427827a5b93d02ea3992c8db1c311702f2025fea216298) | accepted |
| 3 | `escrow.submit` | [`0x603baae3a0`](https://explorer-bradbury.genlayer.com/tx/0x603baae3a07569800602d1325578be11fcf7d93124d6b2d96b255479b7435205) | accepted |
| 4 | `escrow.verify` | [`0xcdc905832a`](https://explorer-bradbury.genlayer.com/tx/0xcdc905832a9a1347990252227038e752c268871ee09921695e7544692e40f824) | refused by the contract (state unchanged) |
| 5 | `escrow.reclaim_stale` | [`0xed6cf0a8d4`](https://explorer-bradbury.genlayer.com/tx/0xed6cf0a8d463014f860b49f861c7ee4b92c90eb0c13b75cd28e4f8410f0630ab) | refused by the contract (state unchanged) |
| 6 | `escrow.reclaim_stale` | [`0x3362a4429a`](https://explorer-bradbury.genlayer.com/tx/0x3362a4429af6c745100cb0d86df873d571501766b198edd6a698f6845dc6cb76) | refused by the contract (state unchanged) |
| 7 | `escrow.reclaim_stale` | [`0x9d572ed93f`](https://explorer-bradbury.genlayer.com/tx/0x9d572ed93f66f7fddf313501c3436c6de222803234916a1fc5c0bd3f2112f990) | accepted |

- stuck submission, recoverable at 2026-10-16T17:00:13.000Z, waiting 134 min
- reclaim_stale FINALIZED 30.0 min after the wait began
- refunded: outcome client/stale; client balance 4.897306 -> 4.899155 (before its own gas)

#### Verified, but nobody confirms it again: the even split is now recorded, then paid in its own transaction

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `escrow.create_engagement` | [`0x9d27d56992`](https://explorer-bradbury.genlayer.com/tx/0x9d27d56992b8a61dde8f5feb6f65a58fca07ad444c126206b56c35bc33ce5c81) | accepted |
| 2 | `escrow.accept` | [`0xb1b5875626`](https://explorer-bradbury.genlayer.com/tx/0xb1b5875626843cad95ced68a389e2ff0824a00e5a77fcc38078c596a46552c9a) | accepted |
| 3 | `escrow.submit` | [`0x0e7c3e546a`](https://explorer-bradbury.genlayer.com/tx/0x0e7c3e546a1800e1d8cc9460aadd3ff18d30b31b5e83b4daed8aba7baf08ffe0) | accepted |
| 4 | `escrow.verify` | [`0xd6a8161461`](https://explorer-bradbury.genlayer.com/tx/0xd6a816146185b7c9035a22c9e51229cb22af1206bf8518dee34c98ead358387b) | accepted |
| 5 | `escrow.reclaim_stale` | [`0x21567f2d14`](https://explorer-bradbury.genlayer.com/tx/0x21567f2d1461ba6e081ef415ecc1bbd81ba92ea7366b25b875e3bf77c27823e3) | refused by the contract (state unchanged) |
| 6 | `escrow.release` | [`0x338734911e`](https://explorer-bradbury.genlayer.com/tx/0x338734911e1989b718d6d6531e97431f18080e265acb750daae038dc36281d6c) | refused by the contract (state unchanged) |
| 7 | `escrow.reclaim_stale` | [`0x5cfbbf6a24`](https://explorer-bradbury.genlayer.com/tx/0x5cfbbf6a24527c2494a737bc8cda77ce6d5e005a2931f3adc722fcf3e0900604) | accepted |
| 8 | `escrow.reclaim_stale` | [`0xbfd2a7942a`](https://explorer-bradbury.genlayer.com/tx/0xbfd2a7942aa5b1caddecca463789308fb72cd5e78f8970021b73d33d1c3bca3f) | refused by the contract (state unchanged) |
| 9 | `escrow.settle` | [`0x693f574846`](https://explorer-bradbury.genlayer.com/tx/0x693f574846b0ef0ef7e95b60a824732e0c7b7358720fc61a682dce3716bf0373) | accepted |

- verified on attempt 1: digest a927dc83b4013aa1..., links 1, window ends 2026-10-16T15:46:58.000Z
- nobody confirms it again; stale point 2026-10-16T17:46:58.000Z, waiting 120 min
- reclaim_stale (records the even split, moves no money) FINALIZED 30.1 min after the wait began
- FAILED: stale: settle (pays the split) did not finalize in time

#### A recorded drift outlives the stale point: nobody can turn it into half the escrow

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `verifier.attest` | [`0x79472faa60`](https://explorer-bradbury.genlayer.com/tx/0x79472faa60985edcc0fc1d6b16ef6f43a3a8c02acd737c6505a694686c21fece) | accepted |
| 2 | `verifier.check` | [`0x9d7e6e36dc`](https://explorer-bradbury.genlayer.com/tx/0x9d7e6e36dc0c20e8918aeaf5cf988a9fe45f4c3c771c47097520cc052f84a7e5) | accepted |
| 3 | `escrow.create_engagement` | [`0x27d5ac6823`](https://explorer-bradbury.genlayer.com/tx/0x27d5ac68236f94fc2a685417b893db77ffc1798666a52e0fed44476a88dd3ca8) | accepted |
| 4 | `escrow.accept` | [`0x02e1362380`](https://explorer-bradbury.genlayer.com/tx/0x02e1362380099fc2cbfe620f0a7655a9b29702a99f129e179d3822ded43fa65c) | accepted |
| 5 | `escrow.submit` | [`0x6ff1022ca8`](https://explorer-bradbury.genlayer.com/tx/0x6ff1022ca864c4f7b92b82466be91b3245f5fe242dd784c4ebfd6b1af8139d04) | accepted |
| 6 | `escrow.verify` | [`0xa623c7a6f5`](https://explorer-bradbury.genlayer.com/tx/0xa623c7a6f5a3a2159b81bb290d9ba7c178ec8a46ce72c626a68751f17de5f73b) | accepted |
| 7 | `verifier.check` | [`0x18d206924f`](https://explorer-bradbury.genlayer.com/tx/0x18d206924f98b3690732735ce6f39a81afbb01ca2e19de8d0029d0f2672cae27) | accepted |
| 8 | `escrow.reclaim_stale` | [`0xb5cea26542`](https://explorer-bradbury.genlayer.com/tx/0xb5cea265428aad091c2e48ba6f99d0135b0ebfbb5cb453d03e4eed433e65e8d9) | refused by the contract (state unchanged) |
| 9 | `escrow.reclaim_stale` | [`0x58a4af0690`](https://explorer-bradbury.genlayer.com/tx/0x58a4af0690988c58c1a4070f478b806d74c097e841792566711f65d1587d61a9) | refused by the contract (state unchanged) |
| 10 | `escrow.refund_drift` | [`0x0a7df25cbf`](https://explorer-bradbury.genlayer.com/tx/0x0a7df25cbf59926baf7192b8b55cd8e1e693634e79e8d36d72c65f18ba3d7309) | accepted |
| 11 | `escrow.settle` | [`0xac353c260d`](https://explorer-bradbury.genlayer.com/tx/0xac353c260d8bf991bfba62cc304476fbef77bddbf04216d6b85ce0051c9f36da) | accepted |

- check of pack-driftstale.txt FINALIZED 30.1 min after the wait began
- verified on attempt 1: digest 63acb8d395cd6ffa..., links 1, window ends 2026-10-16T16:17:22.000Z
- file replaced and pushed (exit 0); waiting for the raw cache to expire
- the verifier now says drifted
- re-check that recorded the drift FINALIZED 30.1 min after the wait began
- drift is recorded and final; waiting for the stale point 2026-10-16T18:17:22.000Z WITHOUT asking for the refund

#### A refused payable call, wrong callers, and a client cancel

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `escrow.create_engagement` | [`0x357f92a35b`](https://explorer-bradbury.genlayer.com/tx/0x357f92a35ba8f9f291cd64443a29d9321f00dab30ce3e8daab2cdedcfd7e898f) | refused by the contract (state unchanged) |
| 2 | `escrow.create_engagement` | [`0x367aea87e8`](https://explorer-bradbury.genlayer.com/tx/0x367aea87e814b565475ecd0e6eaa3989da02033d20fb9d6758b02419c7548d8d) | accepted |
| 3 | `escrow.reclaim_timeout` | [`0xfd6a629568`](https://explorer-bradbury.genlayer.com/tx/0xfd6a629568bfc56db6a167571a6ba246b0ed1639d067fffd1f98124374239d7a) | refused by the contract (state unchanged) |
| 4 | `escrow.reclaim_timeout` | [`0x3ed3173f9a`](https://explorer-bradbury.genlayer.com/tx/0x3ed3173f9aaec0946a77556474da618cb25c7bf74e88e028e0641c9a4fa9f77a) | refused by the contract (state unchanged) |
| 5 | `escrow.reclaim_timeout` | [`0x54264bdb6e`](https://explorer-bradbury.genlayer.com/tx/0x54264bdb6e07fb0961f3e46f2388f2c383fc8dac6d5a96540f6bebed04ab0bbd) | accepted |
| 6 | `escrow.reclaim_timeout` | [`0x4b4f02195a`](https://explorer-bradbury.genlayer.com/tx/0x4b4f02195a341f7cc9e952cfe35b6b5b774895200a6dabdaf704022f9c1b373f) | refused by the contract (state unchanged) |

- reclaim_timeout FINALIZED 29.6 min after the wait began

Two transactions in the table are worth reading closely. In the drift-then-stale run, the provider's own `reclaim_stale` was refused before it was even sent (the node's pre-flight simulation reverted it), and the third-party and client attempts that were sent were refused by the contract with state unchanged; the client's `refund_drift` and `settle` then returned the full 0.002 GEN. In the stale run, the first `reclaim_stale` only recorded the split, a second one was refused, and `settle` paid it.

A note on honesty about the run itself: the script lost its network connection for a while near the end (a stream of "fetch failed" errors), so its own last finality waits for the stale and drift-then-stale settles timed out and it printed an accounting mismatch. Nothing on chain was affected. Read straight from the chain afterwards: all five engagements are `settled` with the outcomes above, every `settle`, `refund_drift` and `reclaim_stale` transaction is `FINALIZED` with `FINISHED_WITH_RETURN`, and once the app-driven engagement described next was also settled, the final accounting is `{"balance": 1, "in_flight": 1, "shortfall": 0, "total_received": "12000000000000000", "total_scheduled": "12000000000000000", "unscheduled": 0}`: every GEN received was scheduled out exactly once, nothing is short, nothing is owed, and the only balance is the 1 wei a refused payable call left behind.

### The audited app, driven with fresh wallets: stale recovery

The new two-step stale recovery was also driven through the app's own buttons against the audited contract, with wallets no script was using: a client (`gl-test-4`), a provider (`gl-test-5`) and a third party (`gl-test-3`), signing through the wallet shim. The engagement is `lad-ui-stale`, a 91-byte demo file (`demo/pack-uistale.txt`), 0.002 GEN, a one hour watch window and a two hour stale period.

| Step | Who | What the app did |
|---|---|---|
| Fund | client | The form's preflight downloaded and hashed the file (match, 91 bytes) before Fund was enabled. Funding registered the release with the verifier, then created the escrow. |
| Accept, ship, check | provider | Accepted the exact terms, marked it shipped, asked the validators to check the file. |
| Verify too early | provider | Pressed Verify before the check had finalized. The contract refused it and the app said so: "The contract refused verify. Nothing changed." |
| Verify | provider | After the check finalized, Verify succeeded: "Verified: the digest matches", watch window running. |
| After the stale point | third party | Nobody re-checked the file after the window. The app offered **Record an even split** and kept Record the release and Record a refund greyed out, as they should be. |
| Record the split | third party | [`0xd1e7a811a7`](https://explorer-bradbury.genlayer.com/tx/0xd1e7a811a7d2639faf6155a13df04754f808219615a9d25b2de8bacd5ed14291) recorded "split evenly" and moved no money; the app said so and the button became **Settle: split evenly**. |
| Settle | third party | [`0xa13f9d3d6a`](https://explorer-bradbury.genlayer.com/tx/0xa13f9d3d6afa457200d3bd33f2d1326176b6c5842c74b30706d17a0058a8b574) sent. |

Result, read from the chain afterwards: both transactions above are `FINALIZED` with `FINISHED_WITH_RETURN`, the engagement is `settled` with outcome `split` and reason `stale`, and the two wallets' balances rose by exactly **0.001 GEN each** (`1000000000000000` wei for the client and `1000000000000000` wei for the provider). Neither wallet sent anything else in that time, and the settle was paid for by the third party, so the differences are the payout. The first transaction recorded the split and moved no money; the second paid it, once.

Running the app also found two honesty problems that were fixed in the app (see the audit table): the verifier registration before funding was reported as "Escrow funded", and the settle button said "refund the client" on a split.

### The audited app in a real MetaMask, on the live site

The deployed app (https://lading-frontend.vercel.app) was driven end to end with the real MetaMask extension and two of its accounts, a client (`0x1a87...e5fb`) and a provider (`0x0917...7969`), against the audited escrow. Every transaction below was approved by hand in MetaMask's own window; the page was driven by a browser tool and watched through the console for errors (none appeared in any step) and recorded. The wallet was in a browser with five wallet extensions installed, which is how the first bug below was found.

| Step | Account | What was pressed | Transaction (first 12 hex digits) | Result |
|---|---|---|---|---|
| 1 | client | Fund `lad-mm-1` (0.002 GEN, real jq 1.7.1 release with its source, pin on the jq release path) | `0xa02c2f793400` | recorded, then finalized |
| 2 | provider | Accept these terms | `0x5cbb271bd622` | recorded |
| 3 | provider | Mark as shipped | `0x22276b237f70` | recorded |
| 4 | provider | Verify now (2 links vouched for in finalized state) | `0xdb88bf6e6c94` | recorded; watch window of one hour started |
| 5 | client | Fund `lad-mm-2` (0.002 GEN) | `0x0bcd8883b359` | recorded |
| 6 | client | Cancel and reclaim `lad-mm-2` | `0xa87c081425d9` | recorded; refund delivered at finality |
| 7 | client | Ask validators to check 2 files, after the window closed (source) | `0x0a1ded271706` | recorded, finalized |
| 8 | client | Ask validators to check 2 files (build) | `0xbf452d224c36` | recorded, finalized |
| 9 | client | Record the release | `0x226d7f7a06dd` | recorded; moves no money |
| 10 | client | Settle: pay the provider | `0x03fd7db0fa78` | recorded, finalized about 30 minutes later |

(Only the leading digits are shown because the app's pending list, which is where these were read, shortens them. Every transaction is under the escrow's address in the explorer.)

What was checked, from the chain afterwards:

- After the settlement finalized, the provider's balance rose by exactly **0.002 GEN** (`2000000000000000` wei). The client signed the release and the settle, so the provider's wallet paid no gas and the difference is the payout. Before finality it had risen by 0.
- `lad-mm-1` is `settled` to the provider (reason "checked after the window"), `lad-mm-2` is `settled` to the client (reason "timeout"). The contract's accounting reads `{"balance": 1, "in_flight": 1, "shortfall": 0, "total_received": "16000000000000000", "total_scheduled": "16000000000000000", "unscheduled": 0}`: everything received was scheduled out exactly once, and the only balance is the 1 wei a refused payable call left behind.
- The app said "recorded, not final yet" under every write and "Finalized, funds delivered" only when the transaction had finalized. A reload in the middle (step 7 and 8) kept those notes and cleared them by itself when the transactions finalized.

#### What the real MetaMask run found

The scripted and shim-driven runs could not have found these. All three are fixed and deployed:

1. **The page froze on "Connecting" with several wallets installed.** The app talked to `window.ethereum`, which is whichever extension claimed it last. Rabby took it, and Rabby and Keplr never answered, so every request hung and MetaMask never saw one. The app now finds MetaMask by the wallet-discovery standard (EIP-6963), no longer uses the GenLayer client library's own connect step (it also reached for `window.ethereum`), and gives a silent wallet 5 seconds before showing "not connected". Commit `30078cd`.
2. **A reload turned "recorded, not final" into plain "Paid" or "Refunded".** The pending-writes list lived only in the page's memory. It is now kept in the browser's storage, and after a reload each unfinished write is watched until its transaction finalizes or fails. Commit `002117a`. (A simpler idea, comparing the latest state with a finalized read, was tried and dropped: the RPC returned the same state for both reads.)
3. **The app logged the user out when the wallet reported a dropped connection.** MetaMask's `disconnect` event only means the provider lost its chain connection for a moment, but the app treated it as "the user disconnected" and showed Connect wallet while MetaMask still had both accounts connected. The app now asks the wallet what is true. Commit `2a13bef`.

One thing seen and not changed: the status stamp reads "Refunded" or "Paid" as soon as the result is recorded, and the notes under it carry the "not final" warning. The stamp itself does not say so.

## Live evidence, round 1: the first deployment (Bradbury)

Escrow `0xacc591981a7F4B059aE9E5C9a4Cd79aC7fe56A45` (superseded by the audited contract above), verifier `0x6508856DE231e094BfD121Eb5A30D5C3c03972A9` (Lineage v2). `scripts/e2e.mjs` ran every scenario below against the deployed contracts with a **separate client wallet, provider wallet and third-party wallet**, and every write was confirmed by reading state back. Run `mva4y6rp` (`scripts/e2e-log-main.json`) did the happy, agreed, drift and stale scenarios; the cancel scenario was repeated alone after fixing a race in the script's own check (`scripts/e2e-log-cancel.json`, run `mvaew35p`). Money paths wait out real windows (one hour minimum) and Bradbury finality (about 30 minutes).

### Happy path: the real jq 1.7.1 release (source tarball, then the linux-amd64 binary built from it), pinned to the jq release path, with an agreed digest

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `escrow.create_engagement` | [`0xe34593a4c0`](https://explorer-bradbury.genlayer.com/tx/0xe34593a4c0cd6b77993df840e419b792ca2a6dc72db54d7801e4c5c076f03fdc) | accepted |
| 2 | `escrow.accept` | [`0x4803581119`](https://explorer-bradbury.genlayer.com/tx/0x48035811191d528048f7287534c3375006ab3dd07cd6c78e9cd2e9c94d86cbdf) | accepted |
| 3 | `escrow.submit` | [`0xfb4f2f8749`](https://explorer-bradbury.genlayer.com/tx/0xfb4f2f8749915f3f520d83175859b88b5c06a4459b94be83c66813ad9d684d33) | accepted |
| 4 | `escrow.verify` | [`0x997bcbc44f`](https://explorer-bradbury.genlayer.com/tx/0x997bcbc44f5413b1d3d375ecb390867040079b2192088226c00d06b45563d878) | accepted |
| 5 | `escrow.verify` | [`0x860afebe11`](https://explorer-bradbury.genlayer.com/tx/0x860afebe1101a526d9e3510b1526a87f00886da04f256aa7b494beda312557da) | refused, as it must be |
| 6 | `escrow.release` | [`0x51063afcb9`](https://explorer-bradbury.genlayer.com/tx/0x51063afcb959456d2233e136548eebb19cff886eec5c5c18bbc0be120384576f) | refused, as it must be |
| 7 | `escrow.refund_drift` | [`0xd83a36002d`](https://explorer-bradbury.genlayer.com/tx/0xd83a36002db8955196af9e4255a017d23d5294d12119e8a70c31e4392fc134ec) | refused, as it must be |
| 8 | `escrow.release` | [`0x1f9933b0a0`](https://explorer-bradbury.genlayer.com/tx/0x1f9933b0a0acda3520a7e8d3c7bbc5a6754c43975d56f698b2f56ff4f11f9ea5) | refused, as it must be |
| 9 | `verifier.check` | [`0x13295ecea9`](https://explorer-bradbury.genlayer.com/tx/0x13295ecea9ca2b465c52cade80c74e6e05c19945705f4e96a3410197cdc65f80) | accepted |
| 10 | `verifier.check` | [`0x255b0c8df8`](https://explorer-bradbury.genlayer.com/tx/0x255b0c8df8e4d2a79d2e7aa1079966ddf6a27aed3b8750e9431c042bb8c5d2f5) | accepted |
| 11 | `escrow.release` | [`0x2aaa91c6f0`](https://explorer-bradbury.genlayer.com/tx/0x2aaa91c6f00c95c965f0322f90650c20ca34d892b2af10a2236bc1b6c31fe3af) | refused, as it must be |
| 12 | `escrow.release` | [`0x285a729764`](https://explorer-bradbury.genlayer.com/tx/0x285a7297648d4b4c36bc0d73ac62e2ac0f8904969cdcfe85df0602855d56222b) | accepted |
| 13 | `escrow.settle` | [`0x0b1ecdca7e`](https://explorer-bradbury.genlayer.com/tx/0x0b1ecdca7e0dbea1555c84361cc84007100f87552e01006267a0c6c93ac0437e) | accepted |
| 14 | `escrow.settle` | [`0x2798e8faab`](https://explorer-bradbury.genlayer.com/tx/0x2798e8faab5a2743dd5d1b89619c25ce8c2527a2c3c3673094267118803a451b) | refused, as it must be |

- attempt 1: the verifier's finalized state does not vouch for it yet (exec FINISHED_WITH_RETURN), waiting
- verified on attempt 2: digest 5942c9b0934e510e..., links 2, window ends 2026-10-15T23:56:18.000Z
- watch window open until 2026-10-15T23:56:18.000Z, waiting 55 min
- post-window check of the source FINALIZED 29.5 min after the wait began
- post-window check of the build FINALIZED 0.2 min after the wait began
- settle FINALIZED 30.0 min after the wait began
- provider balance 4.993829 -> 4.995829 (escrow = 0.002000); outcome provider/checked after the window; scheduled before settle 2000000000000000

### The verdict is fine but is not the digest the client agreed to

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `escrow.create_engagement` | [`0x941e707a53`](https://explorer-bradbury.genlayer.com/tx/0x941e707a53d9e9f8f2cadf9575f7a9c93a20b964f3b1cdbe74ba2e2e081094aa) | accepted |
| 2 | `escrow.accept` | [`0xeb9e9c6f92`](https://explorer-bradbury.genlayer.com/tx/0xeb9e9c6f9276e04f974f19ca9684fd7e1381ad97cc10697e61518b386412eabb) | accepted |
| 3 | `escrow.submit` | [`0xae9a768bdd`](https://explorer-bradbury.genlayer.com/tx/0xae9a768bdd1764c280d5fd8c90a6908c79fcb33bd9d0a475b1f80f05221a52bb) | accepted |
| 4 | `escrow.verify` | [`0x3786ef79a0`](https://explorer-bradbury.genlayer.com/tx/0x3786ef79a0ffc5b817273553535a94d619f1204b6dbdf2ea3e52400bd2f4fb37) | refused, as it must be |
| 5 | `escrow.reclaim_stale` | [`0x14dd0905cc`](https://explorer-bradbury.genlayer.com/tx/0x14dd0905ccbac9dee28839fde7c30c38db926bc705c974b798fbed6354b7eb97) | refused, as it must be |
| 6 | `escrow.reclaim_stale` | [`0xf6652d2224`](https://explorer-bradbury.genlayer.com/tx/0xf6652d22242d69db87918dbcedd9dc3be782477279bf752df18f6b6dd43c6c9c) | refused, as it must be |
| 7 | `escrow.reclaim_stale` | [`0x54592f4668`](https://explorer-bradbury.genlayer.com/tx/0x54592f4668de04d74eabeb0be402d1288c96294cccbcb3399f9d4f850083998d) | accepted |

- stuck submission, recoverable at 2026-10-16T01:09:29.000Z, waiting 134 min
- reclaim_stale FINALIZED 30.2 min after the wait began
- refunded: outcome client/stale; client balance 4.907068 -> 4.908935 (before its own gas)

### A verified file is quietly replaced after verification

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `verifier.attest` | [`0x80f70cddde`](https://explorer-bradbury.genlayer.com/tx/0x80f70cddde5561834fb4259082fdbf5a7da0647708e1539965012262b94c6334) | accepted |
| 2 | `verifier.check` | [`0xddec0da7ca`](https://explorer-bradbury.genlayer.com/tx/0xddec0da7caec6eeeb39ea5ed023e1dc6676c6ed53092a99c35d6c78ba1c7e8c6) | accepted |
| 3 | `escrow.create_engagement` | [`0xbd5afead45`](https://explorer-bradbury.genlayer.com/tx/0xbd5afead45d1389a0f040d4d61c731e2df4f7c6f420e87a7c7c4112a5647b64d) | accepted |
| 4 | `escrow.accept` | [`0x1793119dd3`](https://explorer-bradbury.genlayer.com/tx/0x1793119dd32b2488e5afa4358c7fd14cbed812b81ed2881eddfdbf7cdf92023f) | accepted |
| 5 | `escrow.submit` | [`0x8ae9b8708e`](https://explorer-bradbury.genlayer.com/tx/0x8ae9b8708e2ac7fba8e48c77b54f131d23be1a212936059fe40a6567b01638ab) | accepted |
| 6 | `escrow.verify` | [`0xdd66b4dccf`](https://explorer-bradbury.genlayer.com/tx/0xdd66b4dccff31a282f1e86c5c74b66f1a5c3ca542ca0d5d11290b4f6c9508e75) | accepted |
| 7 | `escrow.verify` | [`0x33001a4298`](https://explorer-bradbury.genlayer.com/tx/0x33001a429870574c3e98f95bdd8c55cc190c467984771d1f3f62bfdd77f248e4) | refused, as it must be |
| 8 | `escrow.refund_drift` | [`0xfa35523903`](https://explorer-bradbury.genlayer.com/tx/0xfa35523903040e60043fb95d4d90399a33dc1dcf80a22c14cb9637339c96b4c2) | refused, as it must be |
| 9 | `verifier.check` | [`0x188756e1d8`](https://explorer-bradbury.genlayer.com/tx/0x188756e1d801d8d1c0a9c486d049e7a2df8d105e1031c1ba4aeba8c17ace633a) | accepted |
| 10 | `escrow.refund_drift` | [`0xe2e2dadf04`](https://explorer-bradbury.genlayer.com/tx/0xe2e2dadf04d130b4e33afdc3930a940c2b5cfcb7ab0fa8ae27f69a1e9fc62007) | refused, as it must be |
| 11 | `escrow.refund_drift` | [`0xb505bd4dd1`](https://explorer-bradbury.genlayer.com/tx/0xb505bd4dd15c0a50f4a45ce6ea2976ab19bc70a50c8c57339561f6334bbb5fc4) | accepted |
| 12 | `escrow.refund_drift` | [`0x7976f8bc00`](https://explorer-bradbury.genlayer.com/tx/0x7976f8bc00ee696853d7b1efc24064ba14c2bd21aa782e098fd878d54f3536bb) | refused, as it must be |
| 13 | `escrow.settle` | [`0xe5ab8293ed`](https://explorer-bradbury.genlayer.com/tx/0xe5ab8293ed0b4bf11f691a1fd6485ce3429ae4a01251242dbe691da16c80b64b) | accepted |

- check of pack-drift.txt FINALIZED 30.0 min after the wait began
- attempt 1: the verifier's finalized state does not vouch for it yet (exec FINISHED_WITH_RETURN), waiting
- verified on attempt 2: digest f94b4e13e54b951b..., links 1, window ends 2026-10-16T00:28:15.000Z
- file replaced and pushed (exit 0); waiting for the raw cache to expire
- the verifier now says drifted; committed f94b4e13e54b951b..., now d9e24fef75d2c03a...
- re-check that recorded the drift FINALIZED 29.6 min after the wait began
- refund_drift attempt 1 not accepted (exec FINISHED_WITH_RETURN), waiting
- settle FINALIZED 29.9 min after the wait began
- refunded after drift: outcome client/drifted; client balance 4.905068 -> 4.907068

### Verified, but nobody confirms it again (round 1: the split was paid in the same transaction, which the audit changed)

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `verifier.attest` | [`0xc5396e87f6`](https://explorer-bradbury.genlayer.com/tx/0xc5396e87f60af0c70c25b4ec5ca50b09903fb39afd6b9ae3bbd6c4c1acd7591f) | accepted |
| 2 | `verifier.check` | [`0x41e487f57f`](https://explorer-bradbury.genlayer.com/tx/0x41e487f57f50acd76a1e221630328d609b7c29fa23c067f8aa9a02e08b57f244) | accepted |
| 3 | `escrow.create_engagement` | [`0x00eee313d6`](https://explorer-bradbury.genlayer.com/tx/0x00eee313d6915f8a9602da7036d5ab911844d833fd2808981ec488d91fbd84bd) | accepted |
| 4 | `escrow.accept` | [`0xc1ae58c4b6`](https://explorer-bradbury.genlayer.com/tx/0xc1ae58c4b6618aaa23f16fadd0a8d06e3825705de8ca50080348fa58b90d8b00) | accepted |
| 5 | `escrow.submit` | [`0xae3a1b2265`](https://explorer-bradbury.genlayer.com/tx/0xae3a1b2265081d0f901f4f2a3e61fde116f5950afa8e339a68ee910c9749b437) | accepted |
| 6 | `escrow.verify` | [`0x659f5ba849`](https://explorer-bradbury.genlayer.com/tx/0x659f5ba84964335dd398d29c12488b024e8956ae714d8e0904fe8a5d88cc2b10) | accepted |
| 7 | `escrow.reclaim_stale` | [`0x5c3537cbcf`](https://explorer-bradbury.genlayer.com/tx/0x5c3537cbcf8731a7ff01aeb637b901ed990b281e5bdd8ab89d888034e8f4d9fb) | refused, as it must be |
| 8 | `escrow.release` | [`0xdaace76811`](https://explorer-bradbury.genlayer.com/tx/0xdaace76811e014ef0dd6bd6c99f5e8e8b9d29f8e971e03de2939a0f6e33bcc35) | refused, as it must be |
| 9 | `escrow.reclaim_stale` | [`0xc81f4a8199`](https://explorer-bradbury.genlayer.com/tx/0xc81f4a8199db9ae1d0e16dc5342fa9a4d0152e1ad56cd8c07157946842c3c45d) | accepted |

- check of pack-stale.txt FINALIZED 30.0 min after the wait began
- verified on attempt 1: digest a927dc83b4013aa1..., links 1, window ends 2026-10-16T00:27:21.000Z
- nobody confirms it again; stale point 2026-10-16T02:27:21.000Z, waiting 120 min
- reclaim_stale (even split) FINALIZED 30.1 min after the wait began
- split: outcome split/stale; provider +0.001000 (half = 0.001000), client +0.001000 (half, before its own gas)

### A refused payable call, wrong callers, and a client cancel

| # | Call | Transaction | Result |
|---|---|---|---|
| 1 | `escrow.create_engagement` | [`0x04092a11c6`](https://explorer-bradbury.genlayer.com/tx/0x04092a11c606b348b8c25ad51b8dfb147a59d28285e9d803cb49d1ee737e7da4) | refused, as it must be |
| 2 | `escrow.create_engagement` | [`0xcedb82cf7d`](https://explorer-bradbury.genlayer.com/tx/0xcedb82cf7d09430989d43d36b9d373cb1309bdc7a8e714f738ebbe37be902985) | accepted |
| 3 | `escrow.reclaim_timeout` | [`0xe809022dc4`](https://explorer-bradbury.genlayer.com/tx/0xe809022dc48d28e0604c8a561f0950dc05fd8c6091923c8bc27f0d47cef81786) | refused, as it must be |
| 4 | `escrow.reclaim_timeout` | [`0x283bcec21a`](https://explorer-bradbury.genlayer.com/tx/0x283bcec21a5d684da950a5fe44abe927c76db1f52c7ae50cee0f62fb0baf6111) | refused, as it must be |
| 5 | `escrow.reclaim_timeout` | [`0x507133afdc`](https://explorer-bradbury.genlayer.com/tx/0x507133afdceae67f395696d6b356296f4966c4ad470a7e739dbfd9c897af0ae2) | accepted |
| 6 | `escrow.reclaim_timeout` | [`0x256915c2f2`](https://explorer-bradbury.genlayer.com/tx/0x256915c2f24d274fa5df7a66ecc84594420a209085e77c769fd2cc5c617ea64a) | refused, as it must be |

- reclaim_timeout FINALIZED 29.8 min after the wait began

### Accounting

The run fails its own check unless the contract's `get_accounting` ends with nothing short, nothing in flight, and a balance equal to what is still owed plus only the wei that refused payable calls left behind.

- Main run: `{'balance': 2000000000000001, 'in_flight': 1, 'shortfall': 0, 'total_received': '12000000000000000', 'total_scheduled': '10000000000000000', 'unscheduled': 2000000000000000}`. OK: nothing short, nothing in flight; the only surplus is 1 wei kept from refused payable calls
- Cancel run: `{'balance': 2000000000000002, 'in_flight': 2000000000000002, 'shortfall': 0, 'total_received': '14000000000000000', 'total_scheduled': '14000000000000000', 'unscheduled': 0}`. MISMATCH (stranded 2): {"balance":2000000000000002,"in_flight":2000000000000002,"shortfall":0,"total_received":"14000000000000000","total_scheduled":"14000000000000000","unscheduled":0}

### The real app, driven with fresh wallets

The app was also run end to end in a browser against these same contracts, with two fresh wallets (a client and a provider) that no script was using. Every button below is the app's own; the wallet shim signs, nothing else is scripted. The first escrow (`lad-ui-1`, the real jq release with its source, and the app's preflight downloading and hashing both files before it let the form fund) went all the way to a payout; the second (`lad-ui-2`) was funded and cancelled.

| # | Wallet | What was pressed in the app | Transaction | Result |
|---|---|---|---|---|
| 1 | gl-test-4 (client) | Fund lad-ui-1 (create_engagement, 0.002 GEN, source + build, agreed digest empty, pin on the jq release path) | [`0xdbdaea497c`](https://explorer-bradbury.genlayer.com/tx/0xdbdaea497c6984b08770d4b0db13b424fbc4bc3617f3ca3b563fcff50c6fc5ed) | accepted |
| 2 | gl-test-5 (provider) | Accept the exact terms (accept) | [`0x7b3ee4a138`](https://explorer-bradbury.genlayer.com/tx/0x7b3ee4a138e412034215eea572634c0eeb2a3d3ec18a675da8eb2442e743acb8) | accepted |
| 3 | gl-test-5 (provider) | Mark as shipped (submit) | [`0xf5ef028abe`](https://explorer-bradbury.genlayer.com/tx/0xf5ef028abe264c68f8748ee519c84fa2160d51efdf636615747f796f3330d64b) | accepted |
| 4 | gl-test-5 (provider) | Verify now (verify): 2 links vouched for in finalized state | [`0xf96f553c74`](https://explorer-bradbury.genlayer.com/tx/0xf96f553c74f32457f9ce4670f7b324c8b43ab7e1da3ee76e93ef81842d51411d) | accepted |
| 5 | gl-test-4 (client) | Fund lad-ui-2 (create_engagement) | [`0x20c74f5d01`](https://explorer-bradbury.genlayer.com/tx/0x20c74f5d01bb2ef8c513fa9558004774dc0c4c4c67ea75e905349f20de6b768b) | accepted |
| 6 | gl-test-4 (client) | Cancel and reclaim lad-ui-2 (reclaim_timeout) | [`0x4b6cc588d2`](https://explorer-bradbury.genlayer.com/tx/0x4b6cc588d21c20aa3cf29f04b6dc9fbf086e4fa8236d0241d6917eda8588728e) | accepted, refunded after finality |
| 7 | gl-test-4 (client) | Ask validators to check the source (verifier.check), after the window closed | [`0x5b0efabd36`](https://explorer-bradbury.genlayer.com/tx/0x5b0efabd36da317c615c7a084aafe069b07c1f3846d66a6420f43e3b8b5f620c) | accepted |
| 8 | gl-test-4 (client) | Ask validators to check the build (verifier.check), after the window closed | [`0x2cbdb9c0c3`](https://explorer-bradbury.genlayer.com/tx/0x2cbdb9c0c3dc4c602a006ad504830e1a9a530445c98414bba729451c8879b3a1) | accepted |
| 9 | gl-test-4 (client) | Record the release (release) BEFORE the checks finalized | [`0x4969ef09ba`](https://explorer-bradbury.genlayer.com/tx/0x4969ef09bafec7549fe3b56649926410a8bcc784169b9385475dd996426c9974) | refused by the contract; the app reported "Release did not go through" |
| 10 | gl-test-4 (client) | Record the release (release) after they finalized | [`0x8ba62f08ca`](https://explorer-bradbury.genlayer.com/tx/0x8ba62f08cac926930b30e394bee6960d9746a44920157f0e886e0c8d3dcaeee3) | accepted |
| 11 | gl-test-4 (client) | Settle: pay the provider (settle) | [`0xee4ff37fef`](https://explorer-bradbury.genlayer.com/tx/0xee4ff37fef13690c0b17c70d02fff2c9404544129675270cb1c3506b97e0bd65) | accepted, paid after finality |

- The app showed "recorded, not final" under each write, with several waiting at once, and reported "Finalized, result confirmed" or "Finalized, funds delivered" only when the transaction had finalized and the state read back as expected.
- The early release (row 9) is the app's refusal path working: the app's own view said every link was checked, but the checks had not finalized, so the contract refused and the app said so. It succeeded once they had.
- The provider wallet's balance rose by exactly **0.002000 GEN** (`2000000000000000` wei) when the settlement finalized. That wallet sends nothing else, so the difference is the payout.
- Negative checks with no transaction: a wrong agreed digest ("verify would refuse it") and a pin the list does not live under both left Fund disabled with the reason shown.

### Final state of the contract

After every run above, every engagement is `settled` and the contract's own accounting reads `{"balance": 2, "in_flight": 2, "shortfall": 0, "total_received": "14000000000000000", "total_scheduled": "14000000000000000", "unscheduled": 0}`: `total_received` equals `total_scheduled`, nothing is short, nothing is owed, and the only balance is the 2 wei that two deliberately refused 1-wei calls left behind.

### What live testing found

The unit tests and mutation runs passed before any of this. Running it live found five things, all fixed:

1. **The preflight rejected every GitHub release.** Release downloads redirect to long signed URLs, and the route applied the contract's 300-character URL rule to each redirect hop. Redirect targets now only have to be plain https on a public host. Found by the first UI run.
2. **Buttons that were blocked said "Working…".** A blocked release or refund button now says what it is and why it is blocked.
3. **A script check raced with the other scenarios.** The cancel scenario compared an engagement count that other scenarios were changing at the same moment, and reported a refused creation as stored. It now checks that exact id, and the scenario was rerun alone.
4. **A read-back can lag a just-accepted write.** The first `verify` attempts looked like failures for five minutes because the state had not updated yet. The scripts and the app now poll the state before deciding.
5. **Settled deliveries still described future steps.** The progress list now describes a closed window and a completed payout in the past tense.

<!--LIVE_END-->

## Layout

- `contracts/lading.py` the escrow (about 16 KB, safely under the Bradbury deploy limit)
- `contracts/lineage.py` the verifier: fetching, hashing and validator consensus (about 12 KB)
- `tests/direct/test_lineage.py` and `tests/direct/test_lineage_consensus.py` the verifier's tests, including the validators' vote; `scripts/mutate-verifier.py`; `scripts/verify-deployed.mjs` checks both contracts against the chain
- `tests/direct/` direct-mode tests
- `scripts/deploy.mjs` deploys the escrow with a testnet wallet kept outside the repo
- `scripts/e2e.mjs` the live end-to-end run; `scripts/e2e-log-v3.json` is the audited contract's log, `scripts/e2e-log-main.json` and `scripts/e2e-log-cancel.json` are round 1's
- `demo/` the artifacts and checksum list the live runs use for the drift, stale, drift-then-stale and app-driven runs
- `frontend/` the app and landing page (Next.js, wallet-provider client, FINALIZED-aware writes)

## Running the app

```
cd frontend
cp .env.example .env     # set NEXT_PUBLIC_CONTRACT_ADDRESS (the escrow) and NEXT_PUBLIC_VERIFIER_ADDRESS
npm install && npm run dev
```

## License

MIT
