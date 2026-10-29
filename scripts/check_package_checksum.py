"""Fail closed unless a release ZIP matches its adjacent SHA-256 sidecar."""

import argparse
import hashlib
import pathlib
import re
import sys


def verify_checksum(archive):
    """Verify the single digest and filename emitted by package-release.sh."""
    sidecar = pathlib.Path(str(archive) + ".sha256")
    content = sidecar.read_text(encoding="utf-8").strip()
    match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *](.+)", content)
    if not match or match.group(2) != archive.name:
        raise ValueError("checksum must contain one SHA-256 digest for " + archive.name)
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != match.group(1).lower():
        raise ValueError("SHA-256 mismatch for " + archive.name)


def main():
    """Validate the requested artifact without trusting sidecar paths."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=pathlib.Path)
    args = parser.parse_args()
    try:
        verify_checksum(args.archive)
    except (OSError, UnicodeError, ValueError) as error:
        print("error: " + str(error), file=sys.stderr)
        return 1
    print("SHA-256 verified: " + args.archive.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
