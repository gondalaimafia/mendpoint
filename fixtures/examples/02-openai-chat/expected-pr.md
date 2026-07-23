## mendpoint: migrate OpenAI — breaking

### Changes applied
- `max_tokens=` → `max_completion_tokens=` at all legacy call sites
- `choices[0].text` → `choices[0].message.content`
- Shared helper `ask_llm()` updated (callers inherit fix)
- Sites already on `max_completion_tokens` left alone with a note
