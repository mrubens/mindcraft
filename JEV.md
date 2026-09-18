# Running mindcraft on Jev

This fork adds TypeSafe's **Jev** as a mindcraft model provider. Jev is a
System One model: it returns typed judgments — a choice from a closed set, a
probability — and never generates text. That is the opposite of what mindcraft
normally asks a model to do, so the integration inverts the usual arrangement.

## How it differs from an LLM provider

Every other adapter asks an LLM to *write* a line and then regexes a command
out of whatever came back:

```
LLM → "Sure! I'll get that wood for you. !collectBlocks("oak_log", 10)"
      → regex → !collectBlocks("oak_log", 10)
```

Jev cannot write that line. Instead `src/models/jev.js` treats the decision as
a few small judgments over structured state, and formats the call itself:

```
world snapshot (JSON)        →  state: position, inventory, craftables, blocks and
                                creatures with distances, the task so far
mindcraft's command list     →  intent choice (move / gather / make / fight / items /
                                tell / stop / none) + a command choice per group
the request's vague words    →  block / item / creature / player / amount choices
Jev, one round trip          →  { intent: "gather", cmd_gather: "!collectBlocks",
                                  block: "oak_log", amount: "a_few" }
code                         →  !collectBlocks("oak_log", 5)
```

Everything Jev answers is a choice from a closed set or a probability, so the
model cannot name a command that does not exist or an item outside the offered
set. The malformed-call failure mode disappears by construction.

Exact values stay in code. `"collect 5 oak logs"` gets its `5` from a regex and
its `oak_log` from a whole-word match against the game's block registry; Jev is
consulted only for what is genuinely a judgment — what kind of thing is being
asked, which command within that kind, and what a vague word meant. Obtaining
an item is not judged at all: the model names the item, and code walks the
recipe graph to decide whether to collect, smelt or craft next.

## Setup

```bash
npm install
npx patch-package          # optional; some patches target older dep versions
```

Put your key in `keys.json` (gitignored):

```json
{ "TYPESAFE_API_KEY": "..." }
```

Then add `./profiles/jev.json` to `profiles` in `settings.js` and run
`node main.js`. The adapter refuses to start without a key, like the other
providers.

The profile overrides `conversing` with a prompt that carries only what the
adapter reads: the JSON world snapshot (`$WORLD_JSON`) and the command docs.
None of the prose an LLM would need is rendered, and none is sent to Jev.

**Node 20–22 is required.** Node 18 lacks the global `File` that undici needs;
Node 24 trips an internal ESM loader assertion in mindcraft's dependency mix.

## What Jev cannot do

These are consequences of the model being a judgment primitive, not gaps in
the adapter.

- **No conversation.** Jev writes no prose. The bot's replies are the command
  results mindcraft prints itself, plus `"Done."` when a request is complete.
  On mindcraft's bootstrap turn, and whenever nothing has been asked, the
  adapter replies with nothing and makes no API call.
- **No code generation, no free text.** Commands whose arguments are prose or
  a value the adapter has no closed set for are withheld. They are listed in
  `UNSUPPORTED` in `src/models/jev.js`: `!newAction`, `!goal`, `!endGoal`,
  `!startConversation`, `!searchWiki`, `!rememberHere`,
  `!goToRememberedPlace`, `!setMode`, `!useOn` and `!tradeWithVillager`.
  Anything else whose parameter kind the adapter does not recognise, or that
  belongs to no intent group, is dropped the same way as a safety net.
- **No memory summaries.** Mindcraft reuses the chat model to summarise
  history into memory and to decide whether to answer another bot mid-action.
  Neither can be answered with a command, so the adapter answers them in code:
  an empty memory, and `ignore`.
- **No embeddings.** The profile sets `"embedding": "none"`, so example
  selection falls back to word overlap.
- **No vision.** Jev cannot interpret images.

`!help` is also withheld, for a different reason: it is perfectly expressible,
but Jev reaches for it as a fallback whenever nothing else obviously applies,
and it clears the query floor every time because reading help is harmless.
Harmless but useless — a player who wants the command list can ask for it, and
leaving it on the menu only drains probability from commands that would do
something. It is listed in `SUPPRESSED` rather than `UNSUPPORTED` to keep the
two reasons distinct.

## Knowing when to stop

Mindcraft ends its loop when a reply contains no command. An adapter that
always emits one can never stop — the first version repeated
`!lookAtPlayer` indefinitely.

Completion is decided in code wherever code can check it, from the task ledger
(see below) and the world, before the model is asked anything: a `!stop` that
ran; a question answered by a query command; an `items` command that reported
no failure; a movement command that reported `You have reached`; a collect
whose `Collected N` outputs add up to the count the player typed (or, with no
count, one successful collect); an item the bot now holds enough of. Each
costs no API call.

Everything else falls to a `satisfied` noul asked alongside the intent; above
0.6 the adapter replies `"Done."` with no command.

## Finding the request

Mindcraft re-prompts after every action completes, so the most recent turn is
usually its own output — `"Action output: Collected 1 oak_log."` — rather than
anything a player said. Taking the last non-assistant turn as the request
therefore asked Jev to choose a command in reply to the bot's own transcript on
roughly half of all calls; one call had the entire COMMAND DOCS as the supposed
request. That produced exactly what you would expect: near-random picks at 0.16
confidence, collecting nobody asked for, and aimless digging.

The request is now the last turn that is actually a speaker: mindcraft's
history gives every speaker other than the bot the `user` role and formats the
content `Name: text`, and the adapter requires both. Requiring the role matters
because query results such as `INVENTORY: Nothing` and `NEARBY_BLOCKS: none`
are system turns that look exactly like a speaker line.

Action output is no longer mistaken for an instruction — everything after the
request goes into the state as `recent_events`, which is also what lets the
`satisfied` check see that a job is already done, or that pathfinding has
failed and the bot is stuck.

Mindcraft truncates history, so the turn carrying the request eventually
scrolls out of the window mid-task. The adapter keeps the task in code: who
asked, what they asked, the inventory when they asked, every command issued for
it and everything mindcraft reported back. While the request is still in the
window the ledger is rebuilt from history; once it has scrolled out, new turns
are appended. The ledger is what the completion checks read, and a trimmed
view of it goes to the model as `task`. It is cleared when the adapter replies
without a command, which is what ends a task.

## Naming a player

The closed set for a `player_name` argument was built from `NEARBY_ENTITIES`.
That is wrong for the same reason building materials from nearby blocks was
wrong: "come to me" is asked precisely when the bot is *not* beside you. Once it
wandered out of range the entity list read `none`, every command taking a
player_name was dropped as unformattable, and `!goToPlayer` could not be chosen
at the exact moment it was wanted. The bot picked the least-bad leftover —
`!searchForEntity("spruce_log", 64)` — and looped.

Whoever is speaking to the bot is now always a valid target, in sight or not,
and the option says which: *"talking to the bot but is not in sight — the bot
would have to travel to reach them."* A player the request names outright is
matched in code; with a single candidate no question is asked; only with two or
more players and no name in the request is Jev asked which one.

Note that mindcraft's own `!goToPlayer` resolves a live entity handle, which is
null beyond the bot's render distance — it answers `"Could not find <name>."`
however confidently the command was chosen. Reaching a player across the map is
a server `view-distance` question, not something the adapter can fix.

## Resolving arguments

Each parameter of each command is classified from mindcraft's own declaration
(`paramKind`), and each kind has a candidate set and a rule:

| Kind | Candidates | Exact lookup in the request | Otherwise |
| --- | --- | --- | --- |
| block (`BlockName`) | the full block registry for exact names; nearby blocks (with distance and count) + common materials for the model | whole word or phrase, singular or plural, aliases ("wood") | Jev's `block` choice |
| item (`ItemName`, `BlockOrItemName`) | the full item registry for exact names; inventory + craftable now + common items for the model | same | Jev's `item` choice |
| creature to attack | hostile or huntable creatures actually nearby | same | the only one, else Jev's `entity` choice |
| creature to search for (`!searchForEntity`) | common creature types + nearby | same | not offered unless the request names one |
| player | the speaker + players nearby | the name, whole word | the only one, else Jev's `player` choice, else the speaker |
| villager id (`!showVillagerTrades`) | ids from the entity list | the id | the only one, else Jev's `villager` choice |
| coordinates | — | a typed `x, y, z` triple | not offered at all |
| count | — | the first number | Jev's `amount` (one / a few / a lot → 1 / 4 / 32) |
| distance (`!digDown`, `!moveAway`) | — | the first number | 4 / 8 |
| seconds (`!stay`) | — | the first number | 30 |
| closeness, follow distance, search range | — | — | 1 / 3 / 64 |
| direction (`!lookAtPlayer`) | — | — | `"at"` |

Longer names win, so "dark oak logs" resolves to `dark_oak_log` rather than
`oak_log`, and matching is whole-word, so "sandstone" is not "stone". A
speculative argument question is asked only when some offered command needs
that kind and the world leaves more than one candidate; a command whose
argument still cannot be resolved is declined rather than guessed.

Commands whose candidate set is empty — `!attack` with nothing nearby,
`!goToCoordinates` with no coordinates typed — are not offered that turn, so
the model cannot pick them.

## Declining to act

The decision is two-stage: an intent over at most eight options, then a
command within the winning group. The intent needs 0.35 to act at all. The
command floor then applies to the group choice (or to the intent itself when
the group has a single command). Below a floor the adapter declines rather than
running the top of a flat distribution, replying without a command so
mindcraft's loop stops and the bot stands still.

The command bar rises with consequence:

| Kind | Floor | Rationale |
| --- | --- | --- |
| Query (`!inventory`, `!stats`) | 0.25 | Read-only; answering wrongly costs nothing |
| Action (`!collectBlocks`, `!goToPlayer`) | 0.40 | Changes the world, but recoverable |
| Consequential (`!digDown`, `!attack`, `!discard`) | 0.60 | Hard or slow to undo |

Replayed against every decision logged from early live sessions, this declined
5 of 52 — the `!collectBlocks` at 0.16 behind the aimless collecting and two
`!lookAtPlayer` at 0.20 and 0.32 — while leaving all 47 correct decisions
untouched, including every `!goToPlayer` (0.70-0.99).

These values were calibrated on a small sample under the earlier flat choice
and are a starting point, not a result. They live in `INTENT_FLOOR` and `FLOOR`
in `src/models/jev.js`; re-measure them with the replay script below.

## Debugging what the model sees

Set `JEV_DUMP` to a file path and the adapter appends the exact `systemMessage`
and `turns` it receives for every call carrying a real player message, as JSON
lines:

```bash
JEV_DUMP=/tmp/jevprompt.json node main.js
node src/models/jev_replay.js /tmp/jevprompt.json          # replay every decision
node src/models/jev_replay.js /tmp/jevprompt.json --grep wood --limit 5
```

The replay feeds the captured records through one adapter in order, so the
task ledger behaves as it does live, and prints each decision with its
confidences. Floors, group descriptions and the planner should be tuned
against a replay set, not against remembered sessions.

## Changes to mindcraft itself

Deliberately small; the adapter is additive.

- **`src/models/jev.js`** (new) — the adapter. Registers itself through the
  existing `static prefix` discovery in `_model_map.js`; no core wiring needed.
- **`src/models/typesafe_client.js`** (new) — a dependency-free client for
  `POST /v1/systemone`.
- **`src/models/jev_replay.js`** (new) — replays a `JEV_DUMP` capture.
- **`src/agent/library/world_snapshot.js`** (new) and **`src/models/prompter.js`**
  — a `$WORLD_JSON` placeholder that renders a structured snapshot of what the
  bot observes: position, health, hunger, biome, time, weather, current action,
  modes, inventory, equipment, craftable items, nearby block types with count
  and nearest distance, nearby creatures with count, distance and hostile or
  huntable flags, villagers by id, and nearby players with distance. Built
  from helpers mindcraft already had; only rendered when a prompt asks for it.
- **`profiles/jev.json`** (new) — the profile, with a `conversing` prompt that
  carries the snapshot and the command docs and nothing else.
- **`src/agent/vision/vision_interpreter.js`** — imports `camera.js` lazily,
  and only when `allow_vision` is on. `camera.js` pulls in `node-canvas-webgl`,
  a native module that some installs cannot load; with vision off, which is
  the default, it is now never imported, so a broken native build cannot take
  the agent down at startup. Bots with vision on behave exactly as before.
- **`settings.js`** — one commented line offering the Jev profile.

## Observed behaviour

Against a local 26.1 server, roughly 2,900 input tokens and 200–600 ms per
decision, with the first version of the adapter:

```
"Jev come to me"          -> !goToPlayer("Tester", 1)        conf 0.99
"Jev what are you holding" -> !inventory                      conf 0.98  -> satisfied 0.87
"Jev mine 3 stone"         -> !collectBlocks("stone", 3)      conf 0.93  -> satisfied 0.60
"Jev collect 5 oak logs"   -> !collectBlocks("oak_log", 5)    conf 0.63
"Jev stop"                 -> !stop                           conf 0.86  -> satisfied 0.93
```

Confidence reads lower than an LLM's certainty would: with dozens of command
labels, several plausible, probability spreads across them. It is a spread, not
confusion — the argument questions come back far sharper.

When nothing obviously applies it still falls back to a cheap read-only command
such as `!stats`, clearing the 0.25 query floor by a hair. That is the honest
shape of a flat distribution rather than a bug; raising the query floor to
around 0.35 would quieten it while still letting a real "what are you carrying?"
through at 0.98.

These numbers predate the structured snapshot, the intent decomposition, the
code-side completion checks and the planner, and should be re-measured with the
replay script. Expect intent confidence to read higher than the old flat
command confidence did, since it is spread over at most eight options rather
than thirty, and expect fewer model calls per task, since completion is mostly
decided in code.
