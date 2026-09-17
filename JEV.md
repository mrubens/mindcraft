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

Jev cannot write that line. Instead `src/models/jev.js` reads the command list
mindcraft already declares, turns it into a closed choice question, asks Jev
which command to run and — only where the request is vague — what its arguments
should be, and formats the call itself:

```
mindcraft's commandList  →  choice question over ~30 command labels
world state in the prompt →  closed sets for the arguments
Jev                       →  { command: "!collectBlocks", block: "oak_log", amount: "a_few" }
code                      →  !collectBlocks("oak_log", 5)
```

The command and every argument come back typed and bounded, so the model
cannot name a command that does not exist or an item outside the offered set.
The malformed-call failure mode disappears by construction.

Exact values stay in code. `"collect 5 oak logs"` gets its `5` from a regex and
its `oak_log` from a whole-word match against the candidate set; Jev is
consulted only for what is genuinely a judgment — which command, and what a
vague request meant.

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
  Anything else whose parameter kind the adapter does not recognise is dropped
  the same way as a safety net.
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
`!lookAtPlayer` indefinitely. So every turn also asks a `satisfied` noul, and
above 0.6 the adapter replies `"Done."` with no command.

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
scrolls out of the window mid-task. The adapter remembers the last request and
who made it until it replies without a command, which is what ends a task.

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
| block (`BlockName`) | nearby blocks + common materials | whole word or phrase, singular or plural, aliases ("wood") | Jev's `block` choice |
| item (`ItemName`, `BlockOrItemName`) | inventory + common items | same | Jev's `item` choice |
| entity (`!attack`, `!searchForEntity`) | creatures actually nearby | same | the only one, else Jev's `entity` choice |
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

With ~30 commands on offer, probability spreads thin, and a top pick of 0.16 is
close to a coin flip between several options. Below a floor the adapter declines
rather than running the top of a flat distribution, replying without a command
so mindcraft's loop stops and the bot stands still.

The bar rises with consequence:

| Kind | Floor | Rationale |
| --- | --- | --- |
| Query (`!inventory`, `!stats`) | 0.25 | Read-only; answering wrongly costs nothing |
| Action (`!collectBlocks`, `!goToPlayer`) | 0.40 | Changes the world, but recoverable |
| Consequential (`!digDown`, `!attack`, `!discard`) | 0.60 | Hard or slow to undo |

Replayed against every decision logged from early live sessions, this declined
5 of 52 — the `!collectBlocks` at 0.16 behind the aimless collecting and two
`!lookAtPlayer` at 0.20 and 0.32 — while leaving all 47 correct decisions
untouched, including every `!goToPlayer` (0.70-0.99).

These values are calibrated on a small sample and are a starting point, not a
result. They live in `FLOOR` in `src/models/jev.js`.

## Debugging what the model sees

Set `JEV_DUMP` to a file path and the adapter appends the exact `systemMessage`
and `turns` it receives for every call carrying a real player message, as JSON
lines:

```bash
JEV_DUMP=/tmp/jevprompt.json node main.js
```

## Changes to mindcraft itself

Deliberately small; the adapter is additive.

- **`src/models/jev.js`** (new) — the adapter. Registers itself through the
  existing `static prefix` discovery in `_model_map.js`; no core wiring needed.
- **`src/models/typesafe_client.js`** (new) — a dependency-free client for
  `POST /v1/systemone`.
- **`profiles/jev.json`** (new) — the profile.
- **`src/agent/vision/vision_interpreter.js`** — imports `camera.js` lazily,
  and only when `allow_vision` is on. `camera.js` pulls in `node-canvas-webgl`,
  a native module that some installs cannot load (`ERR_INTERNAL_ASSERTION` from
  the ESM loader on one machine here); with vision off, which is the default,
  it is now never imported, so a broken native build cannot take the agent
  down at startup. Bots with vision on behave exactly as before.
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

These numbers predate the argument-resolution changes above (which fixed, among
others, `!digDown` ignoring the typed distance and `!lookAtPlayer` being given
a number for its direction) and should be re-measured.
