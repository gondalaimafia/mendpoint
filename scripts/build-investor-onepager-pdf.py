"""Generate docs/INVESTOR_ONE_PAGER.pdf — single page investor brief."""
from __future__ import annotations

from pathlib import Path

from fpdf import FPDF

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "INVESTOR_ONE_PAGER.pdf"


class OnePager(FPDF):
    def footer(self) -> None:
        self.set_y(-8)
        self.set_font("Helvetica", "I", 7)
        self.set_text_color(100, 100, 110)
        self.cell(
            0,
            4,
            "Mendpoint / Warden  |  Evidence-backed  |  Human review on every customer PR  |  docs/INVESTOR_ONE_PAGER.md",
            align="C",
        )


def ascii(text: str) -> str:
    repl = {
        "\u2014": "-",
        "\u2013": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2022": "-",
        "\u2026": "...",
        "\u2265": ">=",
        "\u2192": "->",
        "\u00b7": "|",
    }
    for a, b in repl.items():
        text = text.replace(a, b)
    return text.encode("latin-1", errors="replace").decode("latin-1")


def reset_x(pdf: OnePager) -> None:
    pdf.set_x(pdf.l_margin)


def h(pdf: OnePager, text: str, size: int = 10) -> None:
    reset_x(pdf)
    pdf.set_font("Helvetica", "B", size)
    pdf.set_text_color(20, 24, 40)
    pdf.cell(0, 5, ascii(text), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(0.3)


def p(pdf: OnePager, text: str, size: int = 8) -> None:
    reset_x(pdf)
    pdf.set_font("Helvetica", "", size)
    pdf.set_text_color(35, 38, 48)
    pdf.multi_cell(pdf.epw, 3.4, ascii(text))
    pdf.ln(0.6)


def bullet(pdf: OnePager, text: str) -> None:
    reset_x(pdf)
    pdf.set_font("Helvetica", "", 7.5)
    pdf.set_text_color(35, 38, 48)
    pdf.multi_cell(pdf.epw, 3.3, ascii(f"- {text}"))


def main() -> None:
    pdf = OnePager(orientation="P", unit="mm", format="Letter")
    pdf.set_auto_page_break(auto=True, margin=10)
    pdf.set_margins(12, 10, 12)
    pdf.add_page()

    # Header bar
    pdf.set_fill_color(18, 22, 36)
    pdf.rect(0, 0, 216, 22, "F")
    pdf.set_xy(12, 6)
    pdf.set_font("Helvetica", "B", 16)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(0, 6, "MENDPOINT", new_x="LMARGIN", new_y="NEXT")
    pdf.set_x(12)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(180, 190, 210)
    pdf.cell(
        0,
        5,
        "Investor one-pager  |  Warden product  |  Open-source monorepo  |  July 2026",
        new_x="LMARGIN",
        new_y="NEXT",
    )
    pdf.ln(4)

    pdf.set_text_color(35, 38, 48)
    pdf.set_font("Helvetica", "I", 8)
    pdf.multi_cell(
        0,
        3.6,
        ascii(
            "Warden is Mendpoint's API integration teammate: graph engineering (specialized verify-backed nodes, "
            "not one mega-agent), reviewable migration PRs, and an on-demand API debug loop. "
            "Never auto-merges by default.  github.com/gondalaimafia/mendpoint  |  MIT"
        ),
    )
    pdf.ln(2)

    h(pdf, "The problem")
    p(
        pdf,
        "Modern software is a mesh of external APIs. Breaking changes, silent field renames, and SDK drift ship "
        "constantly. Changelogs go unread; teams discover breakage in production incidents, not pull requests. "
        "General coding agents are not built to track vendor change, map blast radius through real call graphs, "
        "or ship review-first migration PRs.",
    )

    h(pdf, "The company")
    p(
        pdf,
        "Mendpoint is an applied AI company for legacy and integration code migration—Cognition-style "
        "(reasoning + agentic systems + FDE delivery), focused on keeping codebases correct as the APIs they "
        "depend on keep changing. Warden is the first product.",
    )

    h(pdf, "What we have shipped (evidence, not pitch)")
    bullets = [
        "End-to-end loop: OpenAPI change → impactable surfaces → hybrid index/candidates → call-graph expand → confirm → multi-file PR (migrate + adopt).",
        "GitHub delivery: mock + real Octokit + GitHub App install/runtime path.",
        "Trust: never auto-merge by default (env hard-gate), path denylist, audit export, severity tiers, notification-only mode.",
        "Graph engineering orchestrator: change intel → expand (fan-out) → generate → verify → human review; domain call/e/product graphs.",
        "Warden agent: on-demand API debug tool-loop; multi-category failure training; internal warden-bench 5/5.",
        "Quality bars: TS/Python/Go/Java/Ruby harnesses; design-partner fixture eval ≥70%; vendor examples (Stripe, OpenAI, AWS, …).",
        "Pre-customer surfaces: exposure report API, flagship OpenAPI fixtures (Stripe/OpenAI/Twilio/AWS/Plaid), changelog parser, Slack notify, brand packs, dual dashboards + /graph.",
        "Open source monorepo (MIT) for diligence—20+ packages; reproducible demo: npm test && npm run demo && npm run eval:warden.",
    ]
    for b in bullets:
        bullet(pdf, b)
    pdf.ln(1.5)

    h(pdf, "Why investable now")
    for b in [
        "Narrow wedge, chronic pain: API change → customer code (expanding with AI-driven API sprawl).",
        "Differentiated system, not a chat wrapper: graph impact + graph-engineered agents + policy/trust.",
        "Shipped depth for diligence: multi-language bars, GitHub App path, agents, open repo.",
        "FDE-fit GTM: fintech, AI infra, developer tools—white-glove first, then productize.",
        "Neutral multi-vendor platform; provider-branded packs as a later channel.",
    ]:
        bullet(pdf, b)
    pdf.ln(1.5)

    h(pdf, "Traction stage (honest)")
    p(
        pdf,
        "Past pitch deck: yes—runnable E2E product.  Design partners: path ready (App/token).  "
        "Continuous multi-vendor watch at scale: partial (OpenAPI poll + fixtures).  "
        "Public competitive API-SWE-bench: internal only.  Enterprise SSO/SOC2/multi-SCM: deferred.",
    )

    h(pdf, "Near-term use of capital")
    p(
        pdf,
        "Live flagship feeds · 3–5 design partners · expand internal API-regression bench · "
        "multi-service monorepo PR orchestration · cloud sandbox workers · FDE capacity for high-API-density teams.",
    )

    h(pdf, "Ask / diligence")
    p(
        pdf,
        "Clone the repo. Run: npm install && npm test && npm run demo && npm run eval:warden.  "
        "Claims policy: only what the monorepo can show (docs/WARDEN_CLAIMS.md).  "
        "Contact: Mendpoint team · Product: Warden on Mendpoint.",
    )

    pdf.output(OUT)
    print(OUT)


if __name__ == "__main__":
    main()
