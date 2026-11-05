"""Optional live Photoshop smoke for self-hosted runners.

Normal CI skips this script unless ADOBEPY_LIVE_PHOTOSHOP=1 is set.

The default import path is deliberately wheel-only: this script does not inject
the source checkout into sys.path, so a run proves the *installed* wheel works.
Pass --source-python only for source-tree development, and --require-wheel to
assert that `adobe` resolved from this run's clean venv site-packages.

Real-host mutation is fail-closed. A caller-supplied --isolated-document-id is
not proof of isolation: the old code compared it with the active document and
then called hide/show on app.active_layers[0] anyway, so any different (or
forged) id could mutate a user's layer. --mutate now refuses unless an
IsolatedDocument ownership receipt for a scratch document explicitly created
and recorded by this run is supplied through run_isolated_mutation(). The
public facade has no create/open document API, so a plain CLI --mutate run
always refuses and never touches the active document or its layers.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys
from typing import Any, Callable


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_ROOT = ROOT / "python"


def env_or_none(name: str) -> str | None:
    value = os.getenv(name)
    return value or None


def configure_import_path(*, source_python: bool) -> None:
    """Only inject the source checkout when explicitly requested.

    The previous version always inserted ROOT/python into sys.path, which meant
    a "live" run could import an unbuilt source tree and could never prove that
    the wheel-only install works.
    """

    if source_python:
        path = str(PYTHON_ROOT)
        if path not in sys.path:
            sys.path.insert(0, path)


def assert_wheel_only() -> pathlib.Path:
    """Fail unless `adobe` came from this run's clean venv site-packages.

    A wheel-only proof needs more than "not under this checkout": a second
    source checkout, an editable install, or PYTHONPATH injection could all put
    a source tree on sys.path. Require a real venv, this interpreter's own
    purelib, no user site, and no source package directory anywhere on
    sys.path.
    """

    import site
    import sysconfig

    try:
        import adobe
    except ImportError as exc:
        raise SystemExit(
            f"--require-wheel: adobe is not importable from an installed wheel: {exc}"
        )
    origin = pathlib.Path(adobe.__file__).resolve()
    purelib = pathlib.Path(sysconfig.get_paths()["purelib"]).resolve()
    problems = []
    if sys.prefix == sys.base_prefix:
        problems.append("the interpreter is not a virtual environment")
    if purelib != origin.parent and purelib not in origin.parents:
        problems.append(f"adobe is not in this venv's site-packages ({purelib})")
    if origin == ROOT or ROOT in origin.parents:
        problems.append("adobe resolved from the source checkout")
    if os.environ.get("PYTHONPATH"):
        problems.append("PYTHONPATH is set; re-run with it unset")
    if getattr(site, "ENABLE_USER_SITE", False):
        problems.append("user site-packages is enabled; re-run with -s")
    for entry in sys.path:
        if not entry:
            continue
        candidate = pathlib.Path(entry).resolve()
        if candidate == purelib or purelib in candidate.parents:
            continue
        if (candidate / "adobe" / "__init__.py").is_file():
            problems.append(f"a source checkout is on sys.path: {candidate}")
    if problems:
        raise SystemExit("--require-wheel: " + "; ".join(problems))
    return origin


def load_sdk():
    """Import the SDK after the import path has been decided."""

    from adobe.photoshop import Photoshop

    return Photoshop


def run_phase(name: str, callback: Callable[[], Any]) -> Any:
    try:
        result = callback()
    except Exception as exc:
        code = getattr(exc, "code", None)
        print(
            f"phase={name} status=error type={type(exc).__name__} "
            f"code={code} message={exc}"
        )
        raise
    print(f"phase={name} status=ok")
    return result


def hide_show_descriptor(obj: str, layer_id: int | str | None) -> dict[str, Any]:
    target = [{"_ref": "layer", "_enum": "ordinal", "_value": "targetEnum"}]
    if layer_id is not None:
        target = [{"_ref": "layer", "_id": layer_id}]
    return {"_obj": obj, "_target": target}


class IsolatedDocument:
    """Ownership receipt for a scratch document created for this smoke run.

    A caller-supplied id is not proof of isolation. This receipt records the id
    of a document explicitly created for the run together with the ids of the
    layers resolved from *that* document; every mutation re-checks both.
    """

    def __init__(self, document: Any, nonce: str) -> None:
        document_id = getattr(document, "id", None)
        if document_id is None:
            raise RuntimeError("isolated document has no id")
        if not nonce:
            raise RuntimeError("isolated document has no run nonce")
        self.document_id = str(document_id)
        self.nonce = nonce
        self._document = document
        layer_ids = [getattr(layer, "id", None) for layer in document.layers]
        if any(layer_id is None for layer_id in layer_ids):
            raise RuntimeError("isolated document has a layer without an id")
        self._layer_ids = frozenset(str(layer_id) for layer_id in layer_ids)

    def resolve_layers(self) -> list[Any]:
        layers = list(self._document.layers)
        for layer in layers:
            self.assert_owns(layer)
        return layers

    def assert_owns(self, layer: Any) -> None:
        layer_id = getattr(layer, "id", None)
        if layer_id is None or str(layer_id) not in self._layer_ids:
            raise RuntimeError("layer is not owned by this run's isolated document")


def assert_active_document_matches(app: Any, owned: IsolatedDocument) -> None:
    """Fail closed unless the owned scratch document is still the target.

    The hide/show descriptors address a layer by id, which Photoshop resolves
    in the context of the current document. Re-check before every call: if the
    user switched documents, abort rather than risk mutating another document.
    """

    active_id = getattr(app.active_document, "id", None)
    if active_id is None or str(active_id) != owned.document_id:
        raise RuntimeError(
            "active document is no longer this run's owned isolated document"
        )


def safe_visibility_cycle(app: Any, layer: Any, owned: IsolatedDocument) -> None:
    """Hide then show a layer of an owned scratch document, restoring visibility.

    The previous implementation hid the active layer and showed it again with
    no snapshot and no `finally`. It also accepted any id that merely differed
    from the active document id, so a forged id still mutated
    app.active_layers[0]. Both the document and the layer are re-verified
    before every call; ownership that cannot be proven is a hard failure.
    """

    original = getattr(layer, "visible", None)
    if original is None:
        raise RuntimeError(
            "refusing to mutate a layer whose current visibility is unknown"
        )
    try:
        with app.execute_as_modal(command_name="adobepy live smoke hide/show"):
            for obj in ("hide", "show"):
                assert_active_document_matches(app, owned)
                owned.assert_owns(layer)
                app.batch_play([hide_show_descriptor(obj, layer.id)], modal=True)
    finally:
        # A blind restore could hit the wrong document if the target changed.
        # If it is no longer verifiable, fail closed instead of restoring.
        assert_active_document_matches(app, owned)
        owned.assert_owns(layer)
        with app.execute_as_modal(command_name="adobepy live smoke restore visibility"):
            app.batch_play(
                [hide_show_descriptor("show" if original else "hide", layer.id)],
                modal=True,
            )


def run_isolated_mutation(
    app: Any, owned: IsolatedDocument, declared_id: str | None = None
) -> None:
    """Safe isolated entry point. Resolve layers only from the owned document.

    `declared_id` is a guard, not proof: it must match the recorded receipt.
    The active document and its layers are never used as a mutation source.
    """

    if declared_id is not None and str(declared_id) != owned.document_id:
        raise RuntimeError("declared id does not match the owned isolated document")
    assert_active_document_matches(app, owned)
    layers = owned.resolve_layers()
    if not layers:
        raise RuntimeError("the owned isolated document has no layers")
    safe_visibility_cycle(app, layers[0], owned)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run an optional live Photoshop adobepy smoke.")
    parser.add_argument("--broker-url", default=env_or_none("ADOBEPY_BROKER_URL"), help="adobepy broker URL.")
    parser.add_argument("--token", default=env_or_none("ADOBEPY_TOKEN"), help="Broker auth token. Defaults to ADOBEPY_TOKEN.")
    parser.add_argument("--target", default=env_or_none("ADOBEPY_TARGET") or "default", help="Broker target id.")
    parser.add_argument("--timeout", type=float, default=30.0, help="Broker request timeout in seconds.")
    parser.add_argument("--source-python", action="store_true", help="Inject the source checkout into sys.path (development only).")
    parser.add_argument("--require-wheel", action="store_true", help="Assert adobe came from this run's clean venv site-packages.")
    parser.add_argument("--mutate", action="store_true", help="Request the visibility cycle; refuses unless an owned isolated document receipt is available.")
    parser.add_argument("--isolated-document-id", default=env_or_none("ADOBEPY_LIVE_ISOLATED_DOCUMENT_ID"), help="Declared scratch document id. Not proof of ownership: used only as a guard.")
    args = parser.parse_args(argv)

    if os.getenv("ADOBEPY_LIVE_PHOTOSHOP") != "1":
        print("skipped live Photoshop smoke: set ADOBEPY_LIVE_PHOTOSHOP=1 to enable")
        return 0

    configure_import_path(source_python=args.source_python)
    if args.require_wheel:
        print(f"wheel-origin={assert_wheel_only()}")
    Photoshop = load_sdk()

    mutate = args.mutate or os.getenv("ADOBEPY_LIVE_PHOTOSHOP_MUTATE") == "1"
    app = Photoshop(broker_url=args.broker_url, token=args.token, target=args.target, timeout=args.timeout)

    try:
        capabilities = run_phase("capabilities", app.capabilities)
        version = run_phase("version", lambda: app.version)
        # Read-only reporting only: these objects are NEVER a mutation source.
        # The mutation path needs an owned IsolatedDocument receipt (below).
        document = run_phase("active-document", lambda: app.active_document)
        print(
            f"photoshop version={version!r} "
            f"broker={getattr(app.client, 'broker_url', None)!r} "
            f"target={getattr(app.client, 'target', 'default')!r} "
            f"capability_sessions={len(capabilities or [])}"
        )
        print(f"active_document={getattr(document, 'name', None)!r}")

        if mutate:
            # A caller-supplied id is not proof of isolation. The old code
            # compared it with the active document and then called hide/show
            # on app.active_layers[0] anyway, so any different or forged id
            # could mutate a user's layer. The public facade has no
            # create/open document API, so a plain CLI run cannot produce an
            # owned IsolatedDocument receipt: fail closed, never mutate.
            reason = (
                "isolated-document-id-is-not-ownership-proof"
                if args.isolated_document_id
                else "isolated-document-ownership-unproven"
            )
            print(f"phase=modal-mutation status=refused reason={reason}")
            return 2
        print(
            "phase=modal-mutation status=skipped "
            "reason=requires an owned IsolatedDocument receipt"
        )
    except Exception:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
