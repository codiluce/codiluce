"""Independent streaming SQLite audit of original and resumed snapshot columns.

Only Python's standard library runs. Original targets and their dependencies,
hooks, configurations, runtimes and compilers never execute.
"""
import argparse
import hashlib
import json
import pathlib
import sqlite3
import stat
import sys
from datetime import datetime, timezone


TABLE_KEYS = {
    "snapshots": ("seq",),
    "entity_versions": ("vid",),
    "relation_versions": ("vid",),
    "diagnostic_versions": ("vid",),
    "snapshot_entities": ("snapshot", "version"),
    "snapshot_relations": ("snapshot", "version"),
    "snapshot_diagnostics": ("snapshot", "version"),
}


def file_hash(file):
    digest = hashlib.sha256()
    with file.open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_columns(file, expected):
    file = pathlib.Path(file).absolute()
    assert file.resolve() == file, "Database path crosses an alias"
    assert stat.S_ISREG(file.lstat().st_mode), "Database must be a regular file"
    assert expected["schema"] == 1
    assert expected["format"] == "complete-snapshot-sqlite-column-ledger-v1"
    assert set(expected["tables"]) == set(TABLE_KEYS), "Incomplete snapshot table inventory"
    max_bytes, max_rows = expected["maxTableBytes"], expected["maxRows"]
    assert isinstance(max_bytes, int) and max_bytes > 0
    assert isinstance(max_rows, int) and max_rows > 0
    before = file_hash(file)
    connection = sqlite3.connect(file.as_uri() + "?mode=ro", uri=True)
    observed = {}
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
        for table, keys in TABLE_KEYS.items():
            columns = [row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")]
            digest, size, count, largest = hashlib.sha256(), 0, 0, 0

            def emit(data):
                nonlocal size
                size += len(data)
                assert size <= max_bytes, "Independent snapshot table byte budget exceeded"
                digest.update(data)

            header = json.dumps({"table": table, "columns": columns},
                                ensure_ascii=False, separators=(",", ":")) + "\n"
            emit(header.encode("utf-8"))
            cursor = connection.execute("SELECT * FROM " + table + " ORDER BY " + ",".join(keys))
            # sqlite3's cursor yields one complete row, rather than decoding
            # all rows or the complete historical graph into duplicate arrays.
            for values in cursor:
                count += 1
                assert count <= max_rows, "Independent snapshot table row budget exceeded"
                emit(b"row:")
                for value in values:
                    if value is None:
                        emit(b"null;")
                        continue
                    assert type(value) in (str, int), "Unexpected SQLite column type"
                    text = str(value) if type(value) is int else value
                    encoded, kind = text.encode("utf-8"), "n" if type(value) is int else "s"
                    if kind == "s":
                        largest = max(largest, len(encoded))
                    emit((kind + str(len(encoded)) + ":").encode("ascii"))
                    emit(encoded)
                    emit(b";")
                emit(b"\n")
            actual = {"sha256": digest.hexdigest(), "bytes": size, "rows": count,
                      "columns": columns, "largestTextBytes": largest}
            assert actual == expected["tables"][table], "Complete column ledger differs: " + table
            observed[table] = actual
    finally:
        connection.close()
    after = file_hash(file)
    assert after == before, "Read-only database bytes changed"
    return {"database": str(file), "sha256": before, "sha256After": after,
            "completeColumnLedgersMatch": True, "tables": observed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resume", required=True, type=pathlib.Path)
    parser.add_argument("--original", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    options = parser.parse_args()
    resume, original = options.resume.resolve(strict=True), options.original.resolve(strict=True)
    output = options.output.absolute()
    assert output.parent.resolve(strict=True) == output.parent, "Output parent crosses an alias"
    assert not output.is_relative_to(resume) and not output.is_relative_to(original), "Audit output is inside an observation"
    source_hash = file_hash(pathlib.Path(__file__))
    result = {"schema": 1, "startedAt": datetime.now(timezone.utc).isoformat(), "passed": False,
              "method": "Independent Python sqlite3 streaming cursors and UTF-8 typed byte framing; every SQLite column in seven complete snapshot/version/membership tables",
              "auditorSha256": source_hash, "databases": [], "full195RevisionGateQualified": False,
              "relativeHistoryTimeRssQualified": False, "nativeWindowsMacOSQualified": False}
    try:
        receipt_bytes = (resume / "receipt.json").read_bytes()
        receipt = json.loads(receipt_bytes)
        result["resumeReceiptSha256"] = hashlib.sha256(receipt_bytes).hexdigest()
        assert receipt["passed"] is True and receipt["completedAt"]
        for row in receipt["repositories"]:
            assert row["passed"] is True and row["originalObservationUnchanged"] is True
            identifier = row["id"]
            assert isinstance(identifier, str) and identifier and all(c.isalnum() or c == "-" for c in identifier)
            expected = row["child"]["originalSnapshotLedger"]
            for label, file in [("original", original / identifier / "state/history.db"),
                                ("resumed-copy", resume / identifier / "state/history.db")]:
                value = audit_columns(file, expected)
                value.update({"id": identifier, "role": label})
                if label == "original":
                    assert value["sha256"] == row["originalDatabaseSha256"]
                result["databases"].append(value)
        result["passed"] = True
    except Exception as error:
        result["error"] = str(error)
    assert file_hash(pathlib.Path(__file__)) == source_hash, "Auditor changed during observation"
    result["completedAt"] = datetime.now(timezone.utc).isoformat()
    # Preserve a distinct result, including failures; never replace evidence.
    with output.open("x", encoding="utf-8") as destination:
        json.dump(result, destination, indent=2)
        destination.write("\n")
    print(json.dumps({"passed": result["passed"], "databases": len(result["databases"]),
                      "error": result.get("error")}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
