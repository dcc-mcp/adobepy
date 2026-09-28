from __future__ import annotations

import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit


@dataclass
class BrokerHandle:
    """A broker connection that only stops processes started by this handle."""

    url: str
    token: str
    process: subprocess.Popen[bytes] | None = None

    def stop(self, timeout: float = 5.0) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=timeout)


def _resolve_executable() -> Optional[str]:
    """Resolve the broker executable through the shared CLI discovery order."""

    from adobe.cli import resolve_broker_executable

    executable, _locations = resolve_broker_executable()
    return executable


def _missing_broker_error() -> FileNotFoundError:
    """Build the actionable error raised when no broker executable resolves."""

    from adobe.cli import broker_remediation

    return FileNotFoundError(broker_remediation())


def ensure_broker(
    *,
    broker_url: str | None = None,
    token: str | None = None,
    broker_path: str | None = None,
    timeout: float = 5.0,
) -> BrokerHandle:
    """Reuse a healthy broker or start one with the documented runtime contract."""

    url = (broker_url or os.getenv("ADOBEPY_BROKER_URL") or "http://127.0.0.1:47391").rstrip("/")
    configured_token = token or os.getenv("ADOBEPY_TOKEN")
    if _healthy(url):
        if not configured_token:
            raise RuntimeError("healthy adobepy broker found but ADOBEPY_TOKEN is not configured")
        _export_connection(url, configured_token)
        return BrokerHandle(url, configured_token)

    active_token = configured_token or f"dev-{uuid.uuid4()}"

    executable = broker_path or _resolve_executable()
    if not executable or not os.path.isfile(executable):
        raise _missing_broker_error()

    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or not parsed.port:
        raise ValueError("ADOBEPY_BROKER_URL must be a loopback HTTP URL with an explicit port")
    bind_host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    process = subprocess.Popen(
        [executable, "broker", "--bind", f"{bind_host}:{parsed.port}", "--token", active_token],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    handle = BrokerHandle(url, active_token, process)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        if _healthy(url):
            _export_connection(url, active_token)
            return handle
        time.sleep(0.1)
    handle.stop()
    raise RuntimeError(f"adobepy broker did not become healthy at {url}")


def _healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=0.5) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def _export_connection(url: str, token: str) -> None:
    os.environ["ADOBEPY_BROKER_URL"] = url
    os.environ["ADOBEPY_TOKEN"] = token


__all__ = ["BrokerHandle", "ensure_broker"]
