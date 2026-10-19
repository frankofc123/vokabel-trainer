WITH ranked AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY "user", sprache, lexikon, wort
            ORDER BY
                GREATEST(
                    COALESCE(updated_at, '-infinity'::timestamptz),
                    COALESCE(created_at, '-infinity'::timestamptz)
                ) DESC,
                updated_at DESC NULLS LAST,
                created_at DESC NULLS LAST,
                id DESC
        ) AS row_rank
    FROM public.vokabeln
)
DELETE FROM public.vokabeln AS vocab
USING ranked
WHERE vocab.id = ranked.id
  AND ranked.row_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS vokabeln_user_sprache_lexikon_wort_key
    ON public.vokabeln ("user", sprache, lexikon, wort);