"""OpenAI chat helper — pre-migration patterns."""

from openai import OpenAI

client = OpenAI()


def ask_llm(prompt: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=512,
    )
    text = response.choices[0].text
    return text or ""


def summarize(doc: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": f"Summarize: {doc}"}],
        max_tokens=256,
    )
    return response.choices[0].text


def already_migrated(prompt: str) -> str:
    # Partial migration — already uses new field name
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        max_completion_tokens=128,
    )
    return response.choices[0].message.content or ""
