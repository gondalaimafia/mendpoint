"""Webhook handlers that call Acme Payments."""

import urllib.request
import json

ACME_BASE = "https://api.acme-payments.example"


def refund_hint(charge_id: str) -> dict:
    # Looks up charge then historically pulled receipt
    url = f"{ACME_BASE}/v1/charges/{charge_id}/receipt"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def create_charge(amount_cents: int, currency: str) -> dict:
    payload = json.dumps({"amount_cents": amount_cents, "currency": currency}).encode()
    req = urllib.request.Request(
        f"{ACME_BASE}/v1/charges",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))
