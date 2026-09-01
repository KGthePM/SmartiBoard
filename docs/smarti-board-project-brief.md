# Smarti Board — Project Brief

*Last updated: August 28, 2026*

## One-line pitch

A web-based idea board that looks and feels like a whiteboard, where an AI actively co-authors the board with you — filling gaps, surfacing connections, and reorganizing ideas as you add them, instead of waiting to be asked.

## The core idea

Most "AI whiteboard" tools today are prompt-and-response: you ask for a diagram or summary, the AI generates a block, you accept or reject it. Smarti Board is meant to work differently — as a standing collaborator that's continuously reading the board and proposing structure, connections, and missing pieces in real time, while the user keeps full authorship and control over what actually gets kept.

The differentiator isn't the canvas. It's an AI that treats the board as a living document it's co-writing, not a static file it summarizes on request.

## Competitive landscape (as of August 2026)

"AI on a whiteboard" is no longer an empty category, so positioning matters:

- **Miro AI** and **FigJam AI** — cluster sticky notes, summarize boards, generate diagrams from a prompt.
- **Whimsical** — AI-assisted flowcharts and docs.
- **Canva AI Whiteboards** — AI-assisted visual brainstorming, shipped 2026.
- **Jeda.ai** — markets itself directly as a multi-model AI whiteboard.
- **tldraw "Make Real"** — experimental work turning sketches into real, working artifacts in real time; closest in spirit to the "AI actively builds with you" mechanic, though not productized as a mainstream tool.

None of these fully deliver a continuously-rewriting, always-slightly-ahead collaborator — most are still request/response. That gap is the wedge, but it also means the "AI silently editing my board" interaction pattern hasn't been solved elsewhere either, so UX trust design is the hard part, not the AI model itself.

## Non-negotiable design principle: function over flourish

Skeuomorphic touches (marker "cross-out" animations, chalk textures, hand-drawn wobble) are explicitly out of scope. They cost build time and add latency to the core loop of getting an idea onto the board, without differentiating the product. Every hour spent on decorative polish is an hour not spent on the AI behavior that's the actual product.

## Trust and control model

Because the AI is editing a workspace the user considers their own thinking, unclear authorship will break trust fast. The interaction model should keep three visually distinct layers on the same board at all times:

1. What the user placed.
2. What the AI is proposing — visually distinct (e.g. a "ghost" or muted state), non-destructive, never silently merged in.
3. What's been jointly accepted into the board.

Every AI proposal should be previewable and reversible in one action (accept / reject / tweak). No AI edit should be applied without this loop, even in later versions with more autonomy.

## "Learning as it goes" — two separate mechanisms

- **Within a session:** the AI builds a working model of *this specific board* — its entities, open questions, and structure — informing what it proposes next. Tractable now with a decent context window plus a structured (graph) representation of the board.
- **Across sessions / users:** durable personalization (layout preference, density, tone of suggestions) is a much bigger promise. Recommend deferring explicit long-term memory claims from v1 messaging — getting this wrong reads as unreliable or invasive; getting it right is a multi-quarter investment, not a launch feature.

## Target wedge (v1)

Pick one specific job rather than "creative thinking" broadly, so the fill-in behavior can be tuned well instead of trying to be smart about everything at once. Strong candidates:

- Early-stage strategy/product ideation (structuring a rough plan)
- Concept mapping for students/educators
- Outline development for writers

## MVP scope

**In scope:**
- Draggable, freeform text-based idea nodes on an infinite canvas
- One relationship type (simple connector / "grouped under")
- Instant autosave, no save button
- Exactly one AI behavior, executed well: propose a gap-fill or connection as a distinct "ghost" node; one-click accept/dismiss

**Explicitly out of scope for v1:**
- Real-time multiplayer / live collaboration
- Freehand drawing, images, hand-drawn styling
- Cross-session personalization / long-term memory
- Multiple AI behaviors or model choice

## Data model

Model the board as a **structured graph**, not a freeform drawing surface: nodes (idea text, type, position) and edges (relationships). This is the technical crux that makes the AI behavior feasible — an AI can reason about and propose changes to a graph of typed nodes far more reliably than it can reason about a bag of pixel coordinates on a literal canvas.

## Open source strategy

Originally built from a first-principles personal need ("I needed this thing myself") — worth leaning into as both a product strategy and a distribution story, not just a licensing choice.

**Why open source fits this specific product well:** the biggest UX risk identified above is trust — people need to believe the AI isn't silently mangling or exfiltrating their thinking. Open source (and especially self-hostable) directly addresses that in a way closed competitors structurally can't: users can audit what the AI layer does, and privacy-conscious users/teams can run it on their own infrastructure with their own LLM API key. "The transparent, self-hostable alternative to Miro AI" is a real, currently-uncontested positioning angle.

**Competitive check:** AFFiNE is the closest existing open-source Miro/Notion-style alternative (open-source, self-hostable, combines docs and whiteboard) but does not appear to have a live, continuous AI-fill-in/auto-organize behavior — the core differentiator here is still open ground even among open-source competitors.

**License choice (open decision):**
- **MIT/Apache-2.0** — maximizes adoption and contribution, but a larger, better-resourced company could take the code, host it, and out-compete on distribution without contributing back.
- **AGPL-3.0** — still open source, but requires anyone who runs a modified version as a network service to release their source too. Common choice for small teams who want the open-source trust/distribution benefits without enabling a big cloud player to clone-and-host for free. Likely the safer default for a small team.

**Business model implication:** the classic open-source pattern fits cleanly here — self-host for free (bring your own LLM API key), with a paid hosted/managed version for people who don't want to run their own infrastructure, plus optional paid tiers for heavier AI usage or team features. This is the same free-board/metered-AI shape noted in the Miro pricing comparison above, just with an added free self-hosted path that Miro doesn't offer at all.

**Tech stack implication:** this creates tension with the tldraw SDK recommendation below — tldraw's SDK is business-source licensed (source-available with restrictions), not truly open source. If "open source" is core to the positioning, Excalidraw (MIT) is the more consistent foundation for the canvas layer, even though it means more work to reach the same visual polish. Worth deciding this before writing the first line of canvas code, since switching later is expensive.

## Suggested tech stack

- **Canvas layer:** tldraw SDK (fast path to a polished infinite canvas, extensible with custom "idea node" shapes) or Excalidraw (fully MIT-licensed, more manual work for the same polish). tldraw is business-source licensed — free with a watermark below a revenue threshold, commercial license needed above it or to remove the watermark; worth confirming current terms before committing, but reasonable to treat as a later problem once the product is validated.
- **Frontend:** React on top of the chosen canvas SDK.
- **Backend:** thin API persisting board state as JSON (graph of nodes/edges); LLM calls for the AI suggestion behavior, streamed back so the UI never blocks on generation.
- **Real-time infra:** not needed for v1 — defer until/unless live multiplayer is in scope.

## Key risks

- **Trust erosion** if AI edits feel intrusive or unexplainable — mitigated by the ghost-layer / accept-reject model above.
- **Latency** — if board-wide inference blocks the canvas from responding instantly, it will feel slow compared to native whiteboard tools users already expect to be instant. Keep local interactions (drag, type, snap) fully separate from and unblocked by the AI's background reasoning.
- **Category crowding** — "AI whiteboard" is already a contested search term/positioning owned by larger players (Miro, FigJam, Canva). Lead marketing with the specific behavior ("a board that thinks with you"), not the category label.
- **Licensing** — confirm current tldraw SDK terms before committing to it as a dependency.

## Monetization (early thinking)

Freemium, capped on AI-assisted generations per board rather than seats (ideation tools spread virally via shared boards). Paid tier unlocks cross-session memory, higher-fidelity models, and team collaboration once those exist.

## Next steps

1. Decide open-source license (MIT/Apache vs. AGPL) — affects the canvas library choice below.
2. Decide tldraw vs. Excalidraw based on the license decision above and desired polish/speed tradeoff.
3. Confirm the wedge audience (strategy teams vs. students/educators vs. writers) to scope the first AI behavior concretely.
4. Build the narrow MVP vertical slice: canvas + text nodes + one AI ghost-node behavior.
5. User-test the trust/control interaction (ghost proposals, accept/reject) before adding any further AI behaviors.
6. If going the self-hosted route, decide whether v1 supports bring-your-own LLM API key from day one or starts with a single hosted default.
