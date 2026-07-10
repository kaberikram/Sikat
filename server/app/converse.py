"""Open-speech / presence replies — crew radio without scene mutation."""
from __future__ import annotations

import re

from .schema import Intent

# Pure greetings / thanks / presence — no set verbs.
_OPEN_SPEECH = re.compile(
    r"^\s*("
    r"(?:hello|hi|hey|yo|howdy|sup)(?:[\s,]+(?:hello|hi|hey|yo|howdy|sup))*|"
    r"thanks?(?:\s+you)?|"
    r"thank\s+you|"
    r"(?:are\s+)?you\s+there\??|"
    r"anyone\s+there\??|"
    r"good\s+(?:morning|afternoon|evening)|"
    r"what'?s\s+up|"
    r"how\s+are\s+you|"
    r"copy\??|"
    r"standing\s+by"
    r")[\s.!?]*$",
    re.I,
)

_RADIO_POOL = (
    "hey director",
    "standing by — what are we changing?",
    "copy — give me a move on set",
    "ears on",
    "right here",
    "yep — what's the call?",
)

_THANKS_POOL = (
    "anytime",
    "copy that",
    "you got it",
)

_PRESENCE_POOL = (
    "right here",
    "ears on",
    "standing by",
)

_note_idx = 0


def is_open_speech(text: str) -> bool:
    """True for greetings / thanks / presence with no set command."""
    return bool(_OPEN_SPEECH.match(text.strip()))


def radio_reply(text: str) -> str:
    """Pick an in-character one-liner for open speech or soft miss."""
    global _note_idx
    lower = text.strip().lower()
    if re.search(r"\b(thanks?|thank you)\b", lower):
        pool = _THANKS_POOL
    elif re.search(r"\b(you there|anyone there|how are you)\b", lower):
        pool = _PRESENCE_POOL
    elif is_open_speech(text):
        pool = _RADIO_POOL
    else:
        pool = (
            "standing by — what are we changing?",
            "copy — give me a move on set",
            "say again — name an object or a move",
        )
    note = pool[_note_idx % len(pool)]
    _note_idx += 1
    return note


def converse_intent(text: str) -> Intent:
    """Describe-only intent that logs a radio reply (no packets)."""
    line = radio_reply(text)
    return Intent(
        action="describe",
        describe_topic="scene",
        describe_message=line,
        say=line,
    )
