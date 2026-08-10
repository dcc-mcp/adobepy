import pathlib
import unittest

from scripts.report_api_coverage import build_rows, render_markdown
from scripts.validate_api_sources import DEFAULT_IR_DIR, DEFAULT_REGISTRY, validate_registry


class ApiSourceTests(unittest.TestCase):
    def test_api_source_registry_matches_ir_hosts(self):
        messages = validate_registry(DEFAULT_REGISTRY, DEFAULT_IR_DIR)
        self.assertEqual(
            {message.split(":", 1)[0] for message in messages},
            {"after-effects", "illustrator", "indesign", "photoshop", "premiere"},
        )
        self.assertTrue(all("mvp" in message and "planned" in message for message in messages))
        self.assertTrue(pathlib.Path(DEFAULT_REGISTRY).exists())

    def test_api_coverage_report_tracks_all_hosts(self):
        rows = build_rows(DEFAULT_REGISTRY)
        by_host = {row["host"]: row for row in rows}
        self.assertEqual(set(by_host), {"after-effects", "illustrator", "indesign", "photoshop", "premiere"})
        self.assertGreater(by_host["photoshop"]["mvp"], by_host["premiere"]["mvp"])
        self.assertEqual(by_host["photoshop"]["planned"], 0)
        self.assertEqual(by_host["photoshop"]["percent"], 100.0)
        self.assertFalse(by_host["photoshop"]["structured_dom"])
        self.assertEqual(by_host["premiere"]["mvp"], 5)
        self.assertEqual(by_host["premiere"]["planned"], 0)
        self.assertEqual(by_host["premiere"]["percent"], 100.0)
        self.assertTrue(by_host["premiere"]["structured_dom"])
        self.assertTrue(by_host["indesign"]["structured_dom"])
        self.assertTrue(by_host["after-effects"]["structured_dom"])
        self.assertTrue(by_host["illustrator"]["structured_dom"])
        self.assertNotIn("Sequences, tracks, clips, and markers", by_host["premiere"]["next"])
        self.assertNotIn("Project items, media import, and bins", by_host["premiere"]["next"])
        self.assertNotIn("Encoder/export workflows", by_host["premiere"]["next"])
        report = render_markdown(rows)
        self.assertIn("not a percentage of Adobe's complete API surface", report)
        self.assertIn("Structured official DOM", report)


if __name__ == "__main__":
    unittest.main()
