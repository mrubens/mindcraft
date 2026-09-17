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
which command to run and what its arguments should be, and formats the call
itself:

```
mindcraft's commandList  →  choice question over 42 command labels
world state in the prompt →  closed sets for the arguments
Jev                       →  { command: "!collectBlocks", thing: "oak_log", amount: "a_few" }
code                      →  !collectBlocks("oak_log", 5)
```

The command and every argument come back typed and bounded, so the model
cannot name a command that does not exist or an item outside the offered set.
The malformed-call failure mode disappears by construction.

Exact values stay in code. `"collect 5 oak logs"` gets its `5` from a regex and
its `oak_log` from an alias table; Jev is consulted only for what is genuinely
a judgment — which command, and what a vague request meant.

## Setup

```bash
npm install
npx patch-package          # optional; some patches target older dep versions
```

Put your key in `keys.json` (gitignored):

```json
{ "TYPESAFE_API_KEY": "..." }
```

Then point `settings.js` at `./profiles/jev.json` and run `node main.js`.

**Node 20–22 is required.** Node 18 lacks the global `File` that undici needs;
Node 24 trips an internal ESM loader assertion in mindcraft's dependency mix.

## What Jev cannot do

These are consequences of the model being a judgment primitive, not gaps in
the adapter.

- **No conversation.** Jev writes no prose. The bot's replies are the command
  results mindcraft prints itself, plus `"Done."` when a request is complete.
- **No code generation.** `!newAction` needs a natural-language prompt for the
  coder, so it is withheld along with `!goal`, `!startConversation`,
  `!searchWiki` and `!rememberHere` — six commands whose arguments are
  genuinely free text. Offering them would guarantee a malformed call. The
  other 42 are available. The list is `UNSUPPORTED` in `src/models/jev.js`.
- **No embeddings.** The profile sets `"embedding": "none"`, so example
  selection falls back to word overlap.
- **No vision.** Jev cannot interpret images.

## Knowing when to stop

Mindcraft ends its loop when a reply contains no command. An adapter that
always emits one can never stop — the first version repeated
`!lookAtPlayer` indefinitely. So every turn also asks a `satisfied` noul, and
above 0.6 the adapter replies `"Done."` with no command.

## Changes to mindcraft itself

Deliberately small; the adapter is additive.

- **`src/models/jev.js`** (new) — the adapter. Registers itself through the
  existing `static prefix` discovery in `_model_map.js`; no core wiring needed.
- **`src/models/typesafe_client.js`** (new) — a dependency-free client for
  `POST /v1/systemone`.
- **`profiles/jev.json`** (new) — the profile.
- **`src/agent/vision/camera.js`** — one import made lazy. `node-canvas-webgl`
  is a native CJS module that crashes Node's ESM loader on import
  (`ERR_INTERNAL_ASSERTION` on Node 20, 22 and 24 here), taking the whole agent
  process down at startup. This is unrelated to Jev — `agent.js` fails to load
  the same way with the adapter deleted. Since Jev has no vision capability
  anyway, the import now happens on demand and the screenshot path throws a
  clear error instead.

## Observed behaviour

Against a local 26.1 server, roughly 2,900 input tokens and 200–600 ms per
decision:

```
"Jev come to me"          -> !goToPlayer("Tester", 1)        conf 0.99
"Jev what are you holding" -> !inventory                      conf 0.98  -> satisfied 0.87
"Jev mine 3 stone"         -> !collectBlocks("stone", 3)      conf 0.93  -> satisfied 0.60
"Jev collect 5 oak logs"   -> !collectBlocks("oak_log", 5)    conf 0.63
"Jev stop"                 -> !stop                           conf 0.86  -> satisfied 0.93
```

Confidence reads lower than an LLM's certainty would: with 42 command labels,
several plausible, probability spreads across them. It is a spread, not
confusion — the argument questions come back far sharper.

Occasionally it picks a low-value command such as `!help` or `!craftable` at
0.4–0.65 when nothing obviously applies. That is the honest shape of the
distribution rather than a bug, but a confidence floor below which the adapter
declines to act would be a reasonable addition.
