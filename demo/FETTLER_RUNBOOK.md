# Fettler — the first AI API Engineer: investor sizzle reel recording runbook

How to record the offline investor reel at `demo/fettler-reel.html`. It is a
single self-contained HTML file: fixed 1920x1080 stage scaled to the viewport,
seven auto-advancing scenes, a top progress bar, and keyboard controls. All CSS,
JavaScript, SVG icons, and the brand mark are inline; fonts are the system stack.
**Zero network requests.** The product names used throughout are **Fettler — the first AI API Engineer** and **Regauge — the first AI Legacy Engineer**.

---

## 1. Play it

Open the file directly — that is the whole setup:

```powershell
# Windows
Start-Process (Resolve-Path ".\demo\fettler-reel.html")
```

Or drag `fettler-reel.html` onto any modern browser (Chrome/Edge recommended for
a clean screen capture). No server, no build, no install.

- Fixed 1920x1080 (16:9) stage, scaled to the window. Full-screen the browser for
  a clean capture.
- Auto-advances over **120 seconds (2:00)** with a top progress bar and an
  `NN / 07` scene counter (top-right).
- Total is the sum of the seven scenes: **10 + 17 + 22 + 21 + 21 + 20 + 9 = 120s.**

## 2. Controls

| Key | Action |
| --- | --- |
| `F` | Toggle fullscreen (do this first for recording) |
| `Space` | Pause / resume (holds on the current frame) |
| `←` / `→` | Previous / next scene |
| `C` | Toggle captions on/off (turn **off** for a live voiceover take) |
| `R` | Restart from Scene 1 |
| `▶ Replay` | Button shown on the end frame |

## 3. Recording steps

1. Open the file, then press `F` to go fullscreen. Wait for the browser chrome to
   disappear before you start the capture.
2. If you are recording a live voiceover, press `C` to hide the on-screen captions
   so the frame is clean; leave them on for a captioned social cut.
3. Press `R` to reset to Scene 1, start your screen recorder, then let the reel
   play straight through once (120s). Do not touch the keyboard during the take —
   it auto-advances.
4. To redo a take, press `R` and start again. To hold on a specific frame (for a
   still or to line up narration), press `Space`.
5. The reel ends on the Fettler brand lockup with a `▶ Replay` button.

## 4. Confirm zero network requests (do this once before the real take)

The reel must fire no network requests when played offline.

1. Open `fettler-reel.html` in Chrome/Edge.
2. Open DevTools (`F12`) → **Network** tab.
3. Tick **Disable cache**, then hard-reload (`Ctrl+Shift+R`).
4. Let the reel play. The Network panel should show **only the document itself**
   (`fettler-reel.html`) and **no other requests** — no fonts, CDNs, images, XHR,
   fetch, or WebSocket entries. The `xmlns="http://www.w3.org/2000/svg"` strings
   in the file are XML namespace declarations, not URLs the browser fetches.
5. For extra certainty, disconnect from the network and reload — the reel renders
   and plays identically.

## 5. Reduced motion

If the recording machine has "reduce motion" enabled at the OS level, the reel
respects `prefers-reduced-motion`: fade-up entrances, the typing caret, the graph
edge-draw, and the card promote collapse into plain crossfades. Every scene still
reads. For the most dynamic capture, leave reduced motion **off**.

## 6. What each scene shows (quick reference)

| # | Scene | Speaker | On screen |
| --- | --- | --- | --- |
| 1 | The break | Talal | Problem hero; `source → payment_method` types in |
| 2 | Spec change | Ijlal | `/changes` — spec ingested, classified breaking, operation + field recorded |
| 3 | Change graph | Ijlal | Dependency path from the changed field to all five files |
| 4 | Draft PR | Ijlal | Narrow draft PR — request model, call site, fixtures; scope panel |
| 5 | Evidence record | Ijlal | Four-question review record + verification and human-judgment flag |
| 6 | Regauge | Talal | Migration recipes across families; production-capable code, live deployment status not verified |
| 7 | Close | Talal | Fettler-today / Regauge-next sequencing, then brand lockup |

Full shot list and verbatim voiceover: `demo/fettler-demo-script.md`.

## 7. Honesty rails baked into the reel (leave them visible)

These are on-screen on purpose; do not crop or edit them out.

- **"Illustrative scenario"** pill, fixed top-left on every data scene (2–6).
- Every pull request is a **draft requiring human review**; Fettler never merges.
- Regauge is labelled **"Production-capable code"** and **"Live status not
  verified"**. The reel uses illustrative repository names and does not claim a
  live deployment, repository connection, or executed verification result.
- No customer names, no live campaign counts, no merge-rate metrics anywhere.
