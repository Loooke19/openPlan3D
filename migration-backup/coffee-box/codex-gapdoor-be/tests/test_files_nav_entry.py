"""Files page: 「导航浏览」 is an always-visible ≥44px button beside 导入楼层 (not hover-only)."""
import re
import unittest
from pathlib import Path

PREVIEW = Path(__file__).resolve().parents[1] / "preview"


class NavEntryTests(unittest.TestCase):
    def test_entry_sits_in_the_action_row_before_import(self):
        js = (PREVIEW / "files.js").read_text(encoding="utf-8")
        row = js[js.index('<div class="row">'):]
        self.assertLess(row.index('class="nav-entry"'), row.index('data-act="import"'))
        self.assertNotIn('class="nav-entry"', js[js.index('<div class="thumb">'):js.index('<div class="meta">')])

    def test_entry_is_never_hidden_and_tall_enough(self):
        css = (PREVIEW / "files.css").read_text(encoding="utf-8")
        rule = re.search(r"\.nav-entry\s*\{([^}]*)\}", css).group(1)
        self.assertNotIn("opacity: 0", rule)
        self.assertNotIn("pointer-events: none", rule)
        self.assertGreaterEqual(int(re.search(r"min-height:\s*(\d+)px", rule).group(1)), 44)
        self.assertNotRegex(css, r":hover\s+\.nav-entry")

    def test_duplicate_names_get_an_id_suffix_and_return_target_is_highlighted(self):
        js = (PREVIEW / "files.js").read_text(encoding="utf-8")
        self.assertIn('className = "file-id"', js)
        self.assertIn("article.id = `p-${file.id}`", js)
        self.assertIn("revealReturnedCard()", js)


if __name__ == "__main__":
    unittest.main()
