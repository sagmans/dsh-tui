"""Shared approval and CLI boundaries for optional release operations."""

import json
import os
from pathlib import Path
import re
import shlex
import subprocess


class ReleaseError(Exception):
    """An unmet release condition, without raw provider response data."""


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def setting(name, pattern=None):
    value = os.environ.get(name, "")
    require(bool(value) and (pattern is None or re.fullmatch(pattern, value)), f"invalid or missing {name}")
    return value


def read_json(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError) as error:
        raise ReleaseError("invalid JSON response or metadata") from error


def run(command, *, data=None, check=True):
    result = subprocess.run(command, input=data, text=True, capture_output=True, check=False)
    require(not check or result.returncode == 0, f"{Path(command[0]).name} read failed; inspect authentication and service status privately")
    return result


def mutate(action, command, *, data=None):
    dry_run = os.environ.get("DRY_RUN", "0") == "1"
    require(dry_run or os.environ.get("CONFIRM") == action, f"set CONFIRM={action}")
    print(("dry-run: " if dry_run else "running: ") + shlex.join(command), flush=True)
    if data is not None:
        print(data, flush=True)
    if dry_run:
        return
    # Inherited streams keep npm's interactive 2FA usable; callers must not record secrets.
    result = subprocess.run(command, input=data, text=True, check=False)
    require(result.returncode == 0, "mutation failed or outcome unknown; inspect remote state before any retry")
