# UI design — WorkRoom desktop

The per-project UI guide the flow asks for (`card-eval.md` reads this before a
frontend PLAN). It records the patterns the desktop client is built from, so a
new surface is drawn the way the existing ones are — and so a review can say
"off-pattern" and mean something specific.

Reading material: `references/buzz/desktop` is the UX reference (Slack-like
shell, harness-onboarding). We take its *patterns*, not its stack — our client
is plain TypeScript with one hand-written stylesheet, and stays that way.

## Constraints the patterns live inside

- No framework, no component library, no CSS preprocessor. `desktop/src/*.ts`
  builds DOM directly; `desktop/src/styles.css` is the only stylesheet, ~260
  lines, and should stay readable in one sitting.
- One dark theme, via custom properties at `:root` (`--bg`, `--panel`,
  `--line`, `--text`, `--muted`, `--accent` orange, `--agent` blue). New
  colors are new tokens, not literals.
- House comment style applies to CSS too: a comment says *why* the rule is
  what it is, not what it does.

## The shell

`#app` is a four-column grid with **explicit** `grid-column` placement
(`#rail` 1, `#sidebar` 2, `main` 3, aux panels 4). Explicit, because a hidden
child generates no box and unplaced children slide into the wrong column —
`main` once rendered 260px wide because of exactly that.

- **Workspace rail** (`#rail`): rooms this client has a way into, one initial
  per room. Hidden while there is one room — *a picker with a single option
  is a control that does nothing*, and that rule repeats everywhere.
- **Sidebar**: section heads (small, uppercase, muted) over the channel list;
  the person and the way into their agents in the footer. Management errands
  (agents, invite, join) are dialogs, not permanent fixtures.
- **Aux panels** (`#thread`, `#memory`): beside the room, never nested in it.

## Messages

A message is a Slack row: 36px avatar left, a head line (name, `AGENT` badge
for an agent, time), body under it. Attribution is part of the pattern —
"Alice's agent", never a second Alice.

Everything that is *process* rather than *said* — steps, plans, offers,
artifacts, presence — indents to the body column (46px), never to the window
edge.

## Dialogs

Every dialog is the same shape, enforced at the element level
(`dialog input, dialog select, dialog menu` in `styles.css`):

- a column of labelled rows;
- fields dark and filling the row — a field that keeps its native face (the
  white `<select>` in Invite) reads as broken against the dark panel;
- actions right-aligned in the `menu`, one of them primary.

## Onboarding

Two questions, two steps: what the machine has (harness cards with
Install/Start and the exact install command shown before it runs), then which
of the ready ones is the default. Zero ready is not a lock — finishing early
is how somebody comes back with one installed. The states on the cards are
the agents panel's own inputs, so the two surfaces cannot disagree.

## Verification — look before you ship

`bin/preview` exists because weeks of this client were tested and unseen, and
the first look found two defects no test could reach (#65, #66). So: a UI
change is not done until its screenshots have been *seen*.

States worth shooting on any layout-affecting change: `signed-out`, `room`,
`memory`, `thread` — plus any dialog or overlay the change touches (open it
via the preview bridge's `show` hook or a click in the staged page).

The render is driven over CDP (`desktop/preview/shoot.mjs`), not CLI flags:
"ready" is the DOM containing what the state is meant to show, in real
seconds. That is what made the pictures deterministic on macOS, where
branded Chrome neither exits headless nor pauses `--virtual-time-budget`
for fetch().
