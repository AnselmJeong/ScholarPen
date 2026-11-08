import math
from types import SimpleNamespace
import unittest
from worker import text_windows, feature_spans, analyze, analyze_with_detector, utf16_length, inference_text


class Tokenizer:
    # Characters as tokens, plus BOS. Overlapping Unicode offsets are tested below.
    def encode(self, text, add_special_tokens=True, **kwargs):
        return ([0] if add_special_tokens else []) + list(range(len(text)))

    def __call__(self, text, **kwargs):
        return {"input_ids": self.encode(text), "offset_mapping": [(0, 0)] + [(i, i+1) for i in range(len(text))]}


class Detector:
    extractor = SimpleNamespace(tokenizer=Tokenizer())

    def load_head(self):
        return SimpleNamespace(threshold=0.4)

    def __call__(self, text, return_highlights):
        assert return_highlights
        return SimpleNamespace(tokens=[""] + list(text), logit=1, bias=0, label="ai", p_ai=1/(1+math.exp(-1)), features=[
            SimpleNamespace(id=1, importance=1.2, description="positive", highlights=[(1, 1)]),
            SimpleNamespace(id=2, importance=-0.2, description="negative", highlights=[(2, 2)]),
        ])


class WorkerTests(unittest.TestCase):
    def test_brackets_are_removed_from_model_input_regardless_of_citekey(self):
        class CaptureDetector(Detector):
            def __init__(self):
                self.inputs = []

            def __call__(self, text, return_highlights):
                self.inputs.append(text)
                return super().__call__(text, return_highlights)

        inputs = []
        for key in ("@pichot1995the", "@dunner1976depressive" * 40):
            text = "가😀" + "a" * 1004 + f"[{key}]" + "b" * 1000 + "[nested [inner]\ntext]END"
            detector = CaptureDetector()
            report = analyze_with_detector(text, detector)
            self.assertEqual("".join(w["text"] for w in report["windows"]), text)
            self.assertEqual(report["windows"][-1]["end"], utf16_length(text))
            self.assertTrue(all("[" not in passage and key not in passage for passage in detector.inputs))
            inputs.append(detector.inputs)
        self.assertEqual(inputs[0], inputs[1])

    def test_nested_multiline_empty_unclosed_and_bracket_only_inputs(self):
        self.assertEqual(inference_text("a[x[y]\nz]b[]c[unclosed")[0], "a b c ")
        self.assertEqual(inference_text("a]b")[0], "a]b")
        with self.assertRaisesRegex(ValueError, "대괄호"):
            analyze(" [@only] [citations] ")
        with self.assertRaisesRegex(ValueError, "짧"):
            analyze_with_detector("short[" + "x" * 1000 + "]", Detector())

    def test_highlight_crossing_excluded_range_splits_and_maps_unicode(self):
        text = "😀A[@key]한B"
        filtered, mapping = inference_text(text)
        feature = SimpleNamespace(highlights=[(0, 2), (1, 1)])
        spans = feature_spans(feature, [(0, len(filtered)), (2, 3)], text, mapping)
        self.assertEqual([(s["start"], s["end"]) for s in spans], [(0, 3), (9, 11)])
        self.assertEqual(feature_spans(feature, [(2, 3)], text, mapping), [])

    def test_every_character_including_late_text_and_unicode_is_preserved(self):
        for text in ("a"*1023, "a"*1024, "가😀é\n"*700 + "THE END"):
            windows = list(text_windows(text, Tokenizer()))
            self.assertEqual("".join(w[2] for w in windows), text)
            self.assertTrue(all(len(Tokenizer().encode(w[2])) <= 1024 for w in windows))
            self.assertEqual(windows[-1][1], len(text))

    def test_empty_oversized_and_short_inputs(self):
        for value in ("", " ", None, "x"*100001, "😀"*50001):
            with self.assertRaises(ValueError):
                analyze(value)
        with self.assertRaises(ValueError):
            list(text_windows("short", Tokenizer()))
        with self.assertRaises(ValueError):
            list(text_windows("x"*32001, Tokenizer()))

    def test_highlights_use_utf16_and_ignore_special_and_duplicate_tokens(self):
        feature = SimpleNamespace(highlights=[(0, 9), (2, 8), (3, 7), (4, 6)])
        spans = feature_spans(feature, [(0, 0), (0, 1), (1, 2), (1, 2), (2, 3)], "a😀한")
        self.assertEqual([(s["start"], s["end"]) for s in spans], [(1, 3), (3, 4)])

    def test_adapter_has_both_directions_and_no_aggregate_probability(self):
        text = "x"*1024 + "가😀"*100
        report = analyze_with_detector(text, Detector())
        self.assertEqual(report["thresholdLogit"], 0.4)
        self.assertEqual("".join(w["text"] for w in report["windows"]), text)
        self.assertEqual(report["windows"][-1]["end"], utf16_length(text))
        self.assertNotIn("pAi", report)
        self.assertEqual([f["importance"] for f in report["windows"][0]["features"]], [1.2, -0.2])

    def test_tokenizer_mismatch_fails_instead_of_reporting_wrong_locations(self):
        class BadDetector(Detector):
            def __call__(self, text, return_highlights):
                result = super().__call__(text, return_highlights)
                result.tokens = ["wrong"]
                return result
        with self.assertRaisesRegex(ValueError, "일치"):
            analyze_with_detector("x"*100, BadDetector())


if __name__ == "__main__":
    unittest.main()
