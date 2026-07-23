from llm_client import ask_llm, summarize


def run_batch(prompts: list[str]) -> list[str]:
    return [ask_llm(p) for p in prompts]


def nightly_digest(docs: list[str]) -> str:
    parts = [summarize(d) for d in docs]
    return "\n".join(parts)
