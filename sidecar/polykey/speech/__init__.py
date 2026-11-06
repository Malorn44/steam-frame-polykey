"""On-device dictation (opt-in): microphone capture, phrase detection, a transcribe.cpp helper
process, and the downloads of that engine and its models (catalog.json). Audio and transcripts stay in
memory: never logged, never written to disk. Failures are short status codes (SpeechError.code) that
are safe to log and to show."""

from __future__ import annotations


class SpeechError(Exception):
    """A fixed status code, the only detail of a failure that leaves the speech engine."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
