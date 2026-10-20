"""Direct-mode tests for the verifier's validator consensus (contracts/lineage.py, validator_fn inside _read).

On the network one validator (the leader) downloads the artifact and the publisher's checksum list, hashes the bytes and proposes a
verdict. Every other validator repeats the download and the hash on its own and votes to accept only if its own result is identical.
These tests run that vote: they let the leader record a verdict, then change what the validator sees, or forge what the leader claimed,
and check that the validator accepts exactly the honest result and nothing else."""

import copy
import hashlib

import pytest

CONTRACT = "contracts/lineage.py"
T0 = "2026-01-01T00:00:00Z"
ART_URL = "https://dl.example.com/app-linux-amd64"
MAN_URL = "https://dl.example.com/SHA256SUMS"
NAME = "app-linux-amd64"
BIN = b"compiled binary, version 1"
OTHER = b"a different binary, swapped in"
MAX_BYTES = 4_000_000


def _d(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _serve(vm, art=BIN, listed=None, art_status=200, man_status=200, man=None):
    """What the network serves right now: the artifact and the publisher's list."""
    vm.clear_mocks()
    text = man if man is not None else f"{_d(BIN) if listed is None else listed}  {NAME}"
    vm.mock_web("^" + ART_URL.replace(".", r"\.") + "$", {"method": "GET", "status": art_status, "body": art})
    vm.mock_web("^" + MAN_URL.replace(".", r"\.") + "$", {"method": "GET", "status": man_status, "body": text})


@pytest.fixture
def V(direct_vm, direct_deploy):
    direct_vm.warp(T0)
    c = direct_deploy(CONTRACT)
    _serve(direct_vm)
    c.attest(ART_URL, MAN_URL, NAME, "")
    aid = c.attestation_id(ART_URL, MAN_URL, NAME, "")
    c.check(aid)
    return direct_vm, c, aid


def _leader(vm):
    """The verdict the leader proposed in its last check."""
    return copy.deepcopy(vm._captured_validators[-1][0])


def test_the_leader_proposes_the_digest_it_computed_and_the_verdict_the_list_gives(V):
    vm, c, aid = V
    assert _leader(vm) == {"kind": "verified", "digest": _d(BIN), "listed": _d(BIN), "size": len(BIN)}
    assert c.get_attestation(aid)["status"] == "verified"


def test_a_validator_that_downloads_the_same_bytes_accepts(V):
    vm, _, _ = V
    assert vm.run_validator() is True


def test_a_validator_served_different_bytes_rejects(V):
    vm, _, _ = V
    _serve(vm, art=OTHER, listed=_d(BIN))  # the file changed under the leader: the digest differs
    assert vm.run_validator() is False


def test_a_validator_served_a_different_list_rejects(V):
    vm, _, _ = V
    _serve(vm, listed=_d(OTHER))  # the list now names another digest, so the verdict is a mismatch
    assert vm.run_validator() is False


def test_a_validator_whose_list_no_longer_names_the_file_rejects(V):
    vm, _, _ = V
    _serve(vm, man=f"{_d(BIN)}  some-other-file")
    assert vm.run_validator() is False


def test_a_validator_that_cannot_download_rejects_a_verdict(V):
    vm, _, _ = V
    for kw in ({"art_status": 404}, {"man_status": 500}, {"art_status": 503, "man_status": 503}, {"art": b""}):
        _serve(vm, **kw)
        assert vm.run_validator() is False, kw


@pytest.mark.parametrize("field,value", [
    ("digest", "0" * 64),  # a digest the leader did not compute
    ("digest", _d(OTHER)),
    ("listed", _d(OTHER)),
    ("listed", ""),
    ("size", len(BIN) + 1),
    ("size", 0),
    ("kind", "mismatch"),
    ("kind", "unlisted"),
    ("kind", "unbound"),
    ("kind", "unreachable"),
])
def test_a_validator_rejects_a_leader_result_with_any_field_altered(V, field, value):
    vm, _, _ = V
    forged = _leader(vm)
    forged[field] = value
    assert vm.run_validator(leader_result=forged) is False


def test_a_validator_rejects_a_leader_that_claims_verified_for_a_file_that_does_not_match(V):
    """The attack the vote exists to stop: a leader that proposes 'verified' with the listed digest while the real bytes differ."""
    vm, _, _ = V
    _serve(vm, art=OTHER, listed=_d(BIN))
    lie = {"kind": "verified", "digest": _d(BIN), "listed": _d(BIN), "size": len(BIN)}
    assert vm.run_validator(leader_result=lie) is False
    honest = {"kind": "mismatch", "digest": _d(OTHER), "listed": _d(BIN), "size": len(OTHER)}
    assert vm.run_validator(leader_result=honest) is True  # and it accepts the leader that tells the truth about the same data


@pytest.mark.parametrize("junk", [None, [], "verified", 5, True, {}, {"kind": "verified"}, {"kind": 1, "digest": "", "listed": "", "size": 0},
                                  {"kind": "verified", "digest": _d(BIN), "listed": _d(BIN), "size": "26"},
                                  {"kind": "verified", "digest": 5, "listed": _d(BIN), "size": 26}])
def test_a_validator_rejects_a_leader_result_of_the_wrong_shape(V, junk):
    vm, _, _ = V
    assert vm.run_validator(leader_result=junk) is False


def test_a_validator_rejects_a_leader_that_errored(V):
    vm, _, _ = V
    assert vm.run_validator(leader_error=Exception("the leader crashed")) is False


def test_validators_agree_that_an_unreadable_source_is_unreadable(direct_vm, direct_deploy):
    """Nothing is recorded for a source nobody could read, and a second validator that also cannot read it agrees."""
    direct_vm.warp(T0)
    c = direct_deploy(CONTRACT)
    _serve(direct_vm, art_status=404)
    c.attest(ART_URL, MAN_URL, NAME, "")
    aid = c.attestation_id(ART_URL, MAN_URL, NAME, "")
    with direct_vm.expect_revert("Source unreadable"):
        c.check(aid)
    assert _leader(direct_vm)["kind"] == "unreachable"
    assert direct_vm.run_validator() is True  # it could not read either
    _serve(direct_vm)  # but a validator that can read the file does not accept "unreadable"
    assert direct_vm.run_validator() is False
    assert c.get_attestation(aid)["status"] == "pending"


def test_validators_agree_on_an_oversized_artifact_and_nothing_is_recorded(direct_vm, direct_deploy):
    direct_vm.warp(T0)
    c = direct_deploy(CONTRACT)
    big = b"x" * (MAX_BYTES + 1)
    _serve(direct_vm, art=big, listed=_d(big))
    c.attest(ART_URL, MAN_URL, NAME, "")
    aid = c.attestation_id(ART_URL, MAN_URL, NAME, "")
    with direct_vm.expect_revert("too large"):
        c.check(aid)
    assert _leader(direct_vm) == {"kind": "too_large", "digest": "", "listed": "", "size": MAX_BYTES + 1}
    assert direct_vm.run_validator() is True
    _serve(direct_vm, art=BIN)  # a validator that sees a normal file does not accept "too large"
    assert direct_vm.run_validator() is False
    assert c.get_attestation(aid)["status"] == "pending"


def test_the_vote_covers_a_recheck_that_finds_drift(V):
    """After a file is swapped, the leader's recheck proposes a different digest and only a validator that sees the swap accepts it."""
    vm, c, aid = V
    vm.warp("2026-01-01T01:00:00Z")
    _serve(vm, art=OTHER, listed=_d(BIN))
    c.check(aid)
    assert c.get_attestation(aid)["status"] == "drifted"
    assert _leader(vm)["digest"] == _d(OTHER)
    assert vm.run_validator() is True
    _serve(vm)  # a validator that still sees the original file does not accept the swap
    assert vm.run_validator() is False
