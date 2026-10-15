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
## Live evidence

(filled in from `scripts/e2e-log.json` after the run)
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
