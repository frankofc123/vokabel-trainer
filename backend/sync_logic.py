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
    merged = []
    incoming_by_word = {}

    for lesson_name, vocabs in incoming_lessons.items():
        for vocab in vocabs or []:
            if not isinstance(vocab, dict) or "wort" not in vocab:
                continue
            incoming_by_word[(lesson_name, vocab["wort"])] = vocab

    for row in existing_rows:
        if row.get("user") != username or row.get("sprache") != lang.lower():
            continue

        lesson_name = row.get("lexikon")
        word = row.get("wort")
        incoming = incoming_by_word.get((lesson_name, word))

        if incoming is None:
            merged.append(row)
            continue

        existing_ts = _get_effective_ts(row)
        incoming_ts = _get_effective_ts(incoming)

        if incoming_ts > existing_ts:
            merged.append({
                **row,
                "status": incoming.get("status", row.get("status")),
                "richtig": incoming.get("richtig", row.get("richtig", 0)),
                "falsch": incoming.get("falsch", row.get("falsch", 0)),
                "updated_at": incoming.get("updated_at", row.get("updated_at")),
            })
        else:
            merged.append(row)

    # If an incoming word exists but wasn't present in existing rows, add it.
    for (lesson_name, word), incoming in incoming_by_word.items():
        if any(item.get("lexikon") == lesson_name and item.get("wort") == word for item in merged):
            continue
        merged.append({
            "user": username,
            "sprache": lang.lower(),
            "lexikon": lesson_name,
            "wort": incoming.get("wort"),
            "uebersetzung": incoming.get("uebersetzung"),
            "genus": incoming.get("genus", ""),
            "status": incoming.get("status", "neu"),
            "richtig": incoming.get("richtig", 0),
            "falsch": incoming.get("falsch", 0),
            "updated_at": incoming.get("updated_at"),
        })

    return merged
