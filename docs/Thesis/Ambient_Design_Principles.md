# Ambient design principles

Six principles, each with the file that implements it. The point of the pairing
is that the argument in [Letting_Go.md](./Letting_Go.md) should be checkable: if
a principle has no code behind it, it is a slogan.

Read this alongside the architectural invariants in the root
[README](../../README.md) and the XR module's own
[README](../../src/scene/xr/README.md). Those govern *how* things are built.
These govern *what the system is allowed to feel like*.

---

## 1. The set never talks back — it changes

There is no text-to-speech in Sikat and there will not be any.

A voice replying keeps you in the posture of addressing a machine and waiting to
be told. A room that changes is a room that understood: the acknowledgement and
the outcome are the same event, so there is nothing left to take on faith.

The system's whole non-verbal vocabulary is synthesised — oscillators and
filtered noise, no files and no voices — so that "it responded" and "it spoke"
never collapse into the same thing.

**Implemented by:** [`src/director/sound.ts`](../../src/director/sound.ts) ·
[`src/scene/xr/ambient-channel.ts`](../../src/scene/xr/ambient-channel.ts)

**History:** removed deliberately, not merely never added — the synthesised voice
bled into the director's own microphone and poisoned the input loop
([Roadmap, Phase 1](../DirectorAI/02_Project_Management/Roadmap.md)).

**The hard case:** confirming *failure* without words. Sikat grades it rather
than absolutising it — one miss is a warm pulse on the object you were pointing
at, a second consecutive miss brings the crew's own redirect up as text. The
ambient channel gets first refusal, not a monopoly. A principle that leaves the
user stuck is a bug.

---

## 2. Attention travels before action

The set shows what it is about to touch while there is still time to speak.

When a command names an object, that object lights up *before* the change lands
— on the utterance for a pointed command, on the first crew packet otherwise.
When the parse is still in flight, a translucent silhouette stands where the
outcome would be. Both exist so that being misunderstood is survivable: you see
the wrong target light up, and you correct it before anything happens.

This is the cheapest trust affordance in the system and the one that does the
most work. An autonomous act you can see coming is a different experience from
the same act arriving finished.

**Implemented by:**
[`src/scene/xr/attention-field.ts`](../../src/scene/xr/attention-field.ts) ·
[`src/director/ghost-preview.ts`](../../src/director/ghost-preview.ts) ·
[`src/scene/xr/aim-picker.ts`](../../src/scene/xr/aim-picker.ts)

---

## 3. The room is the interface, not the card

Status belongs at the scale of the space, not on a panel in your hand.

Whether the set can hear you is the single most important thing it can tell you,
and it used to be a 3mm dot with a row of level bars, floating under your wrist.
It is now the stage ring: it warms when you hold to talk and breathes with your
actual voice level, and a bright arc travels its circumference while the crew
works. You perceive it without looking at it, which is the entire difference
between an ambient indicator and a heads-up display.

The card survives, demoted, for what the world genuinely cannot say: a blocked
microphone, a dropped link, a missing controller, the first-run coach lines. In
ambient mode it fades to nothing and stops repainting entirely.

**Implemented by:**
[`src/scene/xr/room-response.ts`](../../src/scene/xr/room-response.ts) ·
[`src/scene/xr/director-slate.ts`](../../src/scene/xr/director-slate.ts) ·
[`src/scene/xr/ambient-channel.ts`](../../src/scene/xr/ambient-channel.ts)

**Corollary:** routing policy lives in exactly one module. "Slate as fallback" is
the kind of rule that decays back into "slate for everything" one call site at a
time unless something owns it.

---

## 4. Proposals dissolve; only acceptance commits

The crew notices things unprompted and offers fixes. An offer appears as a
breathing ghost of what it would do, standing where the change would land. Say
"do it" and it becomes real. Say nothing and it dissolves.

There is deliberately **no dismiss gesture**. Declining should not cost anything
— ignoring the offer *is* declining. That single interaction is the thesis in
miniature: the system acts on its own initiative, and the cost of it being wrong
is that you did nothing.

Timing is part of the principle, not an optimisation. A proposal only surfaces
when the director is settled and not mid-command; a badly-timed offer stays
silent entirely rather than falling back to text, since falling back to text
would be exactly the interruption the gate exists to prevent. The suggestion
stays live either way, so acceptance still works whenever they come up for air.

**Implemented by:**
[`src/director/proposal-ghost.ts`](../../src/director/proposal-ghost.ts) ·
[`src/scene/xr/ambient-sense.ts`](../../src/scene/xr/ambient-sense.ts) ·
[`server/app/suggestion_gate.py`](../../server/app/suggestion_gate.py)

---

## 5. Every autonomous act is attributed and reversible

Autonomy is only tolerable when you can see who did it and take it back.

**Attribution.** Nothing proactive happens invisibly. Each crew member has a
colour, a station, and a cursor that flies to the object it is about to touch,
announces, works, and withdraws. When the crew proposes something, the room
briefly wears that member's colour, so an offer is attributable at a glance.

**Reversibility.** "Undo that" reverts the last command wholesale — a multi-packet
command, or a whole set build, is one undo unit. Proposals never auto-commit, so
the failure mode of an unwanted suggestion is a ghost that fades, not a change to
undo.

**Legibility.** The room shows when it can hear. Sound can be silenced and the
choice persists.

These three are the trust affordances the thesis argues are load-bearing:
*ability* is demonstrated by the change landing, *benevolence* by the offer
costing nothing to refuse, and *integrity* by the same act producing the same
visible consequence every time.

**Implemented by:**
[`src/scene/agent-cursors.ts`](../../src/scene/agent-cursors.ts) ·
[`src/director/presence.ts`](../../src/director/presence.ts) ·
[`src/director/undo.ts`](../../src/director/undo.ts)

---

## 6. Onboarding erases itself

Teaching is a debt the interface owes the user, and it should be paid off, not
refinanced.

Three lines teach the controls. Each disappears **forever** the moment the user
performs the action it teaches, and once all three are learned the coach never
returns. The pace adapts too: a director who is hesitating gets more time on each
line, and one who is moving with intent is let go after a single pass.

Confidence has to be *demonstrated* before the coach shortens itself — at the
first tracked frame nobody has hesitated, because nobody has done anything yet.
Reading a low hesitation score at t=0 and concluding "they're fine" is how you
abandon a beginner.

Across sessions the same instinct applies to the set itself, which is placed
where this particular director keeps putting it — blended toward the habit rather
than snapped to it, since a habit is evidence, not an instruction.

**Implemented by:**
[`src/scene/xr/xr-coach.ts`](../../src/scene/xr/xr-coach.ts) ·
[`src/scene/xr/director-profile.ts`](../../src/scene/xr/director-profile.ts) ·
[`src/scene/xr/stage-placement.ts`](../../src/scene/xr/stage-placement.ts)

---

## Applying these to new work

A checklist, in the order the questions actually bite:

1. **Can the change itself be the acknowledgement?** If yes, that is the whole
   answer. Do not also caption it.
2. **If not, can the room or the object carry it?** Colour, motion, an earcon, a
   haptic. Reach for text only after these fail.
3. **If it must be text, is it something the world genuinely cannot say?**
   Errors, link state, hardware problems, and words a person wrote are the list.
   It is short on purpose.
4. **Does anything happen without a visible author?** Then it is not finished.
5. **Can the user undo it, or ignore it at zero cost?** If neither, it should not
   be autonomous yet.
6. **Does it interrupt?** Check whether this is a moment the director is mid-move.
7. **What does it cost per frame?** State draw calls and allocations. This runs at
   72Hz on a standalone headset, and an ambient layer that drops frames is not
   calm — it is broken.
