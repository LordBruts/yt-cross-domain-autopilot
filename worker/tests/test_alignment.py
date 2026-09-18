"""Unit tests for the ElevenLabs character->word alignment fold.

Run on the host:      python -m unittest discover -s worker/tests
Run in the container: docker exec yt-media-worker python -m unittest discover -s /app/tests

Imports the REAL function from worker/alignment.py -- there is no second copy
of this logic here. A test that reimplements the thing it tests agrees with
its own bugs, which is exactly how the hand-written Code-node fixture in
PPW · Thesis Chapters passed while the shipped code was broken.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from alignment import fold_characters_to_words  # noqa: E402


def spell(text, start=0.0, step=0.1):
    """Build a character-aligned payload for `text`, one step per character.

    Mirrors the shape ElevenLabs actually returns: three parallel arrays.
    """
    chars = list(text)
    starts = [round(start + i * step, 6) for i in range(len(chars))]
    ends = [round(start + (i + 1) * step, 6) for i in range(len(chars))]
    return chars, starts, ends


class TestFold(unittest.TestCase):
    def test_simple_sentence_splits_on_whitespace(self):
        words = fold_characters_to_words(*spell("hello there world"))
        self.assertEqual([w["text"] for w in words], ["hello", "there", "world"])

    def test_word_start_is_first_char_and_end_is_last_char(self):
        # "ab cd": a=0.0-0.1, b=0.1-0.2, space, c=0.3-0.4, d=0.4-0.5
        words = fold_characters_to_words(*spell("ab cd"))
        self.assertAlmostEqual(words[0]["start"], 0.0)
        self.assertAlmostEqual(words[0]["end"], 0.2)
        self.assertAlmostEqual(words[1]["start"], 0.3)
        self.assertAlmostEqual(words[1]["end"], 0.5)

    def test_timings_are_monotonic_and_non_inverted(self):
        words = fold_characters_to_words(*spell("the quick brown fox jumps"))
        for w in words:
            self.assertLess(w["start"], w["end"], "%r has start >= end" % w["text"])
        for a, b in zip(words, words[1:]):
            self.assertLessEqual(a["end"], b["start"] + 1e-9)

    def test_punctuation_stays_attached_to_its_word(self):
        # The caption renderer wants "scan," as one token, not "scan" + ",".
        words = fold_characters_to_words(*spell("the scan, and more"))
        self.assertEqual([w["text"] for w in words], ["the", "scan,", "and", "more"])

    def test_percentage_survives_intact(self):
        # The reason `alignment` is used rather than `normalized_alignment`:
        # the normalized variant would have rewritten this to "thirty three
        # percent" and the captions would no longer match the script.
        words = fold_characters_to_words(*spell("up 33% now"))
        self.assertIn("33%", [w["text"] for w in words])

    def test_collapses_runs_of_whitespace_without_emitting_empties(self):
        words = fold_characters_to_words(*spell("a  \t b\n\nc"))
        self.assertEqual([w["text"] for w in words], ["a", "b", "c"])
        self.assertTrue(all(w["text"].strip() for w in words))

    def test_leading_and_trailing_whitespace(self):
        words = fold_characters_to_words(*spell("  padded  "))
        self.assertEqual([w["text"] for w in words], ["padded"])

    def test_final_word_without_trailing_space_is_not_dropped(self):
        # An off-by-one here silently truncates the last caption of every video.
        words = fold_characters_to_words(*spell("first second"))
        self.assertEqual(words[-1]["text"], "second")

    def test_empty_input_returns_empty(self):
        self.assertEqual(fold_characters_to_words([], [], []), [])

    def test_whitespace_only_input_returns_empty(self):
        self.assertEqual(fold_characters_to_words(*spell("   ")), [])

    # -- the negative cases, which are the point of this file ---------------

    def test_mismatched_arrays_raise_instead_of_truncating(self):
        """zip() would silently stop at the shortest array.

        The visible symptom would be captions that stop part-way through the
        video with no error anywhere -- so this must raise, and the caller
        treats the raise as a reason to fall back to edge-tts.
        """
        chars, starts, ends = spell("hello world")
        with self.assertRaises(ValueError):
            fold_characters_to_words(chars, starts[:-3], ends)
        with self.assertRaises(ValueError):
            fold_characters_to_words(chars, starts, ends[:-3])
        with self.assertRaises(ValueError):
            fold_characters_to_words(chars[:-3], starts, ends)

    def test_every_character_of_input_is_represented(self):
        """No characters may be lost between input and output.

        Catches a whole class of buffer-handling slip that leaves the captions
        subtly wrong rather than obviously broken.
        """
        text = "AI in radiology: a 33% change, reported by Radiology Business."
        words = fold_characters_to_words(*spell(text))
        self.assertEqual("".join(w["text"] for w in words), text.replace(" ", ""))

    def test_word_count_matches_plain_split(self):
        text = "the quick  brown fox, jumped over 2 lazy dogs."
        words = fold_characters_to_words(*spell(text))
        self.assertEqual(len(words), len(text.split()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
