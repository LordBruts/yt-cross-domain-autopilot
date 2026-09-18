"""Character-level to word-level timing conversion.

Its own module, with no imports beyond the standard library, for one reason:
it is the only piece of the ElevenLabs path that is pure, and it is the piece
most worth testing. Keeping it here means tests/test_alignment.py can import
and exercise the REAL function on any machine, without fastapi, edge_tts,
httpx or a running container -- so there is never a second copy of this logic
in a test fixture that can quietly disagree with the shipped version.

app.py imports from here. There is exactly one implementation.
"""

from typing import Any, Dict, List, Optional


def fold_characters_to_words(
    characters: List[str],
    starts: List[float],
    ends: List[float],
) -> List[Dict[str, Any]]:
    """Fold ElevenLabs' CHARACTER-level alignment into word timings.

    ElevenLabs' /with-timestamps endpoint returns one timestamp per character.
    The caption builder needs one per word, in exactly the shape edge-tts
    produces: {"text": str, "start": float, "end": float}. A word's start is
    its first character's start; its end is its last character's end.

    Whitespace separates words and is not itself emitted. Punctuation stays
    attached to the word it follows, which is what the caption renderer wants
    -- "scan," is one cue token, not two.

    The length check is not defensive padding. zip() over mismatched arrays
    truncates silently, so a short `ends` array would simply stop the captions
    part-way through the video -- most likely in the back half nobody
    rewatches, with no error anywhere. Fail loudly instead; the caller treats
    it as a reason to fall back to edge-tts.
    """
    if not characters:
        return []
    if not (len(characters) == len(starts) == len(ends)):
        raise ValueError(
            "alignment arrays disagree: %d characters, %d starts, %d ends"
            % (len(characters), len(starts), len(ends))
        )

    words: List[Dict[str, Any]] = []
    buf: List[str] = []
    buf_start: Optional[float] = None
    buf_end: float = 0.0

    for ch, st, en in zip(characters, starts, ends):
        if ch.isspace():
            if buf:
                words.append(
                    {"text": "".join(buf), "start": buf_start or 0.0, "end": buf_end}
                )
                buf, buf_start, buf_end = [], None, 0.0
            continue
        if not buf:
            buf_start = st
        buf.append(ch)
        buf_end = max(buf_end, en)

    if buf:
        words.append({"text": "".join(buf), "start": buf_start or 0.0, "end": buf_end})

    return words
