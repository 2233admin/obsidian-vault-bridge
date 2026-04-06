---
name: vault-connect
description: >
  Bridge unrelated vault domains. Find structural analogues between different areas.
  The vault's link graph knows connections you haven't seen.
---

# /vault-connect [topic A] [topic B]

Find hidden connections between seemingly unrelated vault domains.

## Modes

- **Two topics given**: Find structural bridges between A and B.
- **One topic given**: Find the most surprising connections TO this topic from other domains.
- **No topic given**: Scan recent activity and find the highest-value cross-domain bridge.

## Steps

1. **Read `_CLAUDE.md`** at vault root for folder map.
2. **Read `index.md`** for vault topology.

3. **Map the domains** -- for each topic:
   - Search vault for all notes mentioning it (title, body, tags, links)
   - Identify the domain cluster (which folders, which projects, which time period)
   - Extract **structural properties**: is it a process? a framework? a failure mode? a trade-off?

4. **Find bridges** -- spawn **3 parallel bridge agents**:
   - **Structural agent**: Same abstract shape in different domains.
   - **Causal agent**: Does one domain's output feed another? Does a finding explain a failure?
   - **Temporal agent**: Things that happened simultaneously or in sequence.

5. **Present connections** ranked by surprise and utility:

   ```
   ## Connections Found

   ### 1. [Connection Name] (surprise: high/medium, utility: high/medium)
   **Domain A:** [concept] -- from [[note]]
   **Domain B:** [concept] -- from [[note]]
   **Bridge:** [what they share structurally]
   **Implication:** [what you can DO with this connection]
   ```

6. **If a connection is strong enough**: propose a synthesis note that explicitly links the domains.

7. **Append to log.md**: `## [YYYY-MM-DD] connect | [topic(s)] -- [N] bridges found`

## Rules

- **All output in the user's language** (from `_CLAUDE.md` Language section). Translate ALL template headings: "## 发现的联系", "**领域A：**", "**桥梁：**", "**启示：**" for Chinese users. Cross-language connections (e.g., a Chinese note bridging to an English note) are especially valuable -- flag them.
- **Surprise is the metric** -- "two related notes are related" is boring
- **Structural analogy, not surface similarity** -- shared words don't count. Shared SHAPES count.
- **Be honest about stretch** -- label genuine insights vs creative reaching
- **Cite specific notes** -- verifiable connections
- **Propose actions** -- a connection without an implication is trivia
