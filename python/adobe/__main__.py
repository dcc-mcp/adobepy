"""Entry point for ``python -m adobe``.

The ``adobepy`` distribution installs the ``adobe`` import package; this module
exposes its command line surface so a wheel-only install can be diagnosed and
operated without the Rust CLI. See :mod:`adobe.cli` for the commands.
"""

from __future__ import annotations

import sys

from adobe.cli import main

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
