from datetime import datetime, timezone
from typing import Any, Optional


def _parse_ts(value: Optional[Any]):
    if value is None:
        return datetime.min.replace(tzinfo=timezone.utc)

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            try:
                parsed = datetime.fromisoformat(value)
            except ValueError:
                return datetime.min.replace(tzinfo=timezone.utc)

        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    return datetime.min.replace(tzinfo=timezone.utc)


def _get_effective_ts(row: dict):
    return max(
        _parse_ts(row.get("updated_at")),
        _parse_ts(row.get("created_at"))
    )


def merge_lessons(existing_rows, incoming_lessons, username: str, lang: str):
    incoming_by_word = {}

    for lesson_name, vocabs in incoming_lessons.items():
        for vocab in vocabs or []:
            if not isinstance(vocab, dict) or "wort" not in vocab:
                continue
            incoming_by_word[(lesson_name, vocab["wort"])] = vocab

    existing_by_word = {}
    for row in existing_rows:
        if row.get("user") != username or row.get("sprache") != lang.lower():
            continue

        lesson_name = row.get("lexikon")
        word = row.get("wort")
        key = (lesson_name, word)
        current = existing_by_word.get(key)
        if current is None or _get_effective_ts(row) > _get_effective_ts(current):
            existing_by_word[key] = row

    merged = list(existing_by_word.values())
    merged_by_word = {(row.get("lexikon"), row.get("wort")): row for row in merged}

    for key, incoming in incoming_by_word.items():
        existing = merged_by_word.get(key)
        if existing is None:
            lesson_name, word = key
            new_row = {
                "user": username,
                "sprache": lang.lower(),
                "lexikon": lesson_name,
                "wort": word,
                "uebersetzung": incoming.get("uebersetzung"),
                "genus": incoming.get("genus", ""),
                "status": incoming.get("status", "neu"),
                "richtig": incoming.get("richtig", 0),
                "falsch": incoming.get("falsch", 0),
                "created_at": incoming.get("created_at"),
                "updated_at": incoming.get("updated_at"),
            }
            merged.append(new_row)
            merged_by_word[key] = new_row
            continue

        if _get_effective_ts(incoming) > _get_effective_ts(existing):
            existing.update({
                "status": incoming.get("status", existing.get("status")),
                "richtig": incoming.get("richtig", existing.get("richtig", 0)),
                "falsch": incoming.get("falsch", existing.get("falsch", 0)),
                "updated_at": incoming.get("updated_at", existing.get("updated_at")),
            })

    return merged
