"""Share release validation and approval boundaries without exposing raw CLI responses in validation errors."""

import json
import os
from pathlib import Path
import pty
import re
import shlex
import subprocess
import sys
import time

# Limit each read buffer allocation; total captured output is not capped.
PTY_CHUNK_BYTES = 65536
# Allow bounded propagation waits when registry reads trail a completed write.
READ_ATTEMPTS = 10
READ_BACKOFF_SECONDS = 5
READ_BACKOFF_CAP_SECONDS = 120
# npm asks for a keypress before it opens the browser authentication page, and it only starts
# waiting for the browser once that keypress arrives. Without it every OTP-gated read stalls until
# the window closes, so the prompt is answered as soon as it appears.
PTY_PROMPT_PATTERN = re.compile(r"Press ENTER to open in the browser")
PTY_PROMPT_REPLY = b"\n"
# Give browser-launch input a bounded delivery opportunity without making a closed PTY a CLI failure.
PTY_REPLY_ATTEMPTS = 5
# The prompt can straddle a read boundary, so a tail longer than the prompt itself is kept and
# matched on. Matching the tail rather than the accumulated output keeps memory bounded.
PTY_PROMPT_TAIL_BYTES = 256


class ReleaseError(Exception):
    """An unmet release condition, without raw provider response data."""


class ReadFailure(ReleaseError):
    """A provider read that did not complete; the only failure a retry may repeat."""


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


def run(command, *, data=None, check=True, tty=False):
    """Capture a provider call, in a pseudo-terminal when the provider prompts the operator.

    npm starts its browser authentication flow only when stdin and stdout are terminals, so an
    authentication-gated read would fail with EOTP under a plain pipe instead of asking the operator.
    """
    if tty:
        require(data is None, "interactive capture does not accept standard input")
        result = _run_in_pty(command)
    else:
        result = subprocess.run(command, input=data, text=True, capture_output=True, check=False)
    if check and result.returncode != 0:
        raise ReadFailure(f"{Path(command[0]).name} read failed; inspect authentication and service status privately")
    return result


def _run_in_pty(command):
    """Keep browser authentication interactive while capturing metadata for the caller's validation."""
    master, slave = pty.openpty()
    answered = False
    seen = ""
    try:
        try:
            # Keep npm outside the caller's terminal session while supplying its authentication terminal explicitly.
            process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        finally:
            # A parent-held slave would keep the master open after npm exits.
            os.close(slave)
        chunks = []
        while True:
            try:
                chunk = os.read(master, PTY_CHUNK_BYTES)
            except OSError:
                # End capture, not validation: callers still check the child exit and parsed metadata.
                break
            if not chunk:
                break
            text = chunk.decode("utf-8", "replace")
            chunks.append(text)
            # Mirror the child's output so the operator can see and answer an interactive prompt.
            print(text, end="", file=sys.stderr, flush=True)
            # Only the pending browser page is answered; a genuine prompt for the operator stays open.
            seen = (seen + text)[-PTY_PROMPT_TAIL_BYTES:]
            if not answered and PTY_PROMPT_PATTERN.search(seen):
                answered = _answer_prompt(master)
        returncode = process.wait()
    finally:
        os.close(master)
    captured = "".join(chunks).replace("\r\n", "\n").replace("\r", "\n")
    return subprocess.CompletedProcess(command, returncode, captured, "")


def _answer_prompt(master):
    """Keep browser-launch input best-effort; the child exit status decides CLI success.

    Limit automatic input to one prompt match so repeated tail matches cannot answer a later operator prompt.
    Exhausted writes also consume that allowance; neither retries nor this return value establish delivery.
    """
    for _ in range(PTY_REPLY_ATTEMPTS):
        try:
            os.write(master, PTY_PROMPT_REPLY)
            return True
        except OSError:
            time.sleep(0.1)
    return True


def read_with_retry(operation, *, attempts=READ_ATTEMPTS, backoff=READ_BACKOFF_SECONDS, cap=READ_BACKOFF_CAP_SECONDS):
    """Retry a read that did not complete; a registry read can trail a completed write.

    Checked nonzero CLI exits are retryable, not just transport failures. Successfully read metadata
    with invalid shape or identity fails without retry, so propagation waits do not hide validation errors.
    """
    delay = backoff
    for attempt in range(attempts):
        try:
            return operation()
        except ReadFailure:
            if attempt + 1 == attempts:
                raise
            time.sleep(delay)
            delay = min(delay * 2, cap)


def mutate(action, command, *, data=None):
    """Require approval for this exact action; preview grants no authority.

    An uncertain write needs remote inspection, not an automatic retry that could repeat the mutation.
    """
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
