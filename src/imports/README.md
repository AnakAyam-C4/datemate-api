# TikTok import pipeline

Turns a shared TikTok link into a saved place. Folders are numbered in the
order an import runs through them. Cheap steps first; each later step only
runs when the earlier ones couldn't find the place.

```
link ─▶ 1-tiktok ─▶ 2-caption ─┬─ name confirmed by #hashtag/@mention ──▶ 5-location ─▶ saved
                               └─ otherwise ─▶ 3-gemini ─┬─ venue found ─▶ 5-location
                                                         └─ not found ──▶ 4-video ─▶ 5-location
```

A TikTok location tag or a `📍` line is often only a street, mall or area, so
on its own it never decides the name: only a hashtag or @mention that spells
the same name is proof enough to skip Gemini. A street, mall or area is never
saved as the name — it becomes the address. When the caption does give a venue
name (next to the `📍` line), that name beats Gemini's: the model can drift onto
a series title or list hashtag, the location line can't. Gemini's name is only
used when the caption has no candidate of its own.

| Folder | What it does | Uses Gemini? | Costs |
|---|---|---|---|
| `1-tiktok/` | Turns the link into a video id, then reads the TikTok page: caption, creator, cover image, and TikTok's location tag (POI) if the creator added one | No | Free |
| `2-caption/` | Plain-code checks on the caption: `📍` / `lokasi:` lines and the name next to them, whether a tag/pin is a street, mall or area, ~44 known areas (BSD, PIK, Kemang…), prices like `25k`. Ported from the iOS app and proven identical to the Swift code | No | Free |
| `3-gemini/` | Unless a hashtag/@mention already confirms the name. Gemini reads the whole caption + cover image, picks the **venue** (never a street, mall or area) and returns **facts in English** (no summary — the phone writes that with Foundation Models). Every name must come with evidence or it's thrown away | Yes — Flash-Lite | 1 request |
| `4-video/` | Only if Gemini still found nothing. Downloads the video (size/length capped) so Gemini can read on-screen text and hear the voice-over | Yes — Flash | 1 request (~20/day free) |
| `5-location/` | Turns name + area into coordinates with free map services (Photon, Nominatim). Checks the result really is the place; otherwise falls back to the area, otherwise "no location" | No | Free |
| `shared/` | `config.ts` (all settings, from env vars), `vocabulary.ts` (categories, vibes, tags — same as Swift), `safeFetch.ts` (the only way this code touches the internet; blocks anything that isn't TikTok/allowed) | — | — |
| `tests/` | Offline tests. `npm test` runs them: no Gemini, no Firestore, no quota | — | Free |

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | AI Studio key. Without it, steps 3–4 are skipped |
| `GEMINI_TEXT_MODEL` | `gemini-3.1-flash-lite` | Model for step 3 |
| `GEMINI_VIDEO_MODEL` | `gemini-3.8-flash` | Model for step 4 |
| `GEMINI_NAME_CONFIDENCE` | `0.7` | Below this, a name is never used |
| `GEMINI_SKIP_WHEN_NAME_CONFIRMED` | `true` | Skip Gemini only when a hashtag/@mention confirms the tag or 📍 name |
| `VIDEO_ANALYSIS_ENABLED` | `true` | Turn step 4 off entirely |
| `VIDEO_MAX_SECONDS` / `VIDEO_MAX_BYTES` | `180` / 30 MB | Video caps |

## Not built yet

- The endpoint (`POST /v1/imports`) and the background job that runs these steps in order
- Saving to Firestore (`places/{id}`, `imports/{id}`, `placeCache/{videoId}`)
