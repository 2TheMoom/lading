"""Direct-mode tests for Lading (escrow released by a verifier's finalized verdict on a real file).

Direct mode cannot run two contracts against each other, so a FakeVerifier answers the escrow's cross-contract calls.
It models the real verifier's rules (parent walk, every link verified, the freshness age, the publisher pin) and records
every call, so these tests pin down exactly what the escrow asks, of which state, and what it does with each answer.
The real cross-contract path is covered by the live Bradbury run (see README).
"""

import hashlib
from datetime import datetime, timezone

import pytest

CONTRACT = "contracts/lading.py"
VERIFIER = "0x" + "ab" * 20
LATEST_FINAL = 1
T0 = "2026-01-01T00:00:00Z"
T0_TS = int(datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc).timestamp())
DEADLINE = T0_TS + 86400
WINDOW = 3600
STALE = 7200
WINDOW_END = "2026-01-01T01:00:00Z"
AFTER = "2026-01-01T01:30:00Z"  # after the window, before the stale point (verified + window + stale = 03:00)
AFTER_STALE = "2026-01-01T03:00:01Z"
LATE = "2026-01-03T00:00:00Z"  # past deadline + stale

PIN = "https://dl.example.com/releases/"
ART = PIN + "app-linux-amd64"
MAN = PIN + "SHA256SUMS"
NAME = "app-linux-amd64"
DIGEST = hashlib.sha256(b"the real build").hexdigest()
SRC_ART = PIN + "app-1.0.tar.gz"
SRC_NAME = "app-1.0.tar.gz"
SRC_DIGEST = hashlib.sha256(b"the real source").hexdigest()


def _ts(iso: str) -> int:
    return int(datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


class FakeVerifier:
    """Stands in for the deployed verifier and records every call made to it."""

    def __init__(self):
        self.atts = {}
        self.calls = []
        self.now = T0_TS
        self.fail = False  # the verifier errors
        self.junk = None  # a wrong-shaped answer for every call
        self.trace_override = None  # a function(att_id) -> any, replaces the trace answer
        self.trusted_override = None  # replaces the is_trusted_from answer

    def put(self, att_id, **kw):
        base = dict(parent="", status="verified", digest=DIGEST, checked_at=T0_TS, artifact_url=ART, manifest_url=MAN, filename=NAME)
        base.update(kw)
        self.atts[att_id] = base

    def _trace(self, att_id):
        out, cur = [], att_id
        while isinstance(cur, str) and cur in self.atts and len(out) <= 8:
            a = self.atts[cur]
            out.append({"id": cur, "filename": a["filename"], "status": a["status"], "digest": a["digest"], "checked_at": a["checked_at"],
                        "artifact_url": a["artifact_url"], "manifest_url": a["manifest_url"]})
            cur = a["parent"]
        return out

    def _trusted(self, att_id, age, prefix):
        if isinstance(age, bool) or not isinstance(age, int) or age < 0:
            return False
        chain = self._trace(att_id)
        if not chain or self.atts[chain[-1]["id"]]["parent"] != "":
            return False
        for n in chain:
            if n["status"] != "verified" or (age > 0 and self.now > n["checked_at"] + age) or not n["manifest_url"].startswith(prefix):
                return False
        return True

    def install(self, vm):
        def hook(_vm, request):
            from genlayer.py import calldata  # the SDK is only importable once a contract is deployed

            if "CallContract" not in request:
                return None
            req = request["CallContract"]
            addr = req["address"]
            addr_hex = "0x" + (addr.as_bytes.hex() if hasattr(addr, "as_bytes") else bytes(addr).hex())
            cd = req["calldata"]
            self.calls.append({"address": addr_hex, "method": cd["method"], "args": list(cd["args"]), "state": req.get("state")})
            if self.fail:
                return bytes([1]) + b"simulated verifier error"
            if addr_hex != VERIFIER:
                return bytes([1]) + b"unexpected address"
            if self.junk is not None:
                return bytes([0]) + calldata.encode(self.junk)
            if cd["method"] == "trace":
                out = self.trace_override(*cd["args"]) if self.trace_override else self._trace(*cd["args"])
                return bytes([0]) + calldata.encode(out)
            if cd["method"] == "is_trusted_from":
                out = self.trusted_override if self.trusted_override is not None else self._trusted(*cd["args"])
                return bytes([0]) + calldata.encode(out)
            return bytes([1]) + b"unexpected method"

        vm._gl_call_hook = hook


def _hex(a):
    return ("0x" + a.hex()).lower()


def _capture_sends(vm):
    sends = []

    def prev_hook(v, request):
        return None

    inner = vm._gl_call_hook if hasattr(vm, "_gl_call_hook") else None

    def hook(v, request):
        if isinstance(request, dict) and "EthSend" in request:
            s = request["EthSend"]
            sends.append((s["address"].as_hex.lower(), int(s["value"])))
            return None
        return inner(v, request) if inner else None

    vm._gl_call_hook = hook
    return sends


def _setup(vm, deploy):
    fake = FakeVerifier()
    fake.install(vm)
    return deploy(CONTRACT, VERIFIER), fake


def _create(vm, c, client, provider, eid="e1", value=1000, **kw):
    a = dict(artifact=ART, manifest=MAN, name=NAME, parent="", pin=PIN, expected="", deadline=DEADLINE, window=WINDOW, stale=STALE)
    a.update(kw)
    vm.sender = client
    vm.value = value
    try:
        c.create_engagement(eid, "0x" + provider.hex(), a["artifact"], a["manifest"], a["name"], a["parent"], a["pin"], a["expected"], a["deadline"], a["window"], a["stale"])
    finally:
        vm.value = 0


def _accept(c, eid="e1"):
    c.accept(eid, c.get_engagement(eid)["terms_hash"])


def _to_funded(vm, c, alice, bob, eid="e1", value=1000, **kw):
    _create(vm, c, alice, bob, eid, value, **kw)
    vm.sender = bob
    _accept(c, eid)


def _to_submitted(vm, c, alice, bob, eid="e1", value=1000, **kw):
    _to_funded(vm, c, alice, bob, eid, value, **kw)
    vm.sender = bob
    c.submit(eid)


def _vouch(c, fake, eid="e1", **kw):
    fake.put(c.get_engagement(eid)["attestation_id"], **kw)


def _to_verified(vm, c, fake, alice, bob, eid="e1", value=1000, **kw):
    _to_submitted(vm, c, alice, bob, eid, value, **kw)
    _vouch(c, fake, eid)
    c.verify(eid)


# ---------------------------------------------------------------------------
# create_engagement
# ---------------------------------------------------------------------------


def test_create_stores_the_terms_and_holds_the_escrow(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob)
    e = c.get_engagement("e1")
    assert (e["status"], e["amount"], e["window"], e["stale_after"], e["deadline"]) == ("proposed", 1000, WINDOW, STALE, DEADLINE)
    assert (e["artifact_url"], e["manifest_url"], e["filename"], e["parent"], e["pin"]) == (ART, MAN, NAME, "", PIN)
    assert e["client"].lower() == _hex(direct_alice) and e["provider"].lower() == _hex(direct_bob)
    assert len(e["attestation_id"]) == 64 and len(e["terms_hash"]) == 64
    assert c.get_engagement_count() == 1 and c.get_engagement_ids(0, 10) == ["e1"]
    assert c.get_accounting()["total_received"] == 1000 and c.get_verifier().lower() == VERIFIER


def test_the_attestation_id_matches_the_verifiers_formula(direct_vm, direct_deploy):
    c, fake = _setup(direct_vm, direct_deploy)
    assert c.attestation_id(ART, MAN, NAME, "") == hashlib.sha256(f"{ART}|{MAN}|{NAME}|".encode()).hexdigest()
    parent = "ab" * 32
    assert c.attestation_id(ART, MAN, NAME, parent) == hashlib.sha256(f"{ART}|{MAN}|{NAME}|{parent}".encode()).hexdigest()
    assert c.attestation_id(ART + "#frag", MAN, NAME, "") == c.attestation_id(ART, MAN, NAME, "")


BAD_CREATES = {
    "http url": dict(artifact="http://dl.example.com/releases/a"),
    "ip host": dict(artifact="https://127.0.0.1/a"),
    "port": dict(artifact="https://dl.example.com:8443/releases/a"),
    "credentials": dict(manifest="https://u:p@dl.example.com/releases/S"),
    "pipe in url": dict(artifact=PIN + "a|b"),
    "internal host": dict(artifact="https://printer.local/a"),
    "bad filename": dict(name="has space"),
    "hidden filename": dict(name=".hidden"),
    "empty filename": dict(name=""),
    "parent not hex": dict(parent="z" * 64),
    "parent wrong length": dict(parent="ab" * 31),
    "parent uppercase": dict(parent="AB" * 32),
    "pin not a prefix": dict(pin="https://dl.example.com/releases"),
    "pin with query": dict(pin="https://dl.example.com/releases/?x=1/"),
    "pin with fragment": dict(pin="https://dl.example.com/releases/#x/"),
    "pin http": dict(pin="http://dl.example.com/releases/"),
    "list outside the pin": dict(pin="https://other.example.com/releases/"),
    "past deadline": dict(deadline=T0_TS - 1),
    "deadline now": dict(deadline=T0_TS),
    "deadline beyond two years": dict(deadline=T0_TS + 730 * 86400 + 1),
    "deadline past the u256 range": dict(deadline=2**256),
    "window too short": dict(window=WINDOW - 1),
    "window too long": dict(window=7 * 86400 + 1),
    "stale too short": dict(stale=7199),
    "stale too long": dict(stale=30 * 86400 + 1),
    "float time": dict(window=3600.5),
    "bool time": dict(deadline=True),
}


@pytest.mark.parametrize("why", sorted(BAD_CREATES))
def test_every_invalid_creation_is_refused_and_stores_nothing(direct_vm, direct_deploy, direct_alice, direct_bob, why):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    with direct_vm.expect_revert():
        _create(direct_vm, c, direct_alice, direct_bob, **BAD_CREATES[why])
    assert c.get_engagement_count() == 0


def test_the_deadline_may_be_exactly_two_years_out_and_no_further(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob, deadline=T0_TS + 730 * 86400)
    assert c.get_engagement("e1")["deadline"] == T0_TS + 730 * 86400
    with direct_vm.expect_revert("within two years"):
        _create(direct_vm, c, direct_alice, direct_bob, eid="e2", deadline=T0_TS + 730 * 86400 + 1)
    assert c.get_engagement_count() == 1


def test_creation_needs_money_a_different_provider_and_a_new_id(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    with direct_vm.expect_revert("positive amount"):
        _create(direct_vm, c, direct_alice, direct_bob, value=0)
    with direct_vm.expect_revert("Provider cannot be the client"):
        _create(direct_vm, c, direct_alice, direct_alice)
    for bad in ("", "x" * 65):
        with direct_vm.expect_revert("engagement_id"):
            _create(direct_vm, c, direct_alice, direct_bob, eid=bad)
    _create(direct_vm, c, direct_alice, direct_bob)
    with direct_vm.expect_revert("already exists"):
        _create(direct_vm, c, direct_alice, direct_bob)
    _create(direct_vm, c, direct_alice, direct_bob, eid="x" * 64)
    assert c.get_engagement_count() == 2


# ---------------------------------------------------------------------------
# accept and submit
# ---------------------------------------------------------------------------


def test_the_provider_must_pass_the_exact_terms_hash(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob)
    good = c.get_engagement("e1")["terms_hash"]
    for who in (direct_alice, direct_charlie):
        direct_vm.sender = who
        with direct_vm.expect_revert("Only the provider"):
            c.accept("e1", good)
    direct_vm.sender = direct_bob
    for bad in ("", "x", good.upper(), good + "0", "0" * 64):
        with direct_vm.expect_revert("terms_hash does not match"):
            c.accept("e1", bad)
    assert c.get_engagement("e1")["status"] == "proposed"
    c.accept("e1", good)
    assert c.get_engagement("e1")["status"] == "funded"
    with direct_vm.expect_revert("Not awaiting acceptance"):
        c.accept("e1", good)


def test_the_terms_hash_covers_every_term(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    base = _create(direct_vm, c, direct_alice, direct_bob, eid="t0")
    variants = [
        dict(artifact=PIN + "other-artifact"),
        dict(manifest=PIN + "OTHERSUMS"),
        dict(name="other-name"),
        dict(parent="cd" * 32),
        dict(pin="https://dl.example.com/"),
        dict(deadline=DEADLINE + 1),
        dict(window=WINDOW + 1),
        dict(stale=STALE + 1),
        dict(expected=DIGEST),
        dict(value=1001),
    ]
    hashes = {c.get_engagement("t0")["terms_hash"]}
    for i, kw in enumerate(variants):
        _create(direct_vm, c, direct_alice, direct_bob, eid=f"t{i + 1}", **kw)
        hashes.add(c.get_engagement(f"t{i + 1}")["terms_hash"])
    _create(direct_vm, c, direct_alice, direct_charlie, eid="tp")  # a different provider
    hashes.add(c.get_engagement("tp")["terms_hash"])
    assert len(hashes) == len(variants) + 2  # every term, and the provider, changes the hash


def test_accept_and_submit_stop_at_the_deadline(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob)
    direct_vm.warp("2026-01-02T00:00:01Z")
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Deadline has passed"):
        _accept(c)
    direct_vm.warp(T0)
    _accept(c)
    direct_vm.warp("2026-01-02T00:00:01Z")
    with direct_vm.expect_revert("Deadline has passed"):
        c.submit("e1")


def test_submit_is_the_providers_and_only_after_accepting(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Not awaiting submission"):
        c.submit("e1")
    _accept(c)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only the provider"):
        c.submit("e1")
    direct_vm.sender = direct_bob
    c.submit("e1")
    e = c.get_engagement("e1")
    assert e["status"] == "submitted" and e["submitted_at"] == T0_TS
    with direct_vm.expect_revert("Not awaiting submission"):
        c.submit("e1")


# ---------------------------------------------------------------------------
# verify: what the escrow asks the verifier, and what it accepts
# ---------------------------------------------------------------------------


def test_verify_reads_the_verifiers_finalized_state_for_this_exact_attestation(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    att = c.get_engagement("e1")["attestation_id"]
    _vouch(c, fake)
    c.verify("e1")
    assert [(x["method"], x["args"], x["state"], x["address"]) for x in fake.calls] == [
        ("trace", [att], LATEST_FINAL, VERIFIER),
        ("is_trusted_from", [att, 0, PIN], LATEST_FINAL, VERIFIER),
    ]
    e = c.get_engagement("e1")
    assert (e["status"], e["verified_at"], e["digest"], e["links"], e["window_end"]) == ("verified", T0_TS, DIGEST, 1, T0_TS + WINDOW)


def test_verify_is_permissionless(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    _vouch(c, fake)
    direct_vm.sender = direct_charlie
    c.verify("e1")
    assert c.get_engagement("e1")["status"] == "verified"


def test_verify_only_follows_a_submission(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_funded(direct_vm, c, direct_alice, direct_bob)
    _vouch(c, fake)
    with direct_vm.expect_revert("Not awaiting verification"):
        c.verify("e1")
    assert fake.calls == []  # nothing was even asked
    direct_vm.sender = direct_bob
    c.submit("e1")
    c.verify("e1")
    with direct_vm.expect_revert("Not awaiting verification"):
        c.verify("e1")


@pytest.mark.parametrize("status", ["pending", "mismatch", "unlisted", "unbound", "drifted"])
def test_a_verdict_other_than_verified_does_not_verify(direct_vm, direct_deploy, direct_alice, direct_bob, status):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    _vouch(c, fake, status=status, digest="" if status != "drifted" else DIGEST)
    with direct_vm.expect_revert("does not vouch"):
        c.verify("e1")
    assert c.get_engagement("e1")["status"] == "submitted"


def test_an_unknown_attestation_or_an_unreachable_verifier_verifies_nothing(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    with direct_vm.expect_revert("could not be read"):
        c.verify("e1")  # the verifier has never heard of it
    _vouch(c, fake)
    fake.fail = True
    with direct_vm.expect_revert("could not be read"):
        c.verify("e1")
    fake.fail = False
    c.verify("e1")


JUNK_TRACES = {
    "none": lambda att: None,
    "string": lambda att: "yes",
    "number": lambda att: 7,
    "dict": lambda att: {"a": 1},
    "empty list": lambda att: [],
    "list of numbers": lambda att: [1, 2],
    "leaf without status": lambda att: [{"id": att}],
    "leaf status not text": lambda att: [{"id": att, "status": 3, "digest": "x"}],
    "leaf digest not text": lambda att: [{"id": att, "status": "verified", "digest": 5}],
    "leaf without id": lambda att: [{"status": "verified", "digest": DIGEST}],
    "someone else's leaf": lambda att: [{"id": "f" * 64, "status": "verified", "digest": DIGEST, "checked_at": T0_TS, "manifest_url": MAN}],
}


@pytest.mark.parametrize("why", sorted(JUNK_TRACES))
def test_a_wrong_shaped_trace_is_never_trusted(direct_vm, direct_deploy, direct_alice, direct_bob, why):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    fake.trace_override = JUNK_TRACES[why]
    with direct_vm.expect_revert("could not be read"):
        c.verify("e1")
    assert c.get_engagement("e1")["status"] == "submitted"


@pytest.mark.parametrize("answer", ["yes", 1, 0, [True], {"a": 1}])
def test_a_trusted_answer_that_is_not_a_boolean_is_never_trusted(direct_vm, direct_deploy, direct_alice, direct_bob, answer):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    _vouch(c, fake)
    fake.trusted_override = answer
    with direct_vm.expect_revert("could not be read"):
        c.verify("e1")


def _record(att, **kw):
    r = {"id": att, "filename": NAME, "status": "verified", "digest": DIGEST, "checked_at": T0_TS, "artifact_url": ART, "manifest_url": MAN}
    r.update(kw)
    return r


def test_the_escrow_does_not_take_the_verifiers_trusted_flag_on_faith(direct_vm, direct_deploy, direct_alice, direct_bob):
    """A buggy or hostile verifier that says trusted=True must still show a verified leaf, a real digest and
    every link under the pin before the escrow believes it."""
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    att = c.get_engagement("e1")["attestation_id"]
    fake.trusted_override = True
    cases = {
        "leaf pending": [_record(att, status="pending", digest="")],
        "leaf drifted": [_record(att, status="drifted")],
        "no digest": [_record(att, digest="")],
        "short digest": [_record(att, digest="ab" * 31)],
        "long digest": [_record(att, digest="ab" * 33)],
        "list outside the pin": [_record(att, manifest_url="https://evil.example.net/SUMS")],
        "a link outside the pin": [_record(att), _record("e" * 64, manifest_url="https://evil.example.net/SUMS")],
        "a link without a list": [_record(att), {"id": "e" * 64, "status": "verified"}],
        "lookalike host": [_record(att, manifest_url="https://dl.example.com.evil.net/releases/SUMS")],
    }
    for why, chain in cases.items():
        fake.trace_override = lambda a, chain=chain: chain
        with direct_vm.expect_revert("does not vouch"):
            c.verify("e1")
        assert c.get_engagement("e1")["status"] == "submitted", why
    fake.trace_override = lambda a: [_record(att)]
    c.verify("e1")
    assert c.get_engagement("e1")["status"] == "verified"


@pytest.mark.parametrize("bad", ["123", True, None, [1]])
def test_a_link_without_a_real_check_time_blocks_release(direct_vm, direct_deploy, direct_alice, direct_bob, bad):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    att = c.get_engagement("e1")["attestation_id"]
    direct_vm.warp(AFTER)
    fake.trusted_override = True
    fake.trace_override = lambda a: [_record(att, checked_at=bad)]
    with direct_vm.expect_revert("made after the window closed"):
        c.release("e1")
    fake.trace_override = lambda a: [_record(att, checked_at=_ts(AFTER))]
    c.release("e1")


def test_every_link_must_be_vouched_for_under_the_pin(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    src = hashlib.sha256(f"{SRC_ART}|{MAN}|{SRC_NAME}|".encode()).hexdigest()
    _to_submitted(direct_vm, c, direct_alice, direct_bob, parent=src)
    att = c.get_engagement("e1")["attestation_id"]
    fake.put(att, parent=src)
    fake.put(src, artifact_url=SRC_ART, filename=SRC_NAME, digest=SRC_DIGEST, manifest_url="https://evil.example.net/SUMS")
    with direct_vm.expect_revert("does not vouch"):
        c.verify("e1")  # the source is vouched for on someone else's site
    fake.put(src, artifact_url=SRC_ART, filename=SRC_NAME, digest=SRC_DIGEST)
    c.verify("e1")
    assert c.get_engagement("e1")["links"] == 2


def test_a_drifted_source_blocks_verification(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    src = hashlib.sha256(f"{SRC_ART}|{MAN}|{SRC_NAME}|".encode()).hexdigest()
    _to_submitted(direct_vm, c, direct_alice, direct_bob, parent=src)
    fake.put(c.get_engagement("e1")["attestation_id"], parent=src)
    fake.put(src, artifact_url=SRC_ART, filename=SRC_NAME, digest=SRC_DIGEST, status="drifted")
    with direct_vm.expect_revert("does not vouch"):
        c.verify("e1")


def test_the_verdict_must_be_about_this_attestation(direct_vm, direct_deploy, direct_alice, direct_bob):
    """A verifier answering with some other attestation's record must not pass for this one."""
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    real = c.get_engagement("e1")["attestation_id"]
    fake.put("f" * 64)
    fake._trace = lambda att_id: [{"id": "f" * 64, "filename": NAME, "status": "verified", "digest": DIGEST, "checked_at": T0_TS, "artifact_url": ART, "manifest_url": MAN}]
    fake._trusted = lambda *a: True
    with direct_vm.expect_revert():
        c.verify("e1")
    assert real != "f" * 64 and c.get_engagement("e1")["status"] == "submitted"


# ---------------------------------------------------------------------------
# release: only a fresh finalized check made after the watch window closes
# ---------------------------------------------------------------------------


def test_release_waits_out_the_watch_window(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp("2026-01-01T00:59:59Z")
    fake.calls.clear()
    with direct_vm.expect_revert("watch window is still open"):
        c.release("e1")
    assert fake.calls == []


def test_release_needs_every_link_checked_again_after_the_window_closed(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp(AFTER)
    fake.now = _ts(AFTER)
    with direct_vm.expect_revert("made after the window closed"):
        c.release("e1")  # the only check on record is from before the window closed
    _vouch(c, fake, checked_at=_ts(WINDOW_END) - 1)
    with direct_vm.expect_revert("made after the window closed"):
        c.release("e1")  # one second too early
    _vouch(c, fake, checked_at=_ts(WINDOW_END))
    fake.calls.clear()
    c.release("e1")
    assert [(x["method"], x["args"][1:], x["state"]) for x in fake.calls] == [
        ("trace", [], LATEST_FINAL),
        ("is_trusted_from", [0, PIN], LATEST_FINAL),
    ]
    e = c.get_engagement("e1")
    assert (e["status"], e["outcome"], e["reason"], e["decided_at"]) == ("decided", "provider", "checked after the window", _ts(AFTER))


def test_release_never_relies_on_the_verifiers_clock(direct_vm, direct_deploy, direct_alice, direct_bob):
    """Freshness is judged here, from each link's checked_at against this contract's own stored window end. The
    verifier is always asked with age 0, so what its clock says inside a finalized-state read cannot matter."""
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp(WINDOW_END)
    fake.now = _ts(WINDOW_END) + 10_000_000  # a verifier clock far in the future must change nothing
    _vouch(c, fake, checked_at=_ts(WINDOW_END))
    fake.calls.clear()
    c.release("e1")
    assert [x["args"][1] for x in fake.calls if x["method"] == "is_trusted_from"] == [0]
    assert c.get_engagement("e1")["outcome"] == "provider"


def test_a_stale_chain_member_blocks_release(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    src = hashlib.sha256(f"{SRC_ART}|{MAN}|{SRC_NAME}|".encode()).hexdigest()
    _to_submitted(direct_vm, c, direct_alice, direct_bob, parent=src)
    att = c.get_engagement("e1")["attestation_id"]
    fake.put(att, parent=src)
    fake.put(src, artifact_url=SRC_ART, filename=SRC_NAME, digest=SRC_DIGEST)
    c.verify("e1")
    direct_vm.warp(AFTER)
    fake.now = _ts(AFTER)
    fake.put(att, parent=src, checked_at=_ts(AFTER) - 60)  # the build was re-checked, its source was not
    with direct_vm.expect_revert("made after the window closed"):
        c.release("e1")
    fake.put(src, artifact_url=SRC_ART, filename=SRC_NAME, digest=SRC_DIGEST, checked_at=_ts(AFTER) - 60)
    c.release("e1")
    assert c.get_engagement("e1")["outcome"] == "provider"


def test_release_is_refused_if_the_release_drifted_or_the_verifier_is_down(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp(AFTER)
    fake.now = _ts(AFTER)
    _vouch(c, fake, checked_at=_ts(AFTER), status="drifted")
    with direct_vm.expect_revert("made after the window closed"):
        c.release("e1")
    _vouch(c, fake, checked_at=_ts(AFTER))
    fake.fail = True
    with direct_vm.expect_revert("could not be read"):
        c.release("e1")
    assert c.get_engagement("e1")["status"] == "verified"
    fake.fail = False
    c.release("e1")


def test_release_is_refused_if_the_digest_is_not_the_one_that_was_verified(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp(AFTER)
    fake.now = _ts(AFTER)
    _vouch(c, fake, checked_at=_ts(AFTER), digest=hashlib.sha256(b"swapped").hexdigest())
    with direct_vm.expect_revert("made after the window closed"):
        c.release("e1")


def test_release_is_permissionless_and_only_after_verification(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Not verified"):
        c.release("e1")
    _vouch(c, fake)
    c.verify("e1")
    direct_vm.warp(AFTER)
    fake.now = _ts(AFTER)
    _vouch(c, fake, checked_at=_ts(AFTER))
    c.release("e1")
    with direct_vm.expect_revert("Not verified"):
        c.release("e1")


# ---------------------------------------------------------------------------
# refund_drift
# ---------------------------------------------------------------------------


def test_a_release_that_still_checks_out_cannot_be_refunded(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("still checks out"):
        c.refund_drift("e1")
    assert c.get_engagement("e1")["status"] == "verified"


@pytest.mark.parametrize("change", [dict(status="drifted"), dict(status="mismatch", digest=""), dict(digest=hashlib.sha256(b"swapped").hexdigest())])
def test_drift_of_the_build_refunds_the_client(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, change):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    _vouch(c, fake, **change)
    direct_vm.sender = direct_charlie
    c.refund_drift("e1")
    e = c.get_engagement("e1")
    assert (e["status"], e["outcome"], e["reason"]) == ("decided", "client", "drifted")


def test_drift_of_the_source_refunds_the_client_even_if_the_build_is_untouched(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    src = hashlib.sha256(f"{SRC_ART}|{MAN}|{SRC_NAME}|".encode()).hexdigest()
    _to_submitted(direct_vm, c, direct_alice, direct_bob, parent=src)
    fake.put(c.get_engagement("e1")["attestation_id"], parent=src)
    fake.put(src, artifact_url=SRC_ART, filename=SRC_NAME, digest=SRC_DIGEST)
    c.verify("e1")
    fake.put(src, artifact_url=SRC_ART, filename=SRC_NAME, digest=SRC_DIGEST, status="drifted")
    c.refund_drift("e1")
    assert c.get_engagement("e1")["outcome"] == "client"


def test_an_unreadable_verifier_is_never_taken_for_drift(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    for how in ("fail", "junk", "gone"):
        fake.fail = how == "fail"
        fake.junk = [] if how == "junk" else None
        if how == "gone":
            fake.atts.clear()
        with direct_vm.expect_revert("could not be read"):
            c.refund_drift("e1")
        assert c.get_engagement("e1")["status"] == "verified"


def test_refund_drift_needs_a_verified_release(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    with direct_vm.expect_revert("Not verified"):
        c.refund_drift("e1")


# ---------------------------------------------------------------------------
# settle: exactly once, exactly the funds held
# ---------------------------------------------------------------------------


def _decided_provider(vm, c, fake, alice, bob, eid="e1", value=1000):
    _to_verified(vm, c, fake, alice, bob, eid, value)
    vm.warp(AFTER)
    fake.now = _ts(AFTER)
    _vouch(c, fake, eid, checked_at=_ts(AFTER))
    c.release(eid)


def test_settle_pays_the_provider_once(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _decided_provider(direct_vm, c, fake, direct_alice, direct_bob)
    assert sends == []  # a decision moves no money
    direct_vm.sender = direct_charlie
    c.settle("e1")
    assert sends == [(_hex(direct_bob), 1000)]
    assert c.get_engagement("e1")["status"] == "settled"
    for call in (lambda: c.settle("e1"), lambda: c.release("e1"), lambda: c.refund_drift("e1"), lambda: c.reclaim_timeout("e1"), lambda: c.reclaim_stale("e1"), lambda: c.verify("e1")):
        with direct_vm.expect_revert():
            call()
    assert sends == [(_hex(direct_bob), 1000)]
    a = c.get_accounting()
    assert (a["total_scheduled"], a["unscheduled"]) == (1000, 0)


def test_settle_refunds_the_client_after_drift(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    _vouch(c, fake, status="drifted")
    c.refund_drift("e1")
    assert sends == []
    c.settle("e1")
    assert sends == [(_hex(direct_alice), 1000)]


def test_settle_needs_a_recorded_outcome(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    with direct_vm.expect_revert("No outcome to settle"):
        c.settle("e1")
    assert sends == []


def test_no_decision_shares_a_transaction_with_a_payment(direct_vm, direct_deploy, direct_alice, direct_bob):
    """The decisions read the verifier; only settle and the plain reclaims move money."""
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    _vouch(c, fake)
    c.verify("e1")
    _vouch(c, fake, status="drifted")
    c.refund_drift("e1")
    assert sends == []


# ---------------------------------------------------------------------------
# reclaim paths
# ---------------------------------------------------------------------------


def test_the_client_can_cancel_an_unaccepted_proposal(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob)
    for who in (direct_bob, direct_charlie):
        direct_vm.sender = who
        with direct_vm.expect_revert("Only the client"):
            c.reclaim_timeout("e1")
    direct_vm.sender = direct_alice
    c.reclaim_timeout("e1")
    assert sends == [(_hex(direct_alice), 1000)]
    e = c.get_engagement("e1")
    assert (e["status"], e["outcome"], e["reason"]) == ("settled", "client", "timeout")
    with direct_vm.expect_revert():
        c.reclaim_timeout("e1")


def test_an_accepted_engagement_can_only_be_reclaimed_after_its_deadline(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_funded(direct_vm, c, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Deadline has not passed"):
        c.reclaim_timeout("e1")
    direct_vm.warp("2026-01-02T00:00:01Z")
    c.reclaim_timeout("e1")
    assert sends == [(_hex(direct_alice), 1000)]


def test_reclaim_timeout_does_not_reach_submitted_or_verified(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    direct_vm.warp(LATE)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Not awaiting shipment"):
        c.reclaim_timeout("e1")


def test_a_stuck_submission_refunds_the_client_only_after_the_stale_point(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    assert c.get_engagement("e1")["stale_at"] == DEADLINE + STALE
    direct_vm.warp("2026-01-02T01:59:59Z")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Not eligible"):
        c.reclaim_stale("e1")
    direct_vm.warp("2026-01-02T02:00:00Z")
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Only the client"):
        c.reclaim_stale("e1")
    direct_vm.sender = direct_alice
    c.reclaim_stale("e1")
    assert sends == [(_hex(direct_alice), 1000)]
    assert c.get_engagement("e1")["reason"] == "stale"


def test_a_verified_release_nobody_could_confirm_splits_evenly_including_odd_amounts(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob, value=1001)
    assert c.get_engagement("e1")["stale_at"] == T0_TS + WINDOW + STALE
    direct_vm.warp("2026-01-01T02:59:59Z")
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("Not eligible"):
        c.reclaim_stale("e1")
    direct_vm.warp(AFTER_STALE)
    fake.now = _ts(AFTER_STALE)
    c.reclaim_stale("e1")  # anyone; it only records the outcome, like release and refund_drift
    assert sends == []
    assert (c.get_engagement("e1")["status"], c.get_engagement("e1")["outcome"]) == ("decided", "split")
    c.settle("e1")
    assert sorted(sends) == sorted([(_hex(direct_bob), 500), (_hex(direct_alice), 501)])
    assert sum(v for _, v in sends) == 1001
    assert c.get_engagement("e1")["status"] == "settled"
    with direct_vm.expect_revert():
        c.reclaim_stale("e1")
    with direct_vm.expect_revert():
        c.settle("e1")
    assert len(sends) == 2


def test_a_stale_split_cannot_override_a_drift_the_verifier_already_recorded(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    # The provider (or anyone) must not be able to turn a recorded drift into half the escrow by waiting for the stale point.
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    _vouch(c, fake, status="drifted", checked_at=_ts(AFTER))
    direct_vm.warp(AFTER_STALE)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("drifted"):
        c.reclaim_stale("e1")
    assert c.get_engagement("e1")["status"] == "verified"
    c.refund_drift("e1")  # the client's remedy still works
    c.settle("e1")
    assert sends == [(_hex(direct_alice), 1000)]


def test_a_stale_split_cannot_override_a_verified_record_whose_digest_changed(direct_vm, direct_deploy, direct_alice, direct_bob):
    # Still "verified", but it is no longer the file that was committed (publisher and file changed together): that is drift too.
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    _vouch(c, fake, digest=hashlib.sha256(b"another build").hexdigest(), checked_at=_ts(AFTER))
    direct_vm.warp(AFTER_STALE)
    with direct_vm.expect_revert("drifted"):
        c.reclaim_stale("e1")
    assert c.get_engagement("e1")["status"] == "verified"


def test_a_stale_split_cannot_override_a_release_that_is_ready(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    # A fresh finalized check after the window means release applies; the client must not front-run it with a split.
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp(AFTER_STALE)
    fake.now = _ts(AFTER_STALE)
    _vouch(c, fake, checked_at=_ts(AFTER_STALE) - 60)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("release"):
        c.reclaim_stale("e1")
    c.release("e1")
    c.settle("e1")
    assert sends == [(_hex(direct_bob), 1000)]


def test_a_stale_split_still_happens_when_the_verifier_cannot_be_read(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    # Unreadable is "nobody could confirm it", never drift: the split is exactly what stale recovery is for.
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp(AFTER_STALE)
    fake.fail = True
    direct_vm.sender = direct_charlie
    c.reclaim_stale("e1")
    c.settle("e1")
    assert sorted(sends) == sorted([(_hex(direct_bob), 500), (_hex(direct_alice), 500)])


def test_a_stuck_submission_refund_needs_no_verifier_read_and_pays_in_one_step(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_submitted(direct_vm, c, direct_alice, direct_bob)
    direct_vm.warp("2026-01-02T02:00:00Z")
    direct_vm.sender = direct_alice
    fake.fail = True
    c.reclaim_stale("e1")
    assert sends == [(_hex(direct_alice), 1000)]
    assert fake.calls == []


def test_reclaim_stale_does_not_touch_other_states(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_funded(direct_vm, c, direct_alice, direct_bob)
    direct_vm.warp(LATE)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Not eligible"):
        c.reclaim_stale("e1")


def test_a_stale_split_is_blocked_once_release_is_possible_and_taken(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _decided_provider(direct_vm, c, fake, direct_alice, direct_bob)
    direct_vm.warp(LATE)
    with direct_vm.expect_revert("Not eligible"):
        c.reclaim_stale("e1")  # already decided: only settle moves it
    c.settle("e1")
    assert sends == [(_hex(direct_bob), 1000)]


# ---------------------------------------------------------------------------
# accounting, paging, safety
# ---------------------------------------------------------------------------


def test_every_terminal_path_pays_exactly_the_funds_held(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _decided_provider(direct_vm, c, fake, direct_alice, direct_bob, "a", 700)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob, "b", 333, name="other-b")
    _vouch(c, fake, "b", status="drifted")
    c.refund_drift("b")
    _create(direct_vm, c, direct_alice, direct_bob, "c", 91, name="other-c")
    direct_vm.sender = direct_alice
    c.reclaim_timeout("c")
    c.settle("a")
    c.settle("b")
    assert sorted(sends) == sorted([(_hex(direct_bob), 700), (_hex(direct_alice), 333), (_hex(direct_alice), 91)])
    a = c.get_accounting()
    assert (a["total_received"], a["total_scheduled"], a["unscheduled"]) == (1124, 1124, 0)
    for k in ("a", "b", "c"):
        assert c.get_engagement(k)["status"] == "settled"


def test_unknown_engagements_revert(direct_vm, direct_deploy, direct_alice):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.sender = direct_alice
    for call in (lambda: c.accept("nope", "x"), lambda: c.submit("nope"), lambda: c.verify("nope"), lambda: c.release("nope"),
                 lambda: c.refund_drift("nope"), lambda: c.settle("nope"), lambda: c.reclaim_timeout("nope"), lambda: c.reclaim_stale("nope"),
                 lambda: c.get_engagement("nope")):
        with direct_vm.expect_revert("not found"):
            call()


def test_ids_are_paged_and_capped_and_never_revert(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    for i in range(55):
        _create(direct_vm, c, direct_alice, direct_bob, eid=f"id{i:02d}", value=10, name=f"f{i}")
    assert c.get_engagement_count() == 55
    assert len(c.get_engagement_ids(0, 500)) == 50 and c.get_engagement_ids(50, 500) == [f"id{i:02d}" for i in range(50, 55)]
    for bad in ((-1, 5), (0, 0), (0, -3), (True, 5), (0, True), (900, 5)):
        assert c.get_engagement_ids(*bad) == []


def test_the_verifier_is_fixed_for_the_life_of_the_contract(direct_vm, direct_deploy):
    c, fake = _setup(direct_vm, direct_deploy)
    assert c.get_verifier().lower() == VERIFIER
    with open(CONTRACT, encoding="ascii") as f:
        src = f.read()
    assert "self.verifier =" in src and src.count("self.verifier =") == 1  # assigned once, in __init__
    assert not hasattr(c, "set_verifier") and not hasattr(c, "set_owner")


def test_the_contract_has_no_model_and_no_nondeterministic_block():
    with open(CONTRACT, encoding="ascii") as f:
        src = f.read()
    for forbidden in ("nondet", "exec_prompt", "run_nondet", "web.request"):
        assert forbidden not in src


# ---------------------------------------------------------------------------
# the agreed digest: a client who already knows the hash can pay only for that exact file
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["ab" * 31, "ab" * 33, "AB" * 32, "zz" * 32, " " + "ab" * 31 + "a", "0x" + "ab" * 31, 7, None])
def test_a_malformed_agreed_digest_is_refused(direct_vm, direct_deploy, direct_alice, direct_bob, bad):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    with direct_vm.expect_revert("expected_digest"):
        _create(direct_vm, c, direct_alice, direct_bob, expected=bad)
    assert c.get_engagement_count() == 0


def test_an_agreed_digest_must_be_the_one_that_was_verified(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    other = hashlib.sha256(b"a different build").hexdigest()
    _to_submitted(direct_vm, c, direct_alice, direct_bob, expected=other)
    assert c.get_engagement("e1")["expected"] == other
    _vouch(c, fake)  # the publisher's list and the bytes agree, but not with what the client asked for
    with direct_vm.expect_revert("not the agreed one"):
        c.verify("e1")
    assert c.get_engagement("e1")["status"] == "submitted"
    _vouch(c, fake, digest=other)
    c.verify("e1")
    assert c.get_engagement("e1")["digest"] == other


@pytest.mark.parametrize("where", ["first", "middle", "last"])
def test_a_near_miss_of_the_agreed_digest_is_refused(direct_vm, direct_deploy, direct_alice, direct_bob, where):
    """The comparison is on all 64 characters: a digest that differs in one place is a different file."""
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    i = {"first": 0, "middle": 31, "last": 63}[where]
    near = DIGEST[:i] + ("0" if DIGEST[i] != "0" else "1") + DIGEST[i + 1:]
    assert near != DIGEST and len(near) == 64
    _to_submitted(direct_vm, c, direct_alice, direct_bob, expected=near)
    _vouch(c, fake)
    with direct_vm.expect_revert("not the agreed one"):
        c.verify("e1")


def test_with_no_agreed_digest_the_publishers_list_decides(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _to_verified(direct_vm, c, fake, direct_alice, direct_bob)
    assert c.get_engagement("e1")["expected"] == "" and c.get_engagement("e1")["digest"] == DIGEST


def test_the_agreed_digest_is_part_of_what_the_provider_accepts(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob, eid="p0")
    _create(direct_vm, c, direct_alice, direct_bob, eid="p1", expected=DIGEST)
    assert c.get_engagement("p0")["terms_hash"] != c.get_engagement("p1")["terms_hash"]


# ---------------------------------------------------------------------------
# boundaries and accounting
# ---------------------------------------------------------------------------


def test_the_deadline_boundary_is_exact(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    sends = _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _to_funded(direct_vm, c, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    direct_vm.warp("2026-01-02T00:00:00Z")  # exactly the deadline
    with direct_vm.expect_revert("Deadline has not passed"):
        c.reclaim_timeout("e1")
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Deadline has passed"):
        c.submit("e1")  # the provider is already too late, the client is not yet allowed in: nobody can act at this instant
    direct_vm.warp("2026-01-02T00:00:01Z")
    direct_vm.sender = direct_alice
    c.reclaim_timeout("e1")
    assert sends == [(_hex(direct_alice), 1000)]


def test_accounting_tracks_a_payout_until_it_lands(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    _capture_sends(direct_vm)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob)
    me = direct_vm._contract_address
    direct_vm.deal(me, 1000)
    a = c.get_accounting()
    assert (a["total_received"], a["unscheduled"], a["in_flight"], a["shortfall"]) == (1000, 1000, 0, 0)
    direct_vm.sender = direct_alice
    c.reclaim_timeout("e1")
    a = c.get_accounting()
    assert (a["total_scheduled"], a["unscheduled"], a["in_flight"]) == (1000, 0, 1000)
    direct_vm.deal(me, 0)
    a = c.get_accounting()
    assert (a["in_flight"], a["shortfall"]) == (0, 0)


def test_accounting_reports_a_shortfall(direct_vm, direct_deploy, direct_alice, direct_bob):
    c, fake = _setup(direct_vm, direct_deploy)
    direct_vm.warp(T0)
    _create(direct_vm, c, direct_alice, direct_bob)
    direct_vm.deal(direct_vm._contract_address, 400)
    a = c.get_accounting()
    assert (a["in_flight"], a["shortfall"]) == (0, 600)


def test_removed_entry_points_stay_removed(direct_vm, direct_deploy):
    c, fake = _setup(direct_vm, direct_deploy)
    for name in ("challenge", "resolve_dispute", "retry_payout", "set_verifier", "get_payout"):
        assert not hasattr(c, name)
