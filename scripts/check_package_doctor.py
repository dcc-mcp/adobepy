"""Validate release doctor JSON; only an absent broker is expected in CI."""

import json
import sys


REQUIRED = {"broker_port", "python_runtime", "bootstrap_helper", "bridge_templates"}


def validate_checks(checks):
    """Reject missing, malformed, duplicate or failed package-health checks."""
    if not isinstance(checks, list) or not checks:
        raise ValueError("doctor must return a nonempty list")
    names = set()
    for check in checks:
        if not isinstance(check, dict):
            raise ValueError("invalid doctor check")
        name, ok = check.get("name"), check.get("ok")
        if not isinstance(name, str) or name in names or not isinstance(ok, bool):
            raise ValueError("invalid or duplicate doctor check")
        names.add(name)
        print("  [{}] {}: {}".format("ok" if ok else "warn", name, check.get("detail", "")))
        if not ok and name != "broker_port":
            raise ValueError("unexpected doctor failure: " + name)
    if not REQUIRED.issubset(names):
        raise ValueError("missing doctor checks: " + ", ".join(sorted(REQUIRED - names)))


def main():
    """Read and enforce doctor output rather than merely displaying it."""
    try:
        validate_checks(json.load(sys.stdin))
    except (ValueError, TypeError) as error:
        print("error: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
