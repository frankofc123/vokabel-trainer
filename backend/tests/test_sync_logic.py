import unittest

from sync_logic import merge_lessons


class MergeLessonsTests(unittest.TestCase):
    def test_newer_remote_update_wins(self):
        existing_rows = [
            {
                "user": "alex",
                "sprache": "latein",
                "lexikon": "Lektion 1",
                "wort": "domus",
                "status": "gar nicht",
                "richtig": 0,
                "falsch": 0,
                "updated_at": "2024-01-01T00:00:00",
            }
        ]
        incoming_lessons = {
            "Lektion 1": [
                {
                    "wort": "domus",
                    "uebersetzung": "Haus",
                    "genus": "f",
                    "status": "sehr gut",
                    "richtig": 3,
                    "falsch": 0,
                    "updated_at": "2024-01-02T00:00:00",
                }
            ]
        }

        merged = merge_lessons(existing_rows, incoming_lessons, "alex", "latein")

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["status"], "sehr gut")
        self.assertEqual(merged[0]["richtig"], 3)

    def test_local_change_is_preserved_when_server_is_older(self):
        existing_rows = [
            {
                "user": "alex",
                "sprache": "latein",
                "lexikon": "Lektion 1",
                "wort": "domus",
                "status": "sehr gut",
                "richtig": 3,
                "falsch": 0,
                "updated_at": "2024-01-02T00:00:00",
            }
        ]
        incoming_lessons = {
            "Lektion 1": [
                {
                    "wort": "domus",
                    "uebersetzung": "Haus",
                    "genus": "f",
                    "status": "gar nicht",
                    "richtig": 0,
                    "falsch": 1,
                    "updated_at": "2024-01-01T00:00:00",
                }
            ]
        }

        merged = merge_lessons(existing_rows, incoming_lessons, "alex", "latein")

        self.assertEqual(merged[0]["status"], "sehr gut")
        self.assertEqual(merged[0]["richtig"], 3)

    def test_created_at_is_used_when_updated_at_is_empty(self):
        existing_rows = [
            {
                "user": "alex",
                "sprache": "latein",
                "lexikon": "Lektion 1",
                "wort": "domus",
                "status": "gar nicht",
                "richtig": 0,
                "falsch": 0,
                "updated_at": "",
                "created_at": "2024-01-01T00:00:00",
            }
        ]
        incoming_lessons = {
            "Lektion 1": [
                {
                    "wort": "domus",
                    "uebersetzung": "Haus",
                    "genus": "f",
                    "status": "sehr gut",
                    "richtig": 2,
                    "falsch": 0,
                    "updated_at": "",
                    "created_at": "2024-01-02T00:00:00",
                }
            ]
        }

        merged = merge_lessons(existing_rows, incoming_lessons, "alex", "latein")

        self.assertEqual(merged[0]["status"], "sehr gut")
        self.assertEqual(merged[0]["richtig"], 2)


if __name__ == "__main__":
    unittest.main()
