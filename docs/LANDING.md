# LANDING.md

The design system of the marketing landing (`landing/`): type, color,
signature elements, and motion — what they are and why they are that way.

The landing is static HTML + one shared stylesheet (`landing/assets/style.css`)
and one shared font set (`landing/assets/fonts/`). No build step, no JS —
everything below is pure HTML/CSS on purpose.

Visual reference: notion.com/product. The landing copies its skeleton (flat
white canvas, black display type, blue action color, yellow highlight pill,
doodle faces in colored rings), not its content. Earlier directions — a
Pantone "Cloud Dancer / Take a Break / Glamour & Gleam" palette and a
LaunchDarkly-style dark hero — were tried and rejected; the palette
reference compiled during that exploration survives as
`tmp/pantone-palettes.html` (ephemeral, regenerate from Pantone if needed).

## Type

- **Font: Inter, self-hosted.** Notion's NotionInter is a proprietary fork
  of Inter; Inter itself is OFL, so we ship four weights in
  `landing/assets/fonts/` (Regular 400, Medium 500, SemiBold 600, Bold 700)
  via `@font-face` with `font-display: swap`. Stack:
  `Inter, -apple-system, …, sans-serif`.
- **Weights follow Notion: 600 for display, 500 for buttons and nav, 400
  for body.** Bold (700) survives only in spots that predate the system.
- **Scale** (tuned one notch calmer than Notion's own — their headings
  dwarfed our 16px body):
  - hero h1: `clamp(2.5rem, 9vw - 20px, 5.25rem)` (≤ 84px), 600,
    `text-wrap: balance`
  - section h2: `clamp(28px, 3.2vw, 40px)`, 600; `h2.oneliner` exists for
    headings whose pill makes them overflow (nowrap on desktop, wraps
    below 860px)
  - `.sub`: 18px; body/card/FAQ/steps/verdict/note/truth: 16px;
    tables and pricing: 15.5px; mocks stay dense at 13–14px.

## Color

```css
--paper / --paper-raised: #ffffff   /* flat white, the Notion canvas */
--ink:            #17202b           /* near-black text */
--accent:         #2383e2           /* Notion blue — buttons, links, tints */
--accent-hover:   #1a6fc7
--hl:             #ffe08f           /* highlight pill */
--hl-dot:         #f5b301           /* the dot inside it (hero only) */
--hero-bg:        #131b26           /* functional dark: mock heads, terminal,
                                       table heads, step numbers */
--good / --bad:   #999b85 / #c37c54 /* kept from the Pantone phase (Tea,
                                       Caramel) — markers only */
```

Face rings and logo letters share one six-color cycle (blue `#5b9bd5`,
red `#e2574c`, yellow `#f2c14e`, navy `#3e7cb1`, salmon `#efa28b`,
teal `#59b8a2`) — applied by `nth-child`, so adding an item extends the
sequence automatically.

## Signature elements

- **Highlight pill (`.hl`)** — the Notion move: key phrase on a soft
  yellow pill, black text inside. The dot (`.hl-dot`) appears only in the
  hero h1; section h2s use the bare pill around the word that carries the
  product's meaning (agents, remembers, structural, engineers, open
  source). Restraint is the point: one pill per heading, not every heading.
- **Doodle faces** — an inline SVG sprite per page (`f-h1…f-h4` people,
  `f-a1…f-a3` agents), ink strokes, no fill. Used at 32px in mocks, 46px
  in the hero parade. Agents are robots (antenna, visor, bolt ears);
  people are round heads. In mocks each agent keeps its own face (Claude /
  Kimi / Codex), and the yellow `.badge` marks agent authorship — mirroring
  the product's attribution rule (agent messages belong to the run).
- **Hero face parade** — alternating person/agent faces in white circles
  with colored rings, each slightly rotated (`--r`) so the row feels
  hand-placed. The note reads "a person and their agent" — every seat is
  both, not either.
- **Rainbow logo** — `Work` in ink, each letter of `Room` in a ring
  color (`nav .brand .rm i`).
- **Proof band** — the agents WorkRoom works with, styled like a
  customer-logo strip; our honest substitute for one.
- **Scenario cards with mini-mocks** — show the product working instead of
  describing it; the big `#product` mock is the canonical example.
- **Trust section** — "Trust is structural, not promised": guarantees that
  are facts of the architecture (local execution, run logging, URL
  scoping, RLS, exportability), not policy statements.

## Page structure

`index.html` — hero (pill, parade) → proof band → use-case chips →
scenarios → product mock → Record/Remember/Reuse (steps + terminal) →
memory & skills (memlist + cards) → trust → fit → roles → open source →
pricing → FAQ → final CTA.

`for-*.html` — one page per role (sales, meetings, HR, legal, marketing,
support, engineering, finance, product, operations), same hero pattern.
`vs-*.html` — comparisons (Slack, Buzz, OpenWork, qm, standalone agents),
`table.compare` + `.verdict` layout, `hero.versus`.

## Motion

Rules (from the installed design-engineering skills, `.agents/skills/`):
transform/opacity only; custom ease tokens (`--ease-out`, `--ease-in-out`,
`--ease-pop`); stagger 30–80ms; hover motion gated behind
`@media (hover: hover) and (pointer: fine)`; UI durations ≤ 300ms,
marketing entrances may run longer; `prefers-reduced-motion` removes
movement and looping but keeps a plain fade.

Key moments: hero entrance cascade (560ms, 70ms stagger); faces pop with
overshoot then bob gently (the bob is on the inner SVG so hover on the
circle still wins); scroll reveals via `animation-timeline: view()` behind
`@supports` — unsupported browsers simply render, nothing is ever hidden;
agent run-lines and memory entries cascade in the product mock
(explanation, not garnish); FAQ uses `::details-content` height
transitions behind `@supports`; buttons/chips press to `scale(0.97)`.

## Working on the landing

- Verify visually. Headless Chrome screenshots (with
  `--virtual-time-budget` so animations settle) are the review tool; a UI
  change is not done until its screenshot has been seen.
- One stylesheet for all 16 pages — token changes propagate everywhere,
  so check `index`, one `for-*`, and one `vs-*` page after touching
  `:root`, `nav`, `.hero`, or `.btn`.
- Keep the no-JS rule. If a behavior seems to need JS, find the CSS way
  (`@supports`, `view()`, `::details-content`) or drop it.
- The `.claude/prompts/ui-design.md` guide covers the *desktop* UI; this
  file is the landing's equivalent.
