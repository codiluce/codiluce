"""Independent complete column audit after a history measurement has ended."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True
core_file = pathlib.Path(__file__).absolute().with_name("audit-history-columns.py")
spec = importlib.util.spec_from_file_location("codiluce_history_columns", core_file)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    options = parser.parse_args()
    source, output = options.result.absolute(), options.output.absolute()
    assert source.resolve(strict=True) == source and source.is_file()
    assert output.parent.resolve(strict=True) == output.parent
    assert not output.exists() and output != source
    raw, before = source.read_bytes(), core.file_hash(core_file)
    value = json.loads(raw)
    database = pathlib.Path(value["database"])
    assert database.is_absolute() and not output.is_relative_to(database.parent)
    result = {"schema": 1, "passed": False, "startedAt": datetime.now(timezone.utc).isoformat(),
              "measurementResultSha256": hashlib.sha256(raw).hexdigest(),
              "auditorSha256": core.file_hash(pathlib.Path(__file__)), "columnAuditorSha256": before}
    try:
        assert value["passed"] is True
        wal = pathlib.Path(str(database) + "-wal")
        assert not wal.exists() or wal.stat().st_size == 0
        result["database"] = core.audit_columns(database, value["snapshotColumnLedger"])
        result["databaseSha256"] = result["database"]["sha256"]
        assert source.read_bytes() == raw and core.file_hash(core_file) == before
        assert not wal.exists() or wal.stat().st_size == 0
        result["passed"] = True
    except Exception as error:
        result["error"] = type(error).__name__ + ": " + str(error)
    result["completedAt"] = datetime.now(timezone.utc).isoformat()
    with output.open("x") as destination:
        json.dump(result, destination, indent=2)
        destination.write("\n")
    print(json.dumps({"passed": result["passed"], "error": result.get("error")}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
