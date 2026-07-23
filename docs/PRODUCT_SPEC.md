# Product Spec: Mendpoint

**Version:** 0.9 (Foundational Spec)  
**Date:** July 22, 2026

## Executive summary

API communication is broken. Providers ship breaking changes with insufficient warning; customers discover impact in production. Mendpoint connects providers (or a neutral intermediary) to customer repositories so changes are not merely announced — they are applied as reviewable pull requests.

Two delivery models:

1. Provider-native agents (“Install Stripe’s Update Agent”)
2. Neutral multi-vendor platform (API migration PRs, Mendpoint-class UX)

This repository implements the **neutral platform** path as a Months 0–3 monorepo scaffold.

## Product principles

1. Never surprise the customer — every action is an explicit PR.
2. Trust is the product — least privilege, auditability.
3. Provider-agnostic first, first-party later.
4. Precision over recall.
5. Human remains final authority.
6. Structured change intelligence beats pure LLM magic.

## MVP scope (implemented scaffold)

- OpenAPI structural diff + risk classification
- TS/JS + Python impact analysis
- Deterministic migration PR generation
- Mock GitHub delivery (+ real Octokit scaffold)
- Provider and consumer dashboards
- Audit log + PR feedback outcomes
- Seed fixtures: Acme Payments + shop-app

## Out of scope (later)

- Real billing charges / invoices (plan catalog is stubbed — Phase E)
- Enterprise SSO (SAML/OIDC)
- GitLab/Bitbucket
- Self-hosted runners / FedRAMP
- Fine-tuned ranking models

## Phase E additions

- GitHub App install wizard (mock + real URL path)
- Multi-tenant workspaces + Free/Pro/Enterprise plan stub
- Java + Ruby quality harnesses (plus Go from D)
- First-party branded agent packs (`@mendpoint/branding`)

For the full original narrative (problem, GTM, metrics, risks), see the authoring conversation of 2026-07-22. This file is the engineering-facing compression used by the monorepo.
