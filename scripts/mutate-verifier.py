"""Mutation check for the verifier's fetch, hash and consensus code: break contracts/lineage.py one small way at a time and confirm the
direct-mode tests notice. The file is restored afterwards, even on Ctrl+C, and must still match the deployed source (scripts/verify-deployed.mjs).
    python scripts/mutate-verifier.py"""

import os
import subprocess
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
py = os.environ.get("PY", sys.executable)
p = os.path.join(root, "contracts", "lineage.py")
orig = open(p, encoding="utf-8", newline="").read()
NL = "\r\n" if "\r\n" in orig else "\n"

M = [
    # the vote
    ("validator accepts everything", 'return all(m[k] == t[k] for k in ("kind", "digest", "listed", "size"))', "return True"),
    ("validator ignores the digest", 'for k in ("kind", "digest", "listed", "size"))', 'for k in ("kind", "listed", "size"))'),
    ("validator ignores the verdict kind", 'for k in ("kind", "digest", "listed", "size"))', 'for k in ("digest", "listed", "size"))'),
    ("validator ignores the listed digest", 'for k in ("kind", "digest", "listed", "size"))', 'for k in ("kind", "digest", "size"))'),
    ("validator ignores the size", 'for k in ("kind", "digest", "listed", "size"))', 'for k in ("kind", "digest", "listed"))'),
    ("validator accepts a leader error", "if not isinstance(res, gl.vm.Return):\n                return False", "if not isinstance(res, gl.vm.Return):\n                return True"),
    ("validator skips the shape check", 'if not isinstance(t, dict) or any(not isinstance(t.get(k), str) for k in ("kind", "digest", "listed")) or not isinstance(t.get("size"), int):\n                return False', "if not isinstance(t, dict):\n                return False"),
    ("validator never repeats the download", "            m = leader_fn()\n", '            m = {"kind": t["kind"], "digest": t["digest"], "listed": t["listed"], "size": t["size"]}\n'),
    # the fetch
    ("artifact fetched from the list url", "art = gl.nondet.web.request(artifact_url, method=", "art = gl.nondet.web.request(manifest_url, method="),
    ("list fetched from the artifact url", "man = gl.nondet.web.request(manifest_url, method=", "man = gl.nondet.web.request(artifact_url, method="),
    ("a failing status is read as a file", "if art.status != 200 or man.status != 200 or not art.body or not man.body:", "if not art.body or not man.body:"),
    ("an empty body is read as a file", "if art.status != 200 or man.status != 200 or not art.body or not man.body:", "if art.status != 200 or man.status != 200:"),
    ("only the artifact status is checked", "if art.status != 200 or man.status != 200 or", "if art.status != 200 or"),
    ("an oversized artifact is hashed", "if len(art.body) > MAX_BYTES or len(man.body) > MAX_MANIFEST:", "if len(man.body) > MAX_MANIFEST:"),
    ("an oversized list is parsed", "if len(art.body) > MAX_BYTES or len(man.body) > MAX_MANIFEST:", "if len(art.body) > MAX_BYTES:"),
    ("size limit is off by one", "MAX_BYTES = 4_000_000", "MAX_BYTES = 4_000_001"),
    # the hash
    ("hash is of something else", "digest = hashlib.sha256(art.body).hexdigest()", "digest = hashlib.sha256(man.body).hexdigest()"),
    ("hash is truncated", "digest = hashlib.sha256(art.body).hexdigest()", "digest = hashlib.sha256(art.body).hexdigest()[:63] + '0'"),
    ("size is not the artifact's", 'return {"kind": v["kind"], "digest": digest, "listed": v["listed"], "size": len(art.body)}', 'return {"kind": v["kind"], "digest": digest, "listed": v["listed"], "size": len(man.body)}'),
    # the verdict
    ("a different listed digest is verified", "if listed[0] != artifact_digest:\n        return {\"kind\": MISMATCH, \"listed\": listed[0]}", "if False:\n        return {\"kind\": MISMATCH, \"listed\": listed[0]}"),
    ("an unlisted file is verified", "    if not listed:\n        return {\"kind\": UNLISTED, \"listed\": \"\"}", "    if not listed:\n        return {\"kind\": VERIFIED, \"listed\": \"\"}"),
    ("a self-contradicting list is verified", "    if len(listed) > 1:\n        return {\"kind\": MISMATCH, \"listed\": \"\"}", "    if False:\n        return {\"kind\": MISMATCH, \"listed\": \"\"}"),
    ("digest case is not normalised", "out.append((m.group(1).lower(),", "out.append((m.group(1),"),
    # recording
    ("a verified check does not record the digest", "                a.digest = r[\"digest\"]\n", ""),
    ("drift is not recorded", "            a.status = DRIFTED\n", "            a.status = VERIFIED\n"),
    ("unreadable sources are recorded", '        _bad(r["kind"] == "unreachable", "Source unreadable, nothing recorded. Try again shortly.")\n', ""),
    ("oversized sources are recorded", '        _bad(r["kind"] == "too_large", f"Artifact or list too large (artifact at most {MAX_BYTES} bytes), nothing recorded")\n', ""),
]

results = []
try:
    for name, a, b in M:
        a = a.replace("\n", NL)
        b = b.replace("\n", NL)
        if name.startswith(("a verified check", "unreadable", "oversized")):
            a = "    " * 0 + a  # these anchors carry their own indentation
        n = orig.count(a)
        if n != 1:
            print("BAD MUTATION (anchor count %d): %s" % (n, name), flush=True)
            continue
        open(p, "w", encoding="utf-8", newline="").write(orig.replace(a, b))
        r = subprocess.run([py, "-m", "pytest", "tests/direct/test_lineage.py", "tests/direct/test_lineage_consensus.py", "-q", "-x", "-p", "no:cacheprovider"], cwd=root, capture_output=True, text=True)
        tag = "CAUGHT  " if r.returncode else "SURVIVED"
        results.append((tag, name))
        print(tag + "  " + name, flush=True)
finally:
    open(p, "w", encoding="utf-8", newline="").write(orig)
print("\n%d caught, %d survived" % (sum(1 for t, _ in results if t.strip() == "CAUGHT"), sum(1 for t, _ in results if t == "SURVIVED")))
