import unittest
from worker import token_windows, analyze
from detector.text_hidden_chars import scan


class WorkerTests(unittest.TestCase):
    def test_all_transitions_scored_once_including_late_text(self):
        for length in (64, 256, 257, 511, 512, 513, 4096):
            ids = list(range(length))
            windows = list(token_windows(ids))
            transitions = [(a, b) for window in windows for a, b in zip(window, window[1:])]
            self.assertEqual(transitions, list(zip(ids, ids[1:])))
            self.assertTrue(all(2 <= len(window) <= 256 for window in windows))

    def test_empty_and_oversized_inputs_fail_before_loading_models(self):
        for value in ("", " ", None, "x" * 100_001):
            with self.assertRaises(ValueError):
                analyze(value)

    def test_hidden_unicode_categories_remain_separate(self):
        report = scan("hello\u200b world\u00a0—")
        self.assertEqual(report.counts, {"zero_width": 1, "odd_space": 1, "smart_punct": 1})


if __name__ == "__main__":
    unittest.main()
