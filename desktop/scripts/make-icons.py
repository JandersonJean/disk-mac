"""Compatibility wrapper for the native macOS icon generator.

    python3 scripts/make-icons.py
"""

import subprocess
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_suffix(".swift")
CACHE = Path(tempfile.gettempdir()) / "disk-mac-swift-module-cache"
CACHE.mkdir(parents=True, exist_ok=True)
subprocess.run(["swift", "-module-cache-path", str(CACHE), str(SCRIPT)], check=True)
