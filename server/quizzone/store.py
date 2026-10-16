"""Crash-safe JSON persistence (write temp file, fsync, atomic rename)."""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any, Optional


class Store:
    def __init__(self, path: Optional[str]):
        self.path = path
        self.last_error: Optional[str] = None
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    def load(self) -> Optional[dict]:
        if not self.path or not os.path.exists(self.path):
            return None
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError) as e:
            # Keep the unreadable file for post-mortem instead of overwriting it.
            try:
                os.replace(self.path, self.path + ".corrupt")
            except OSError:
                pass
            self.last_error = f"state file unreadable ({e}); moved to {self.path}.corrupt"
            return None

    def save(self, data: Any) -> bool:
        if not self.path:
            return True
        d = os.path.dirname(os.path.abspath(self.path))
        try:
            fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=d)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=1)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            self.last_error = None
            return True
        except OSError as e:
            self.last_error = f"cannot save state: {e}"
            return False
