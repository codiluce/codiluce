"""Independently audit one completed fresh indexHistory database.

The parent receipt may advance through other repositories. Capture its exact
bytes, require this repository's terminal row to remain unchanged, and join
the independently streamed columns to the actual worker snapshot UUIDs.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import stat
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True
_core_file = pathlib.Path(__file__).absolute().with_name("audit-history-columns.py")
_spec = importlib.util.spec_from_file_location("codiluce_history_columns", _core_file)
_columns = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_columns)
audit_columns, file_hash = _columns.audit_columns, _columns.file_hash


def regular(file):
    assert file.resolve(strict=True) == file, "Input path crosses an alias"
    assert stat.S_ISREG(file.lstat().st_mode), "Input must be a regular file"


def dead(pid):
    assert type(pid) is int and pid > 0
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return
    raise AssertionError("Completed observation process is still live: " + str(pid))


def repository(receipt, identifier):
    rows = receipt["repositories"]
    assert len({row["id"] for row in rows}) == len(rows), "Duplicate repository"
    found = [row for row in rows if row["id"] == identifier]
    assert len(found) == 1, "Missing repository"
    return found[0]


def inputs(receipt):
    return {key: receipt[key] for key in (
        "schema", "startedAt", "phase", "engineIdentity", "observer",
        "corpusSha256", "profilesSha256", "baselineReceiptSha256",
        "baselineEngineSha256",
    )} | {"baselineQualificationSha256": receipt.get("baselineQualificationSha256")}


def no_wal(database):
    wal = pathlib.Path(str(database) + "-wal")
    if wal.exists():
        regular(wal)
        assert wal.stat().st_size == 0, "Completed database has nonempty WAL"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    options = parser.parse_args()
    receipt_file, output = options.receipt.absolute(), options.output.absolute()
    identifier = options.repository
    assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", identifier), "Unsafe repository ID"
    regular(receipt_file)
    assert output.parent.resolve(strict=True) == output.parent, "Output parent crosses an alias"
    assert not output.is_relative_to(receipt_file.parent), "Audit output is inside an observation"
    captured_file = pathlib.Path(str(output) + ".inputs.json")
    assert not output.exists() and not captured_file.exists(), "Audit evidence already exists"
    auditor = pathlib.Path(__file__).absolute()
    core = auditor.with_name("audit-history-columns.py")
    regular(auditor)
    regular(core)
    auditor_sha, core_sha = file_hash(auditor), file_hash(core)
    result = {"schema": 1, "id": identifier, "startedAt": datetime.now(timezone.utc).isoformat(),
              "passed": False, "auditorSha256": auditor_sha, "columnAuditorSha256": core_sha,
              "full195RevisionEntrypointQualified": False,
              "relativeHistoryTimeRssQualified": False, "nativeWindowsMacOSQualified": False,
              "method": "Independent Python sqlite3 read-only streaming audit of every column in all seven fresh history tables, joined to exact actual worker snapshot UUIDs and an immutable terminal repository row"}
    captured = {}
    try:
        original = receipt_file.read_bytes()
        receipt = json.loads(original)
        row = repository(receipt, identifier)
        captured = {"schema": 1, "receiptFile": str(receipt_file),
                    "receiptSha256": hashlib.sha256(original).hexdigest(),
                    "receiptUtf8": original.decode("utf-8")}
        result["inputReceiptSha256"] = captured["receiptSha256"]
        assert receipt["schema"] == 1
        assert receipt["phase"] == "fresh-production-indexHistory-entrypoint-workers-and-resume"
        assert row["passed"] is True and row["completedAt"], "Repository is not terminal and passed"
        assert row["process"]["exitCode"] == 0 and row["process"]["signal"] is None
        assert row["originalDatabaseUnchanged"] is True
        dead(row["process"]["pid"])
        unit = receipt_file.parent / identifier
        child_file, job_file = unit / "child-receipt.json", unit / "job.json"
        regular(child_file)
        regular(job_file)
        child_bytes, job_bytes = child_file.read_bytes(), job_file.read_bytes()
        child, job = json.loads(child_bytes), json.loads(job_bytes)
        assert child == row["child"], "Standalone child differs from captured parent row"
        assert child["id"] == identifier and child["pid"] == row["process"]["pid"]
        assert child["passed"] is True and child["completedAt"]
        assert child["readOnlyReopenVerified"] is True
        record = job["record"]
        assert record["id"] == identifier
        commits = [revision["commit"] for revision in record["revisions"]]
        assert commits and len(set(commits)) == len(commits)
        revisions = {revision["commit"]: revision for revision in child["revisions"]}
        assert len(revisions) == len(child["revisions"])
        assert set(revisions) == set(commits), "Complete revision set differs"
        workers = child["workers"]
        assert len(workers) == 2 and len({worker["pid"] for worker in workers}) == 2
        size = (len(commits) + 1) // 2
        expected_chunks = {tuple(commits[:size]), tuple(commits[size:])}
        assert len(expected_chunks) == 2 and all(expected_chunks)
        assert {tuple(worker["job"]["commits"]) for worker in workers} == expected_chunks
        for worker in workers:
            dead(worker["pid"])
            assert worker["exitCode"] == 0 and worker["signal"] is None
            assert worker["results"] == worker["job"]["commits"] == worker["acknowledgements"]
            for commit in worker["results"]:
                revision = revisions[commit]
                assert revision["workerPid"] == worker["pid"]
                assert revision["status"] == "verified" and revision["acknowledged"] is True
                assert revision["logical"] == revision["readback"]
                assert revision["logical"]["normalization"] == []
        database = unit / "state/history.db"
        assert pathlib.Path(job["state"]) == database.parent
        regular(database)
        no_wal(database)
        assert file_hash(database) == row["databaseSha256"], "Database differs from terminal observation"
        result["database"] = audit_columns(database, child["snapshotColumnLedger"])
        assert result["database"]["sha256"] == row["databaseSha256"]
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
            connection.execute("PRAGMA query_only=ON")
            saved = list(connection.execute("SELECT id,seq,commit_sha FROM snapshots ORDER BY seq"))
        assert len(saved) == len(commits)
        expected = {(revision["snapshot"]["id"], revision["snapshot"]["seq"], commit)
                    for commit, revision in revisions.items()}
        assert len(expected) == len(commits) and set(saved) == expected, "Actual snapshot UUID/sequence/commit join differs"
        result["revisions"] = len(saved)
        result["actualSnapshotIdentities"] = [dict(zip(("id", "seq", "commit"), values)) for values in saved]
        result["childReceiptSha256"] = hashlib.sha256(child_bytes).hexdigest()
        result["jobSha256"] = hashlib.sha256(job_bytes).hexdigest()
        after = json.loads(receipt_file.read_bytes())
        assert repository(after, identifier) == row, "Completed repository row changed during independent audit"
        assert inputs(after) == inputs(receipt), "Frozen receipt inputs changed during independent audit"
        assert child_file.read_bytes() == child_bytes and job_file.read_bytes() == job_bytes
        assert file_hash(database) == row["databaseSha256"]
        no_wal(database)
        result["passed"] = True
    except Exception as error:
        result["error"] = type(error).__name__ + ": " + str(error)
    assert file_hash(auditor) == auditor_sha and file_hash(core) == core_sha, "Auditor changed"
    result["completedAt"] = datetime.now(timezone.utc).isoformat()
    with captured_file.open("x", encoding="utf-8") as destination:
        json.dump(captured, destination, ensure_ascii=False, indent=2)
        destination.write("\n")
    result["inputSnapshot"] = {"file": str(captured_file), "sha256": file_hash(captured_file)}
    with output.open("x", encoding="utf-8") as destination:
        json.dump(result, destination, indent=2)
        destination.write("\n")
    print(json.dumps({"id": identifier, "passed": result["passed"], "revisions": result.get("revisions"),
                      "error": result.get("error")}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
