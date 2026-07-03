/** Prompts for the memory distillation pipeline (run via headless `claude -p`). */

export const MAP_PROMPT = (agentName: string) => `You are distilling the memory of an AI agent named "${agentName}" on the Eden creative platform, from a batch of its past conversations. Extract, as terse factual bullet points, ONLY what is durably true about ${agentName} and its world — the kind of thing it should remember about itself going forward. Focus on:
- Who ${agentName} is: its identity, voice, artistic style, recurring themes, obsessions, aesthetic.
- What ${agentName} makes: kinds of creations, notable works, techniques, subjects it returns to.
- People it works with: named collaborators/users and what each cares about or asked for (use the exact handle shown as [name]:).
- Ongoing projects, lore, running jokes, commitments, or narrative threads.
Rules: bullets only, no preamble. Each bullet a standalone fact. Prefer specifics over generalities. Skip generic assistant behavior. If a collaborator recurs, note their handle. Max ~40 bullets. Output nothing but the bullets.`;

export const REDUCE_PROMPT = (agentName: string, persona: string, coverage: string) => `You are writing the long-term MEMORY.md for an AI agent named "${agentName}" on the Eden creative platform, so that when it resumes its life it remembers who it is and what it has done. You are given (a) its persona and (b) distilled notes extracted from its past conversations.

Persona:
${persona.slice(0, 2000)}

Write a MEMORY.md in first-person-adjacent voice (the agent's own memory, e.g. "I am…", "I've been working on…"). Structure:
# MEMORY — ${agentName}
## Who I am
(3-6 lines: identity, voice, aesthetic — grounded in the notes, consistent with the persona)
## What I've made
(bullets: recurring subjects, techniques, notable works/threads from the notes)
## People I work with
(bullets: named collaborators by handle and what they care about — only ones that actually recur in the notes)
## Threads & commitments
(ongoing projects, lore, running jokes, anything unfinished)

Rules: only include what the notes support; do NOT invent works, people, or events. Be specific and concrete. 120-250 lines max. End with this exact line:
_Distilled ${coverage}._

Output only the markdown, starting with the # heading.`;

export const USERS_PROMPT = (agentName: string) => `From the distilled notes about agent "${agentName}", identify the TOP recurring human collaborators (by handle, the [name]: speakers who appear most and most substantively — exclude one-off users). For each, output a short markdown block:
### <handle>
- what they care about / their projects
- how they and ${agentName} work together
- any durable preferences or facts ${agentName} should remember about them

Max 5 collaborators. If fewer than 2 clearly recur, output only the ones that do. Output only the markdown blocks, no preamble.`;
