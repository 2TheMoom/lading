# Lading

Escrow that pays when the build matches. A client funds GEN against a software release. GenLayer validators download the real file, hash it, and check it against the checksum list the publisher already ships. A match pays the developer, a mismatch or a later change refunds the client. No model decides money, and no marker line on a page someone wrote for the occasion: the evidence is the file itself.

The name is the bill of lading, the document that proves goods were delivered as described. The logo is the Plimsoll load line painted on ships to show they are safely loaded.

## How it works

Two contracts, deliberately separate:

- **Verifier** ([Lineage](https://github.com/2TheMoom/lineage), already deployed and public). It records, per release, the sha256 validators computed and whether the publisher's checksum list agrees, ties a build to its source, and can pin who vouched. It never touches money.
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

- **Escrow:** [`0xacc591981a7F4B059aE9E5C9a4Cd79aC7fe56A45`](https://explorer-bradbury.genlayer.com/address/0xacc591981a7F4B059aE9E5C9a4Cd79aC7fe56A45)
- **Verifier (Lineage v2):** [`0x6508856DE231e094BfD121Eb5A30D5C3c03972A9`](https://explorer-bradbury.genlayer.com/address/0x6508856DE231e094BfD121Eb5A30D5C3c03972A9)
- **App and landing page:** https://lading-frontend.vercel.app (try [a settled delivery](https://lading-frontend.vercel.app/app/d/lad-ui-1))

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
| Funds locked forever | Deadline, stale recovery for both stuck states, a bounded window and stale range | timeout and stale tests, live runs |

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
| Direct | `python -m pytest tests/direct/ -v` | 113 in-memory tests with a fake verifier that models the real one and records every call |
| Frontend logic | `cd frontend && npm test` | action rules, limits mirrored from the contract, decoding, finality rules |
| Live | `LADING=0x... node scripts/e2e.mjs` | the Bradbury run described below, separate client, provider and third-party wallets |

Every rule was mutation-checked: 105 deliberate breakages of the contract, 102 caught by a test. The 3 survivors are the payout bookkeeping (the amounts-sum check, the duplicate-payout guard and the payout record) which sit behind the status machine: no input can reach them, so they stay as a second line of defense.

<!--LIVE_START-->
## Live evidence (Bradbury)

Escrow `0xacc591981a7F4B059aE9E5C9a4Cd79aC7fe56A45`, verifier `0x6508856DE231e094BfD121Eb5A30D5C3c03972A9` (Lineage v2). `scripts/e2e.mjs` ran every scenario below against the deployed contracts with a **separate client wallet, provider wallet and third-party wallet**, and every write was confirmed by reading state back. Run `mva4y6rp` (`scripts/e2e-log-main.json`) did the happy, agreed, drift and stale scenarios; the cancel scenario was repeated alone after fixing a race in the script's own check (`scripts/e2e-log-cancel.json`, run `mvaew35p`). Money paths wait out real windows (one hour minimum) and Bradbury finality (about 30 minutes).

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

### Verified, but nobody confirms it again

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
- `tests/direct/` direct-mode tests
- `scripts/e2e.mjs` the live end-to-end run, `scripts/e2e-log.json` its machine-readable log
- `demo/` the artifacts and checksum list the live run uses for the drift and stale scenarios
- `frontend/` the app and landing page (Next.js, wallet-provider client, FINALIZED-aware writes)

## Running the app

```
cd frontend
cp .env.example .env     # set NEXT_PUBLIC_CONTRACT_ADDRESS (the escrow) and NEXT_PUBLIC_VERIFIER_ADDRESS
npm install && npm run dev
```

## License

MIT
