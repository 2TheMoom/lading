# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from genlayer import *
from genlayer.py.public_abi import StorageType

MIN_WINDOW = 3600
MAX_WINDOW = 7 * 86400
MIN_STALE = 7200
MAX_STALE = 30 * 86400
MAX_URL = 300
MAX_NAME = 200
PAGE = 50
LABEL = "abcdefghijklmnopqrstuvwxyz0123456789-"
NAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+@=,-~"
INTERNAL = ("local", "internal", "lan", "localhost", "home", "corp", "intranet", "localdomain", "arpa")
HEX = "0123456789abcdef"

PROPOSED = "proposed"  # funded by the client, waiting for the provider to accept the exact terms
FUNDED = "funded"  # accepted, waiting for the release to be shipped
SUBMITTED = "submitted"  # the provider says it is ready, waiting for a finalized verdict
VERIFIED = "verified"  # the verifier's finalized state vouches for it; the watch window is running
DECIDED = "decided"  # an outcome is recorded, settle() pays it
SETTLED = "settled"  # paid, once


@gl.evm.contract_interface
class Payee:
    class View:
        pass

    class Write:
        pass


def _pay(to: Address, value: int) -> None:
    Payee(to).emit_transfer(value=value)


def _bad(c: bool, m: str) -> None:
    if c:
        raise gl.vm.UserError(m)


def _url(u) -> str:
    """Same rules as the verifier, so both contracts derive the same attestation id."""
    _bad(not isinstance(u, str) or not u.startswith("https://") or len(u) > MAX_URL, f"url must be https, at most {MAX_URL} characters")
    for ch in u:
        _bad(ch.isspace() or ch in "\"'<>\\`|", "url has a forbidden character")
    h = u[8:].split("/", 1)[0].split("?", 1)[0].split("#", 1)[0].lower()
    _bad("@" in h or ":" in h, "url may not have credentials or a port")
    p = h.split(".")
    _bad(len(p) < 2 or p[-1] in INTERNAL or not any(c.isalpha() for c in p[-1]), "url host must be a public domain name")
    for x in p:
        _bad(not 1 <= len(x) <= 63 or x[0] == "-" or x[-1] == "-" or any(c not in LABEL for c in x), "invalid url host")
    return u.split("#", 1)[0]


def _name(n) -> str:
    _bad(not isinstance(n, str) or not 1 <= len(n) <= MAX_NAME, f"filename must be 1 to {MAX_NAME} characters")
    _bad(any(c not in NAME_CHARS for c in n) or n[0] == ".", "filename may use letters, digits and . _ + @ = , - ~ only")
    return n


def _att_id(artifact: str, manifest: str, name: str, parent: str) -> str:
    return hashlib.sha256(f"{artifact}|{manifest}|{name}|{parent}".encode("utf-8")).hexdigest()


@allow_storage
@dataclass
class Engagement:
    client: Address
    provider: Address
    artifact_url: str
    manifest_url: str
    filename: str
    parent: str
    pin: str
    expected: str
    att_id: str
    amount: u256
    deadline: u256
    window: u256
    stale_after: u256
    status: str
    outcome: str
    reason: str
    submitted_at: u256
    verified_at: u256
    decided_at: u256
    digest: str
    links: u256


class Lading(gl.Contract):
    verifier: Address
    engagements: TreeMap[str, Engagement]
    engagement_ids: DynArray[str]
    payouts: TreeMap[str, u256]
    total_received: u256
    total_scheduled: u256

    def __init__(self, verifier_address: Address):
        # The verifier is fixed for the life of this contract: there is no setter.
        self.verifier = verifier_address if isinstance(verifier_address, Address) else Address(verifier_address)

    def _now(self) -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _get(self, i: str) -> Engagement:
        _bad(not isinstance(i, str) or i not in self.engagements, "Engagement not found")
        return self.engagements[i]

    def _terms(self, e: Engagement) -> str:
        t = [e.artifact_url, e.manifest_url, e.filename, e.parent, e.pin, e.expected, e.provider.as_hex.lower(), int(e.amount), int(e.deadline), int(e.window), int(e.stale_after)]
        return hashlib.sha256(json.dumps(t).encode("utf-8")).hexdigest()

    def _seen(self, e: Engagement, fresh_from: int) -> dict:
        """What the verifier's FINALIZED state says about this release.
        read=False means the verifier could not answer (never treated as drift); ok=True means every link is
        verified, vouched for under the pin, and was last checked at or after fresh_from (this contract's own clock, not the verifier's)."""
        none = {"read": False, "ok": False, "digest": "", "links": 0}
        try:
            v = gl.get_contract_at(self.verifier).view(state=StorageType.LATEST_FINAL)
            chain = v.trace(e.att_id)
            trusted = v.is_trusted_from(e.att_id, 0, e.pin)
        except Exception:
            return none
        if not isinstance(chain, list) or len(chain) == 0 or not isinstance(trusted, bool):
            return none
        leaf = chain[0]
        if not isinstance(leaf, dict) or leaf.get("id") != e.att_id or not isinstance(leaf.get("status"), str) or not isinstance(leaf.get("digest"), str):
            return none
        under_pin = all(isinstance(n, dict) and isinstance(n.get("manifest_url"), str) and n["manifest_url"].startswith(e.pin) for n in chain)
        fresh = all(type(n.get("checked_at")) is int and n["checked_at"] >= fresh_from for n in chain)
        ok = trusted and leaf["status"] == "verified" and len(leaf["digest"]) == 64 and under_pin and fresh
        return {"read": True, "ok": ok, "digest": leaf["digest"], "links": len(chain)}

    def _pay_out(self, i: str, e: Engagement, to_provider: int, to_client: int) -> None:
        _bad(to_provider + to_client != int(e.amount), "Settlement does not match funds held")
        e.status = SETTLED
        for who, addr, amt in (("provider", e.provider, to_provider), ("client", e.client, to_client)):
            if amt > 0:
                key = f"{i}:{who}"
                _bad(key in self.payouts, "Already paid")
                self.payouts[key] = amt
                self.total_scheduled += amt
                _pay(addr, amt)

    def _decide(self, e: Engagement, outcome: str, reason: str) -> None:
        e.status = DECIDED
        e.outcome = outcome
        e.reason = reason
        e.decided_at = self._now()

    @gl.public.write.payable
    def create_engagement(self, engagement_id: str, provider: str, artifact_url: str, manifest_url: str, filename: str, parent_id: str,
                          pin: str, expected_digest: str, deadline: int, window: int, stale_after: int) -> None:
        """Every rule is checked before any state changes. On Bradbury a refused payable call KEEPS its value, so callers must
        pre-check (the app does): the amount of a refused call is stranded in the contract."""
        _bad(not isinstance(engagement_id, str) or not 0 < len(engagement_id) <= 64, "engagement_id must be 1 to 64 characters")
        _bad(engagement_id in self.engagements, "Engagement already exists")
        _bad(gl.message.value <= 0, "Must escrow a positive amount")
        client = gl.message.sender_address
        prov = Address(provider)
        _bad(prov == client, "Provider cannot be the client")
        a, m, n = _url(artifact_url), _url(manifest_url), _name(filename)
        _bad(not isinstance(parent_id, str) or (parent_id != "" and (len(parent_id) != 64 or any(c not in HEX for c in parent_id))), "parent_id must be empty or 64 lowercase hex digits")
        p = _url(pin)
        _bad(p != pin or not p.endswith("/"), "pin must be an https url prefix ending in /")
        _bad(not m.startswith(p), "The checksum list must live under the pin")
        _bad(not isinstance(expected_digest, str) or (expected_digest != "" and (len(expected_digest) != 64 or any(c not in HEX for c in expected_digest))), "expected_digest must be empty or 64 lowercase hex digits")
        for x in (deadline, window, stale_after):
            _bad(not isinstance(x, int), "times must be whole numbers")
        _bad(deadline <= self._now(), "deadline must be in the future")
        _bad(not MIN_WINDOW <= window <= MAX_WINDOW, f"window must be {MIN_WINDOW} to {MAX_WINDOW} seconds")
        _bad(not MIN_STALE <= stale_after <= MAX_STALE, f"stale_after must be {MIN_STALE} to {MAX_STALE} seconds")
        self.engagements[engagement_id] = Engagement(
            client=client, provider=prov, artifact_url=a, manifest_url=m, filename=n, parent=parent_id, pin=p,
            expected=expected_digest, att_id=_att_id(a, m, n, parent_id), amount=gl.message.value, deadline=deadline, window=window, stale_after=stale_after,
            status=PROPOSED, outcome="", reason="", submitted_at=0, verified_at=0, decided_at=0, digest="", links=0,
        )
        self.engagement_ids.append(engagement_id)
        self.total_received += gl.message.value

    @gl.public.write
    def accept(self, engagement_id: str, terms_hash: str) -> None:
        e = self._get(engagement_id)
        _bad(gl.message.sender_address != e.provider, "Only the provider can accept")
        _bad(e.status != PROPOSED, f"Not awaiting acceptance (status: {e.status})")
        _bad(self._now() >= int(e.deadline), "Deadline has passed, the client can cancel")
        _bad(terms_hash != self._terms(e), "terms_hash does not match the terms")
        e.status = FUNDED

    @gl.public.write
    def submit(self, engagement_id: str) -> None:
        e = self._get(engagement_id)
        _bad(gl.message.sender_address != e.provider, "Only the provider can submit")
        _bad(e.status != FUNDED, f"Not awaiting submission (status: {e.status})")
        _bad(self._now() >= int(e.deadline), "Deadline has passed, the client can reclaim")
        e.status = SUBMITTED
        e.submitted_at = self._now()

    @gl.public.write
    def verify(self, engagement_id: str) -> None:
        """Permissionless. Needs the verifier's FINALIZED state to vouch for the whole chain under the pin."""
        e = self._get(engagement_id)
        _bad(e.status != SUBMITTED, f"Not awaiting verification (status: {e.status})")
        r = self._seen(e, 0)
        _bad(not r["read"], "The verifier could not be read, nothing recorded")
        _bad(not r["ok"], "The verifier does not vouch for this release in finalized state")
        _bad(e.expected != "" and r["digest"] != e.expected, "The verified digest is not the agreed one")
        e.status = VERIFIED
        e.verified_at = self._now()
        e.digest = r["digest"]
        e.links = r["links"]

    @gl.public.write
    def release(self, engagement_id: str) -> None:
        """Permissionless. After the watch window, and only if every link was checked again after it closed (finalized)."""
        e = self._get(engagement_id)
        _bad(e.status != VERIFIED, f"Not verified (status: {e.status})")
        now = self._now()
        end = int(e.verified_at) + int(e.window)
        _bad(now < end, "The watch window is still open")
        r = self._seen(e, end)
        _bad(not r["read"], "The verifier could not be read, nothing recorded")
        _bad(not r["ok"] or r["digest"] != e.digest, "Every link needs a finalized check made after the window closed")
        self._decide(e, "provider", "checked after the window")

    @gl.public.write
    def refund_drift(self, engagement_id: str) -> None:
        """Permissionless. The finalized verifier no longer vouches for what was verified: the client is owed the escrow back."""
        e = self._get(engagement_id)
        _bad(e.status != VERIFIED, f"Not verified (status: {e.status})")
        r = self._seen(e, 0)
        _bad(not r["read"], "The verifier could not be read, nothing recorded")
        _bad(r["ok"] and r["digest"] == e.digest, "The release still checks out")
        self._decide(e, "client", "drifted")

    @gl.public.write
    def settle(self, engagement_id: str) -> None:
        """Pays a recorded outcome. Kept apart from every decision so a payment never shares a transaction with a verifier read."""
        e = self._get(engagement_id)
        _bad(e.status != DECIDED, f"No outcome to settle (status: {e.status})")
        amount = int(e.amount)
        if e.outcome == "provider":
            self._pay_out(engagement_id, e, amount, 0)
        else:
            self._pay_out(engagement_id, e, 0, amount)

    @gl.public.write
    def reclaim_timeout(self, engagement_id: str) -> None:
        e = self._get(engagement_id)
        _bad(gl.message.sender_address != e.client, "Only the client can reclaim")
        _bad(e.status not in (PROPOSED, FUNDED), f"Not awaiting shipment (status: {e.status})")
        _bad(e.status == FUNDED and self._now() <= int(e.deadline), "Deadline has not passed yet")
        e.outcome = "client"
        e.reason = "timeout"
        e.decided_at = self._now()
        self._pay_out(engagement_id, e, 0, int(e.amount))

    @gl.public.write
    def reclaim_stale(self, engagement_id: str) -> None:
        """A stuck submission refunds the client (client only). A verified release that could never be confirmed splits evenly (anyone)."""
        e = self._get(engagement_id)
        now = self._now()
        sub = e.status == SUBMITTED and now >= int(e.deadline) + int(e.stale_after)
        ver = e.status == VERIFIED and now >= int(e.verified_at) + int(e.window) + int(e.stale_after)
        _bad(not sub and not ver, f"Not eligible for stale recovery yet (status: {e.status})")
        e.decided_at = now
        amount = int(e.amount)
        if ver:
            e.outcome = "split"
            e.reason = "stale"
            self._pay_out(engagement_id, e, amount // 2, amount - amount // 2)
        else:
            _bad(gl.message.sender_address != e.client, "Only the client can reclaim a stuck submission")
            e.outcome = "client"
            e.reason = "stale"
            self._pay_out(engagement_id, e, 0, amount)

    @gl.public.view
    def attestation_id(self, artifact_url: str, manifest_url: str, filename: str, parent_id: str) -> str:
        return _att_id(_url(artifact_url), _url(manifest_url), _name(filename), parent_id)

    @gl.public.view
    def get_verifier(self) -> str:
        return self.verifier.as_hex

    @gl.public.view
    def get_engagement(self, engagement_id: str) -> dict:
        e = self._get(engagement_id)
        end = int(e.verified_at) + int(e.window) if e.verified_at > 0 else 0
        stale = int(e.deadline) + int(e.stale_after) if e.status == SUBMITTED else end + int(e.stale_after) if e.status == VERIFIED else 0
        return {
            "client": e.client.as_hex, "provider": e.provider.as_hex, "artifact_url": e.artifact_url, "manifest_url": e.manifest_url,
            "filename": e.filename, "parent": e.parent, "pin": e.pin, "expected": e.expected, "attestation_id": e.att_id, "amount": e.amount,
            "deadline": e.deadline, "window": e.window, "stale_after": e.stale_after, "status": e.status, "outcome": e.outcome,
            "reason": e.reason, "submitted_at": e.submitted_at, "verified_at": e.verified_at, "decided_at": e.decided_at,
            "digest": e.digest, "links": e.links, "window_end": end, "stale_at": stale, "terms_hash": self._terms(e),
        }

    @gl.public.view
    def get_engagement_count(self) -> int:
        return len(self.engagement_ids)

    @gl.public.view
    def get_engagement_ids(self, offset: int, limit: int) -> list:
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            return []
        return [self.engagement_ids[k] for k in range(offset, min(offset + min(limit, PAGE), len(self.engagement_ids)))]

    @gl.public.view
    def get_accounting(self) -> dict:
        bal = int(self.balance)
        owed = int(self.total_received) - int(self.total_scheduled)
        return {
            "balance": bal, "total_received": int(self.total_received), "total_scheduled": int(self.total_scheduled),
            "unscheduled": owed, "in_flight": max(bal - owed, 0), "shortfall": max(owed - bal, 0),
        }
