"""Small process-local guard for third-party HTTP calls that omit a timeout."""

from __future__ import annotations

from typing import Any

import requests


def install_default_requests_timeout(timeout_seconds: float) -> None:
    if timeout_seconds <= 0:
        raise ValueError("HTTP timeout must be positive.")
    current = requests.sessions.Session.request
    if getattr(current, "_badguard_timeout", False):
        return

    def bounded_request(self: requests.Session, method: str, url: str, **kwargs: Any):
        kwargs.setdefault("timeout", timeout_seconds)
        return current(self, method, url, **kwargs)

    setattr(bounded_request, "_badguard_timeout", True)
    requests.sessions.Session.request = bounded_request  # type: ignore[method-assign]
