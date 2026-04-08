"""Root conftest: inject repo root onto sys.path so tests/ can import
top-level modules (vault_safe_paths, vault_write_validator) without an
installed package layout."""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).parent.resolve()
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
