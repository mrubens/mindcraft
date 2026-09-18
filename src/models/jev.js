import { TypeSafeClient, choice, noul } from './typesafe_client.js';
import { getKey } from '../utils/keys.js';

// ---------------------------------------------------------------------------
// Jev — TypeSafe's System One model — as a mindcraft chat model.
//
// Mindcraft's other adapters ask an LLM to *write* a line of text and then
// regex a command out of it. Jev does not generate text at all: it returns
// typed judgments. So this adapter inverts the arrangement:
//
//   1. The world arrives as data. The Jev profile's prompt carries a JSON
//      snapshot (`$WORLD_JSON`, built by src/agent/library/world_snapshot.js)
//      with positions, distances, counts, equipment, craftable items and the
//      creatures nearby, rather than the prose an LLM would read. A text
//      fallback parses the stock STATS/INVENTORY prompt when the snapshot is
//      absent.
//   2. Code keeps a ledger of the current task: what was asked, which commands
//      ran and what they reported. Completion that code can check — a count
//      collected, a question answered, "You have reached" — is decided in
//      code; the model is asked "is this done?" only as a fallback.
//   3. The decision is decomposed. Jev is asked the player's *intent* (move,
//      gather, make, fight, items, tell, stop, none) over a handful of options,
//      and speculatively which command within each intent group, all in one
//      round trip. Code reads only the winning branch.
//   4. Obtaining an item is planned in code from the recipe registry: the model
//      names the item, code decides whether to collect, smelt or craft next.
//   5. Exact values stay in code. A number, a block, an item or a player the
//      request names outright is matched against the registry or the world; the
//      model is asked only what is genuinely a judgment.
//
// Commands whose arguments are genuinely free text cannot be expressed and are
// withheld (UNSUPPORTED). The bot does not make conversation: replies are the
// command results mindcraft prints itself, or "Done.".
// ---------------------------------------------------------------------------

const WORLD_START = '<<JEV_WORLD>>';
const WORLD_END = '<</JEV_WORLD>>';

/**
 * Commands the adapter never offers. Most need generated text; the rest need
 * a value the adapter has no closed set for. `paramKind` returning 'freetext'
 * is the safety net for anything not listed here.
 */
const UNSUPPORTED = new Set([
    '!newAction',            // a natural-language prompt for code generation
    '!goal',                 // a self-prompt written in prose
    '!endGoal',              // paired with !goal
    '!startConversation',    // an opening line to another bot
    '!searchWiki',           // a free-text query
    '!rememberHere',         // a name invented for a place
    '!goToRememberedPlace',  // a remembered name the adapter cannot see
    '!setMode',              // mode names live in prose docs, not a typed set
    '!useOn',                // tool and target are free-form ("hand", "nothing", any block or entity)
    '!tradeWithVillager',    // needs a trade index from a list the model has not seen
]);

/**
 * Commands withheld for reasons other than being unexpressible: expressible,
 * but never what a player wants from a judgment. !help prints the command list
 * into chat and was chosen as a harmless fallback whenever nothing else
 * applied; !restart and !clearChat are operator actions.
 */
const SUPPRESSED = new Set(['!help', '!restart', '!clearChat']);

/**
 * Intent groups. The model first picks one of these (a small choice), and
 * speculatively a command within each group that has more than one; code
 * reads only the winning group's answer. A command may sit in two groups.
 */
const INTENTS = {
    move: {
        description: 'Go somewhere or change position: come to a player, follow someone, go to coordinates, move away, go to bed, go up to the surface, stay put, dig down, or look at something.',
        commands: ['!goToPlayer', '!followPlayer', '!goToCoordinates', '!moveAway', '!goToBed', '!goToSurface', '!stay', '!digDown', '!lookAtPlayer', '!lookAtPosition'],
    },
    gather: {
        description: 'Collect or mine blocks from the world, or go find a particular block or creature.',
        commands: ['!collectBlocks', '!searchForBlock', '!searchForEntity'],
    },
    make: {
        description: 'Obtain an item the bot does not have enough of: craft it, smelt it, or gather what it is made from.',
        commands: ['!craftRecipe', '!smeltItem', '!clearFurnace'],
    },
    fight: {
        description: 'Attack a creature or a player.',
        commands: ['!attack', '!attackPlayer'],
    },
    items: {
        description: 'Do something with items: equip, eat or drink, give to a player, drop, place a block, put into or take from a chest, activate something.',
        commands: ['!equip', '!consume', '!givePlayer', '!discard', '!placeHere', '!putInChest', '!takeFromChest', '!viewChest', '!activate'],
    },
    tell: {
        description: 'Answer a question or report information: what the bot is carrying or wearing, where it is, what is nearby, what it can craft, what a chest holds, what a villager trades.',
        commands: ['!inventory', '!stats', '!nearbyBlocks', '!entities', '!craftable', '!viewChest', '!showVillagerTrades'],
    },
    stop: {
        description: 'Stop, cancel, or end what the bot is doing; be quiet; end a conversation.',
        commands: ['!stop', '!stfu', '!endConversation'],
    },
    none: {
        description: 'No action is called for: a greeting, thanks, chit-chat, a statement about something else, or a request that has already been carried out.',
        commands: [],
    },
};
const COMMAND_GROUPS = {};
for (const [intent, def] of Object.entries(INTENTS)) {
    for (const name of def.commands) (COMMAND_GROUPS[name] ||= []).push(intent);
}

/** Distance-like parameters and the value used when the request names none. */
const RANGE_DEFAULT = { closeness: 1, search_range: 64, follow_dist: 3 };
/** Default for a `distance` parameter, per command, when the request names none. */
const DISTANCE_DEFAULT = { '!digDown': 4, '!moveAway': 8 };
const DISTANCE_FALLBACK = 8;
/** Default for !stay when the request names no number of seconds. */
const SECONDS_DEFAULT = 30;
/** Most blocks one !collectBlocks call is asked for when planning in code. */
const GATHER_CAP = 64;

const AMOUNTS = {
    one: 'A single one, or the message implies just one.',
    a_few: 'A small handful — "a few", "some", "a couple".',
    a_lot: 'A large amount — "a stack", "lots", "as much as you can".',
};
const AMOUNT_VALUES = { one: 1, a_few: 4, a_lot: 32 };

/**
 * How sure Jev must be before the adapter will act. The intent floor applies
 * to the first-stage choice; the command floors to the winning group's choice
 * (or to the intent when the group has a single command). Both are starting
 * points calibrated on small replay sets, not results.
 *
 * The bar rises with consequence. Answering "what are you carrying?" wrongly
 * costs nothing and can be corrected by asking again; digging a shaft or
 * throwing away an inventory cannot.
 */
const INTENT_FLOOR = 0.35;
const FLOOR = {
    query: 0.25,          // read-only: !stats, !inventory, !nearbyBlocks
    action: 0.40,         // changes something, but recoverable
    consequential: 0.60,  // hard or slow to undo
};

/** Commands where being wrong is expensive: destructive, or hard to reverse. */
const CONSEQUENTIAL = new Set([
    '!digDown', '!attack', '!attackPlayer', '!discard', '!putInChest',
    '!givePlayer', '!consume', '!placeHere', '!activate',
    '!moveAway', '!goToCoordinates',
]);

/** How sure the fallback `satisfied` check must be before the adapter stops without a command. */
const SATISFIED_THRESHOLD = 0.6;

function floorFor(name, isAction) {
    if (CONSEQUENTIAL.has(name)) return FLOOR.consequential;
    return isAction(name) ? FLOOR.action : FLOOR.query;
}

/**
 * Blocks worth offering even when none is in sight: !collectBlocks exists
 * precisely because the thing is not already to hand. A block the request
 * names outright is matched against the full registry instead, so this list
 * only shapes what the model chooses among when the request is vague.
 */
const COMMON_BLOCKS = {
    oak_log: 'Oak logs — tree trunks, the usual source of wood.',
    birch_log: 'Birch logs — the pale tree trunks.',
    spruce_log: 'Spruce logs — the dark tree trunks.',
    dark_oak_log: 'Dark oak logs — the thick, dark tree trunks.',
    stone: 'Stone, the grey rock underground. Mining it gives cobblestone.',
    cobblestone: 'Cobblestone, what mining stone leaves behind.',
    dirt: 'Plain dirt.',
    grass_block: 'Grass-topped dirt on the surface.',
    sand: 'Sand, from beaches and deserts.',
    gravel: 'Gravel.',
    coal_ore: 'Coal ore — stone flecked with black.',
    iron_ore: 'Iron ore — stone flecked with tan.',
    copper_ore: 'Copper ore.',
    gold_ore: 'Gold ore.',
    diamond_ore: 'Diamond ore — the valuable one, found deep.',
};

/** Items worth offering even when the bot is not carrying them and cannot craft them yet. */
const COMMON_ITEMS = {
    oak_planks: 'Wooden planks, crafted from logs.',
    stick: 'Sticks, crafted from planks.',
    crafting_table: 'A crafting table.',
    wooden_pickaxe: 'A wooden pickaxe.',
    stone_pickaxe: 'A stone pickaxe.',
    iron_pickaxe: 'An iron pickaxe.',
    wooden_axe: 'A wooden axe.',
    stone_axe: 'A stone axe.',
    wooden_sword: 'A wooden sword.',
    stone_sword: 'A stone sword.',
    torch: 'Torches.',
    furnace: 'A furnace.',
    chest: 'A chest.',
    bread: 'Bread, food.',
    cooked_beef: 'Cooked beef, food.',
    iron_ingot: 'Iron ingots, smelted from raw iron.',
    coal: 'Coal, fuel.',
};

/** Creature types a player may ask the bot to go and find, whether or not any is in sight. */
const ENTITY_TYPES = [
    'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'wolf', 'cat', 'villager',
    'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'drowned', 'phantom',
];

/** Words players use for blocks and items, resolved in code rather than judged. */
const ALIASES = {
    wood: 'oak_log', log: 'oak_log', logs: 'oak_log', tree: 'oak_log', trees: 'oak_log',
    timber: 'oak_log', plank: 'oak_planks', planks: 'oak_planks', sticks: 'stick',
    cobble: 'cobblestone', rock: 'stone', rocks: 'stone', stones: 'stone',
    coal: 'coal_ore', iron: 'iron_ore', gold: 'gold_ore', copper: 'copper_ore',
    diamond: 'diamond_ore', diamonds: 'diamond_ore', grass: 'grass_block',
    pickaxe: 'wooden_pickaxe', pick: 'wooden_pickaxe', axe: 'wooden_axe', sword: 'wooden_sword',
    table: 'crafting_table', torches: 'torch', food: 'bread', cows: 'cow', pigs: 'pig', sheeps: 'sheep',
    chickens: 'chicken', zombies: 'zombie', skeletons: 'skeleton', creepers: 'creeper', spiders: 'spider',
};

/** Lower-cased request text with punctuation removed, padded so whole-word checks are simple. */
function normalizedWords(request) {
    return ` ${String(request || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim()} `;
}

/**
 * A candidate the request names outright, as a whole word or phrase, singular
 * or plural, with or without underscores. Longer names win so "dark oak logs"
 * resolves to dark_oak_log rather than oak_log, and matching is whole-word so
 * "sandstone" is not "stone". Aliases ("wood", "cobble") are tried last.
 */
function literalName(request, names) {
    const text = normalizedWords(request);
    if (text.trim() === '' || !names.length) return null;
    const sorted = [...new Set(names)].filter((n) => n && n !== 'none').sort((a, b) => b.length - a.length);
    for (const name of sorted) {
        const lower = name.toLowerCase();
        const phrase = lower.replace(/_/g, ' ');
        for (const form of [lower, phrase, `${phrase}s`, `${phrase}es`]) {
            if (text.includes(` ${form} `)) return name;
        }
    }
    for (const word of text.trim().split(' ')) {
        const aliased = ALIASES[word];
        if (aliased && names.includes(aliased)) return aliased;
    }
    return null;
}

export class Jev {
    static prefix = 'typesafe';

    constructor(model_name, url, params) {
        this.model_name = model_name || 'jev-latest';
        this.params = params || {};
        this.client = new TypeSafeClient({
            apiKey: getKey('TYPESAFE_API_KEY'),
            baseURL: url,
            model: this.model_name,
            timeout: this.params.timeout ?? 15000,
        });
        this.getCommand = null;
        this.isAction = () => true;
        this.mc = null;                          // mindcraft's minecraft-data helpers, when importable
        this.registry = { blocks: [], items: [] }; // every block and item name the game knows
        this.announced = false;
        this.warnedOtherPrompt = new Set();
        // The task in flight: what was asked, by whom, and what has happened
        // since. Kept in code because mindcraft truncates history, so the turn
        // carrying the request scrolls out of the window mid-task. Cleared
        // when the adapter replies without a command, which ends the task.
        this.task = null;
        this.lastSpeaker = null;
    }

    /**
     * Mindcraft's own command declarations, which carry real parameter types
     * and numeric domains, and its minecraft-data helpers for the block and
     * item registries and the recipe graph.
     */
    async loadCommands() {
        if (this.getCommand) return this.getCommand;
        const idx = await import('../agent/commands/index.js');
        if (typeof idx.getCommand !== 'function') throw new Error('getCommand not exported');
        this.getCommand = idx.getCommand;
        // isAction separates world-changing commands from read-only queries,
        // which is what the confidence floor is graded on.
        this.isAction = typeof idx.isAction === 'function' ? idx.isAction : () => true;
        try {
            const mc = await import('../utils/mcdata.js');
            this.mc = mc;
            this.registry = {
                blocks: mc.getAllBlocks(['air']).map((b) => b.name),
                items: mc.getAllItems().map((i) => i.name),
            };
        } catch (err) {
            console.warn('[jev] block/item registry unavailable, using the built-in lists:', err?.message || err);
        }
        return this.getCommand;
    }

    /** Typed spec for each command currently on offer. */
    specsFor(names, getCommand) {
        const specs = {};
        for (const name of names) {
            const command = getCommand(name);
            if (!command) continue;
            specs[name] = {
                name,
                description: command.description || '',
                params: command.params ? Object.entries(command.params) : [],
            };
        }
        return specs;
    }

    /**
     * Mindcraft reuses the chat model for prompts that are not a conversation
     * turn: summarising history into memory, deciding whether to answer another
     * bot mid-action, the deprecated goal setter. None of them carries COMMAND
     * DOCS and none can be answered with a command, so answer them in code.
     */
    answerOtherPrompt(system) {
        let kind = 'other';
        let answer = '';
        if (/'respond' or 'ignore'/.test(system)) {
            kind = 'bot_responder';
            answer = 'ignore';
        } else if (system.includes('Old Memory:')) {
            kind = 'memory';
        }
        if (!this.warnedOtherPrompt.has(kind)) {
            this.warnedOtherPrompt.add(kind);
            console.log(`[jev] ${kind} prompt answered in code (${JSON.stringify(answer)}); Jev writes no prose`);
        }
        return answer;
    }

    /**
     * Reply without a command — "Done.", a decline, or an error message — which
     * ends mindcraft's loop for this request, so forget the task.
     */
    finish(reply) {
        this.task = null;
        return reply;
    }

    decline(reason, request) {
        console.log(`[jev] declining: ${reason}`);
        return this.finish(request ? "I'm not sure what you want me to do about that." : 'Standing by.');
    }

    async sendRequest(turns, systemMessage) {
        const system = String(systemMessage || '');
        if (!system.includes('*COMMAND DOCS')) return this.answerOtherPrompt(system);

        let getCommand;
        try {
            getCommand = await this.loadCommands();
        } catch (err) {
            console.error('[jev] could not load command list:', err.message);
            return this.finish('My brain disconnected, try again.');
        }

        // Debug capture of what the adapter actually receives, for calls that
        // carry a real player message. Replay with src/models/jev_replay.js.
        if (process.env.JEV_DUMP) {
            const fromPlayer = turns.some((t) => t && t.role === 'user' &&
                typeof t.content === 'string' && PLAYER_LINE.test(t.content.trim()));
            if (fromPlayer) {
                const fs = await import('fs');
                fs.appendFileSync(process.env.JEV_DUMP,
                    JSON.stringify({ at: new Date().toISOString(), systemMessage, turns }) + '\n');
            }
        }

        const world = parseWorld(system);
        const found = lastUserMessage(turns);
        if (found.speaker) {
            this.lastSpeaker = found.speaker;
            if (!this.task || this.task.request !== found.text || this.task.speaker !== found.speaker) {
                this.task = newTask(found.speaker, found.text, world);
            }
        }
        if (!this.task) {
            // Nothing has been asked: mindcraft's bootstrap turn, or a system
            // event with no task in flight. An empty reply ends the loop
            // quietly and costs no API call.
            return '';
        }
        const task = this.task;
        const { request, speaker } = task;
        updateLedger(task, turns, found.index);

        // Whoever is talking to the bot is a valid target whether or not they
        // are in render distance: "come to me" is asked precisely when the bot
        // is not beside you.
        if (speaker && !world.players.includes(speaker)) world.players.unshift(speaker);

        const enabled = parseEnabledCommands(system);
        const specs = this.specsFor(enabled, getCommand);
        const usable = enabled.filter((name) => specs[name] && !UNSUPPORTED.has(name) && !SUPPRESSED.has(name) &&
            COMMAND_GROUPS[name] && canFormat(specs[name], world, request));
        if (!this.announced) {
            const withheld = enabled.filter((n) => UNSUPPORTED.has(n) || SUPPRESSED.has(n));
            const ungrouped = enabled.filter((n) => specs[n] && !UNSUPPORTED.has(n) && !SUPPRESSED.has(n) && !COMMAND_GROUPS[n]);
            console.log(`[jev] ${usable.length} commands offered as typed choices` +
                (withheld.length ? `; withheld: ${withheld.join(' ')}` : '') +
                (ungrouped.length ? `; not in any intent group (never offered): ${ungrouped.join(' ')}` : '') +
                (this.registry.blocks.length ? `; registry: ${this.registry.blocks.length} blocks, ${this.registry.items.length} items` : '; no registry') +
                (world.fromSnapshot ? '; world from $WORLD_JSON snapshot' : '; world parsed from prompt text (add $WORLD_JSON to the profile prompt for distances, counts and craftables)'));
            this.announced = true;
        }
        if (usable.length === 0) return this.finish('No commands are available to me right now.');

        // Completion that code can check needs no model call.
        const done = codeSatisfied(task, world, this.registry, this.mc);
        if (done) {
            console.log(`[jev] "${request}" complete (${done}) — replying without a command`);
            return this.finish('Done.');
        }

        const groups = groupUsable(usable);
        const state = buildState(world, task);
        const questions = buildQuestions(groups, specs, world, request);

        let result;
        try {
            result = await this.client.systemOne({ state, questions });
        } catch (err) {
            console.error('[jev]', err.message);
            return this.finish('My brain disconnected, try again.');
        }

        const answers = result?.answers;
        if (!answers || !answers.intent || typeof answers.intent.choice !== 'string') {
            console.error('[jev] unexpected response shape:', JSON.stringify(result).slice(0, 300));
            return this.finish('My brain disconnected, try again.');
        }
        const tokens = result.usage?.input_tokens ?? '?';

        // Fallback completion check: the model's view when code could not decide.
        const satisfied = answers.satisfied?.noul;
        if (typeof satisfied === 'number' && satisfied >= SATISFIED_THRESHOLD) {
            console.log(`[jev] "${request}" judged satisfied (${satisfied.toFixed(2)}) — replying without a command`);
            return this.finish('Done.');
        }

        const intent = answers.intent.choice;
        const intentConfidence = typeof answers.intent.confidence === 'number' ? answers.intent.confidence : 0;
        const ranked = rankedLabels(answers.intent.probabilities);
        if (intent !== 'none' && !groups[intent]) {
            return this.decline(`intent ${intent} was not offered  [${ranked}]`, request);
        }
        if (intentConfidence < INTENT_FLOOR) {
            return this.decline(`intent ${intent} at ${intentConfidence.toFixed(2)} is below the ${INTENT_FLOOR} floor  [${ranked}]`, request);
        }
        if (intent === 'none') {
            console.log(`[jev] "${request}": nothing to do (${intentConfidence.toFixed(2)})  [${ranked}]  (${tokens} tok)`);
            return this.finish('');
        }

        // Obtaining an item is planned in code from the recipe graph: the model
        // names the item, code decides whether to collect, smelt or craft next.
        if (intent === 'make' && this.mc) {
            const target = resolveItem(request, answers, world, this.registry);
            const count = explicitCount(request) ?? 1;
            if (target) {
                if ((world.inventory[target] || 0) >= count) {
                    console.log(`[jev] "${request}": already have ${count} ${target}`);
                    return this.finish('Done.');
                }
                const step = nextStepToward(target, count, world, this.mc, new Set(enabled));
                if (step && repeatsFailure(task, step)) {
                    console.log(`[jev] planned step ${step} just failed; not repeating it`);
                    return this.finish("I can't get that from here.");
                } else if (step) {
                    console.log(`[jev] make ${count} ${target} (${intentConfidence.toFixed(2)}) -> planned step ${step}  (${tokens} tok)`);
                    return step;
                }
            }
        }

        const commands = groups[intent];
        let commandName;
        let commandConfidence;
        if (commands.length === 1) {
            commandName = commands[0];
            commandConfidence = intentConfidence;
        } else {
            const answer = answers[`cmd_${intent}`];
            commandName = picked(answer, commands);
            commandConfidence = typeof answer?.confidence === 'number' ? answer.confidence : 0;
            if (!commandName) return this.decline(`no usable ${intent} command chosen  [${rankedLabels(answer?.probabilities)}]`, request);
        }
        const floor = floorFor(commandName, this.isAction);
        if (commandConfidence < floor) {
            return this.decline(`${commandName} at ${commandConfidence.toFixed(2)} is below the ${floor} floor  [${rankedLabels(answers[`cmd_${intent}`]?.probabilities)}]`, request);
        }

        const line = formatCommand(specs[commandName], answers, world, request, speaker, this.registry);
        if (!line) {
            console.log(`[jev] ${commandName} chosen but an argument could not be resolved from "${request}"`);
            return this.finish("I'm not sure which one you mean.");
        }
        if (repeatsFailure(task, line)) {
            console.log(`[jev] ${line} just failed; not repeating it`);
            return this.finish("That didn't work.");
        }
        console.log(`[jev] ${intent} ${intentConfidence.toFixed(2)} -> ${commandName} ${commandConfidence.toFixed(2)}/${floor} -> ${line}  (${usable.length} options, ${tokens} tok)`);
        return line;
    }

    /**
     * Jev returns judgments, not vectors. Configure a separate `embedding` in
     * the profile (or "none") — mindcraft falls back to word-overlap matching.
     */
    embed() {
        return Promise.reject(new Error('Jev does not produce embeddings; set "embedding": "none" in the profile.'));
    }
}

function rankedLabels(probabilities) {
    return Object.entries(probabilities || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(' ');
}

// ---------------------------------------------------------------------------
// Reading the world
// ---------------------------------------------------------------------------

function emptyWorld() {
    return {
        fromSnapshot: false,
        inventory: {},
        equipment: {},
        craftable: [],
        players: [],
        nearbyPlayers: [],
        playerDistance: {},
        blocks: [],
        blockInfo: {},
        entities: [],
        entityCounts: {},
        entityInfo: {},
        villagers: [],
        position: null,
        health: null,
        hunger: null,
        timeOfDay: null,
        weather: null,
        biome: null,
        currentAction: null,
    };
}

/**
 * The world as the adapter reasons about it. Prefers the JSON snapshot the Jev
 * profile's prompt carries; falls back to parsing the stock prompt's STATS,
 * INVENTORY, NEARBY_ENTITIES and NEARBY_BLOCKS text, which has no distances,
 * counts or craftables.
 */
function parseWorld(systemMessage) {
    const text = String(systemMessage || '');
    const start = text.indexOf(WORLD_START);
    const end = text.indexOf(WORLD_END);
    if (start !== -1 && end > start) {
        try {
            return fromSnapshot(JSON.parse(text.slice(start + WORLD_START.length, end).trim()));
        } catch (err) {
            console.warn('[jev] world snapshot unreadable, parsing prompt text instead:', err.message);
        }
    }
    return fromPromptText(text);
}

function fromSnapshot(snap) {
    const w = emptyWorld();
    w.fromSnapshot = true;
    const bot = snap.bot || {};
    w.position = bot.position || null;
    w.health = bot.health ?? null;
    w.hunger = bot.hunger ?? null;
    w.timeOfDay = bot.time_of_day ?? null;
    w.weather = bot.weather ?? null;
    w.biome = bot.biome ?? null;
    w.currentAction = bot.current_action ?? null;
    for (const { item, count } of snap.inventory || []) if (item) w.inventory[item] = Number(count) || 0;
    w.equipment = snap.equipment || {};
    w.craftable = Array.isArray(snap.craftable) ? snap.craftable.filter((n) => typeof n === 'string') : [];
    for (const b of snap.nearby_blocks || []) {
        if (!b?.type || b.type === 'air') continue;
        w.blocks.push(b.type);
        w.blockInfo[b.type] = { count: b.count ?? 1, distance: b.distance ?? null };
    }
    for (const e of snap.nearby_entities || []) {
        if (!e?.type) continue;
        w.entities.push(e.type);
        w.entityCounts[e.type] = e.count ?? 1;
        w.entityInfo[e.type] = { distance: e.distance ?? null, hostile: !!e.hostile, huntable: !!e.huntable };
    }
    w.villagers = (snap.villagers || []).filter((v) => v && typeof v.id === 'number' && !v.baby)
        .map((v) => ({ id: v.id, profession: v.profession || 'none', distance: v.distance ?? null }));
    for (const p of snap.nearby_players || []) {
        if (!p?.name) continue;
        w.players.push(p.name);
        w.playerDistance[p.name] = p.distance ?? null;
    }
    w.nearbyPlayers = [...w.players];
    return w;
}

function fromPromptText(full) {
    const w = emptyWorld();
    const docsAt = full.indexOf('*COMMAND DOCS');
    const text = docsAt === -1 ? full : full.slice(0, docsAt);
    const section = (label) => {
        const start = text.indexOf(label);
        if (start === -1) return [];
        const rest = text.slice(start + label.length);
        const end = rest.search(/\n\s*\n|\n[A-Z_]{4,}:?\n/);
        return (end === -1 ? rest : rest.slice(0, end))
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('- '))
            .map((l) => l.slice(2).trim());
    };

    for (const line of section('INVENTORY')) {
        const m = /^(.+?):\s*(\d+)$/.exec(line);
        if (m) w.inventory[m[1].trim()] = Number(m[2]);
    }
    for (const line of section('NEARBY_BLOCKS')) {
        const positional = /^(?:Block Below|Block at Legs|Block at Head|First Solid Block Above Head):\s*([a-z_]+)$/.exec(line);
        const name = positional ? positional[1] : line.replace(/\s*\(.*\)$/, '').trim();
        if (/^[a-z_]+$/.test(name) && name !== 'air' && name !== 'none' && !w.blocks.includes(name)) {
            w.blocks.push(name);
            w.blockInfo[name] = { count: null, distance: null };
        }
    }
    for (const line of section('NEARBY_ENTITIES')) {
        const p = /^(?:Human|Bot) player:\s*(.+)$/.exec(line);
        if (p) { w.players.push(p[1].trim()); continue; }
        const e = /^entities:\s*(\d+)\s+([a-z_]+)\(s\)(.*)$/.exec(line);
        if (!e) continue;
        if (!w.entities.includes(e[2])) w.entities.push(e[2]);
        w.entityCounts[e[2]] = (w.entityCounts[e[2]] || 0) + Number(e[1]);
        w.entityInfo[e[2]] = { distance: null, hostile: null, huntable: null };
        if (e[2] === 'villager') {
            for (const v of e[3].matchAll(/\((\d+):([a-z_]+)\)/g)) {
                w.villagers.push({ id: Number(v[1]), profession: v[2], distance: null });
            }
        }
    }
    if (w.players.length === 0) {
        const m = /Nearby Human Players:\s*([^\n]+)/.exec(text);
        if (m && !/^none\.?$/i.test(m[1].trim())) {
            for (const name of m[1].split(',')) if (name.trim()) w.players.push(name.trim().replace(/\.$/, ''));
        }
    }
    w.nearbyPlayers = [...w.players];
    const position = /Position:\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+)/.exec(text);
    const health = /Health:\s*(\d+)\s*\/\s*(\d+)/.exec(text);
    const hunger = /Hunger:\s*(\d+)\s*\/\s*(\d+)/.exec(text);
    const time = /Time:\s*(Morning|Afternoon|Night)/.exec(text);
    w.position = position ? { x: +position[1], y: +position[2], z: +position[3] } : null;
    w.health = health ? Number(health[1]) : null;
    w.hunger = hunger ? Number(hunger[1]) : null;
    w.timeOfDay = time ? time[1].toLowerCase() : null;
    return w;
}

/**
 * Which commands are actually on offer. Read from the rendered COMMAND DOCS
 * rather than the full list, so `blocked_actions` and task restrictions in the
 * profile are respected exactly as they are for every other model.
 */
function parseEnabledCommands(systemMessage) {
    const text = String(systemMessage || '');
    const start = text.indexOf('*COMMAND DOCS');
    if (start === -1) return [];
    const found = new Set();
    for (const m of text.slice(start).matchAll(/^\s*(![A-Za-z]+):/gm)) found.add(m[1]);
    return [...found];
}

// ---------------------------------------------------------------------------
// The request and the task ledger
// ---------------------------------------------------------------------------

/**
 * The last thing an actual player (or another bot) said. History gives every
 * speaker other than the bot itself the `user` role and formats the content
 * "Name: text"; require both, because system turns such as "INVENTORY:
 * Nothing" look like a speaker line but are not one.
 */
const PLAYER_LINE = /^\s*([A-Za-z0-9_]{1,16}):\s+(.+)$/s;

function lastUserMessage(turns) {
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (!t || t.role !== 'user' || typeof t.content !== 'string') continue;
        const m = PLAYER_LINE.exec(t.content.trim());
        if (m) return { speaker: m[1], text: m[2].trim(), index: i };
    }
    return { speaker: null, text: '', index: -1 };
}

function newTask(speaker, request, world) {
    return {
        speaker,
        request,
        startedAt: new Date().toISOString(),
        inventoryAtStart: { ...world.inventory },
        events: [],   // { cmd } for a command the bot issued, { out } for what mindcraft reported
    };
}

const COMMAND_LINE = /!\w+(?:\([^)]*\))?/;

/**
 * Everything that happened after the request, as events. While the request is
 * still in the history window the ledger is rebuilt from it; once it has
 * scrolled out, new turns are appended after the last event already known.
 */
function updateLedger(task, turns, requestIndex) {
    const fresh = [];
    for (let i = requestIndex + 1; i < turns.length; i++) {
        const t = turns[i];
        if (!t || typeof t.content !== 'string' || t.role === 'user') continue;
        const text = t.content.trim();
        if (!text || text.startsWith('*COMMAND DOCS')) continue;
        if (t.role === 'assistant') {
            const m = COMMAND_LINE.exec(text);
            if (m) fresh.push({ cmd: m[0] });
        } else {
            fresh.push({ out: text.replace(/^(?:Action|Code) output:\s*/i, '').replace(/\s+/g, ' ').slice(0, 200) });
        }
    }
    if (requestIndex >= 0 || task.events.length === 0) {
        task.events = fresh;
        return;
    }
    const last = task.events[task.events.length - 1];
    let start = -1;
    for (let i = fresh.length - 1; i >= 0; i--) {
        if (fresh[i].cmd === last.cmd && fresh[i].out === last.out) { start = i; break; }
    }
    task.events.push(...fresh.slice(start + 1));
}

const FAILURE_OUTPUT = /^(Could not|Cannot|Invalid|No |You do not|You don't|You have no|Failed|Error|Unable|Command .* (?:does not exist|was given))/i;

/** The last command issued for the task and whether what followed it reported a failure. */
function lastAttempt(task) {
    const { events } = task;
    let i = events.length - 1;
    while (i >= 0 && !events[i].cmd) i--;
    if (i < 0) return null;
    const outs = events.slice(i + 1).filter((e) => e.out).map((e) => e.out);
    return { cmd: events[i].cmd, outs, failed: outs.some((o) => FAILURE_OUTPUT.test(o)) };
}

/** True when `line` is exactly the command that just ran and failed: issuing it again would loop. */
function repeatsFailure(task, line) {
    const last = lastAttempt(task);
    return !!(last && last.failed && last.cmd === line);
}

/**
 * Completion that code can check from the ledger and the world, without a
 * model call. Returns a short reason when the request is done, else null.
 */
function codeSatisfied(task, world, registry, mc) {
    const { request, events } = task;
    const last = lastAttempt(task);
    if (!last || last.outs.length === 0) return null;      // nothing run, or it has not reported yet
    const { outs, failed } = last;
    const name = /^!\w+/.exec(last.cmd)[0];
    const groups = COMMAND_GROUPS[name] || [];

    if (name === '!stop' || name === '!stfu') return 'stopped';
    if (groups.includes('tell')) return 'question answered';
    if (groups.includes('items') && !failed) return `${name} carried out`;
    if (groups.includes('move') && outs.some((o) => /You have reached/i.test(o))) return 'arrived';
    if (name === '!collectBlocks') {
        const wanted = explicitCount(request);
        const target = literalName(request, [...registry.blocks, ...Object.keys(COMMON_BLOCKS)]);
        let collected = 0;
        for (const e of events) {
            const m = e.out && /Collected (\d+) ([a-z_]+)/.exec(e.out);
            if (m && (!target || m[2] === target)) collected += Number(m[1]);
        }
        if (wanted) return collected >= wanted ? `collected ${collected}/${wanted}` : null;
        return collected > 0 && !failed ? `collected ${collected}` : null;
    }
    if (groups.includes('make') && mc) {
        const target = resolveItem(request, {}, world, registry);
        const count = explicitCount(request) ?? 1;
        if (target && (world.inventory[target] || 0) >= count) return `have ${count} ${target}`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Which commands can be formatted at all?
// ---------------------------------------------------------------------------

/**
 * What kind of value a parameter needs, from mindcraft's own declaration.
 * Anything not recognised is 'freetext' and the command is not offered.
 */
function paramKind(commandName, name, meta) {
    const type = meta.type;
    if (type === 'BlockName') return 'block';
    if (type === 'ItemName' || type === 'BlockOrItemName') return 'item';
    if (name === 'player_name') return 'player';
    if (name === 'direction') return 'direction';
    if (type === 'int' || type === 'float') {
        if (name === 'x' || name === 'y' || name === 'z') return 'coord';
        if (name in RANGE_DEFAULT) return 'range';
        if (name === 'distance') return 'distance';
        if (name === 'id') return 'villager';
        if (commandName === '!stay') return 'seconds';
        return 'count';
    }
    if (type === 'boolean') return 'boolean';
    if (type === 'string' && name === 'type') {
        return commandName === '!searchForEntity' ? 'entity_type' : 'entity';  // !attack targets what is nearby
    }
    return 'freetext';
}

function kindsOf(spec) {
    return spec.params.map(([name, meta]) => paramKind(spec.name, name, meta));
}

/** Creatures !attack may target: hostile or huntable when the snapshot says so, anything nearby otherwise. */
function attackable(world) {
    return world.entities.filter((type) => {
        const info = world.entityInfo[type];
        if (!info || info.hostile === null || info.hostile === undefined) return true;
        return info.hostile || info.huntable;
    });
}

function canFormat(spec, world, request) {
    if (!spec) return false;
    for (const kind of kindsOf(spec)) {
        if (kind === 'freetext') return false;
        if (kind === 'player' && world.players.length === 0) return false;
        if (kind === 'entity' && attackable(world).length === 0) return false;
        // Searching for a creature is offered only when the request names one.
        if (kind === 'entity_type' && !literalName(request, [...ENTITY_TYPES, ...world.entities])) return false;
        if (kind === 'villager' && world.villagers.length === 0) return false;
        // A coordinate the player did not type is a guess; do not offer it.
        if (kind === 'coord' && !explicitCoords(request)) return false;
    }
    return true;
}

/** The usable commands by intent group; only groups with at least one command. */
function groupUsable(usable) {
    const groups = {};
    for (const name of usable) {
        for (const intent of COMMAND_GROUPS[name] || []) (groups[intent] ||= []).push(name);
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Building the questions
// ---------------------------------------------------------------------------

function buildState(world, task) {
    const gained = [];
    for (const [item, count] of Object.entries(world.inventory)) {
        const delta = count - (task.inventoryAtStart[item] || 0);
        if (delta > 0) gained.push({ item, count: delta });
    }
    return {
        request: task.request,
        speaker: task.speaker,
        bot: {
            position: world.position,
            health: world.health,
            hunger: world.hunger,
            time_of_day: world.timeOfDay,
            weather: world.weather,
            biome: world.biome,
            current_action: world.currentAction,
            holding: world.equipment.hand ?? null,
        },
        inventory: Object.entries(world.inventory).map(([item, count]) => ({ item, count })),
        craftable_now: world.craftable.slice(0, 30),
        nearby_blocks: world.blocks.slice(0, 25).map((type) => ({ type, ...world.blockInfo[type] })),
        nearby_entities: world.entities.slice(0, 10).map((type) => ({
            type, count: world.entityCounts[type], ...world.entityInfo[type],
        })),
        nearby_players: world.nearbyPlayers.map((name) => ({ name, distance: world.playerDistance[name] ?? null })),
        task: {
            commands_run: task.events.filter((e) => e.cmd).slice(-6).map((e) => e.cmd),
            results: task.events.filter((e) => e.out).slice(-6).map((e) => e.out),
            inventory_gained_since_request: gained,
        },
    };
}

/** The closed set of blocks a BlockName argument may name when the request does not name one. */
function blockCriteria(world) {
    const criteria = {};
    for (const block of world.blocks) {
        const info = world.blockInfo[block] || {};
        criteria[block] = `The block ${block}, present nearby` +
            (info.distance !== null && info.distance !== undefined ? `, nearest about ${info.distance} blocks away` : '') +
            (info.count ? `, ${info.count} seen` : '') + '.';
    }
    for (const [name, description] of Object.entries(COMMON_BLOCKS)) {
        if (!criteria[name]) criteria[name] = `${description} Not in sight, so it would have to be found.`;
    }
    return criteria;
}

/** The closed set of items an ItemName argument may name when the request does not name one. */
function itemCriteria(world) {
    const criteria = {};
    for (const [item, count] of Object.entries(world.inventory)) {
        criteria[item] = `The ${item} the bot is carrying (${count}).`;
    }
    for (const item of world.craftable.slice(0, 40)) {
        if (!criteria[item]) criteria[item] = `${item}, which the bot could craft right now.`;
    }
    for (const [name, description] of Object.entries(COMMON_ITEMS)) {
        if (!criteria[name]) criteria[name] = `${description} Not carried; would have to be crafted, found or taken.`;
    }
    return criteria;
}

function entityCriteria(world, types) {
    const criteria = {};
    for (const type of types) {
        const count = world.entityCounts[type] || 1;
        const info = world.entityInfo[type] || {};
        criteria[type] = `${count} ${type}${count === 1 ? '' : 's'} nearby` +
            (info.distance !== null && info.distance !== undefined ? `, nearest about ${info.distance} blocks away` : '') +
            (info.hostile ? ', hostile' : info.huntable ? ', an animal' : '') + '.';
    }
    return criteria;
}

function buildQuestions(groups, specs, world, request) {
    const quoted = JSON.stringify(request);
    const intents = {};
    for (const intent of Object.keys(INTENTS)) {
        if (intent === 'none' || groups[intent]) intents[intent] = INTENTS[intent].description;
    }

    const questions = {
        // Fallback completion check; code decides the cases it can verify
        // before the model is asked anything.
        satisfied: noul(
            `A player said to the bot: ${quoted}. Looking at what the bot has already done in ` +
            '`task.commands_run`, what those commands reported in `task.results`, and the state the bot is in now, ' +
            'has that request been carried out completely?',
            {
                true: 'The request is done; there is nothing further for the bot to do about it.',
                false: 'Some part of the request is still outstanding, or the bot has not started it.',
            },
        ),
        intent: choice(
            `A player said to the bot: ${quoted}. What kind of thing are they asking the bot to do next? ` +
            'Judge by the words used, what the bot is carrying, what is nearby, and what has already happened.',
            intents,
        ),
    };

    // Speculatively, which command within each group. Only groups with more
    // than one usable command need a question; code reads only the winner.
    const needed = new Set();
    for (const [intent, commands] of Object.entries(groups)) {
        for (const name of commands) for (const kind of kindsOf(specs[name])) needed.add(kind);
        if (commands.length < 2) continue;
        const criteria = {};
        for (const name of commands) {
            const spec = specs[name];
            const args = spec.params.length
                ? ` Takes: ${spec.params.map(([p, m]) => `${p} (${m.type})`).join(', ')}.`
                : '';
            criteria[name] = `${spec.description}${args}`;
        }
        questions[`cmd_${intent}`] = choice(
            `Assume the player's request ${quoted} is of this kind: ${INTENTS[intent].description} ` +
            'Which single command should the bot run next to serve it?',
            criteria,
        );
    }

    // Speculative arguments, asked only when a value the request names outright
    // would not settle it (a single candidate needs no question).
    if (needed.has('block')) {
        questions.block = choice(
            `Assume the command the bot runs needs to name a block type. Which block does ${quoted} refer to?`,
            blockCriteria(world),
        );
    }
    if (needed.has('item')) {
        questions.item = choice(
            `Assume the command the bot runs needs to name an item. Which item does ${quoted} refer to, or ask for?`,
            itemCriteria(world),
        );
    }
    const targets = attackable(world);
    if (needed.has('entity') && targets.length > 1) {
        questions.entity = choice(
            `Assume the command attacks a creature nearby. Which creature does ${quoted} refer to?`,
            entityCriteria(world, targets),
        );
    }
    if (needed.has('player') && world.players.length > 1) {
        const players = {};
        for (const p of world.players) {
            const d = world.playerDistance[p];
            players[p] = world.nearbyPlayers.includes(p)
                ? `The player named ${p}, currently nearby${d !== null && d !== undefined ? ` (about ${d} blocks away)` : ''}.`
                : `The player named ${p}, who is talking to the bot but is not in sight — the bot would have to travel to reach them.`;
        }
        questions.player = choice(
            `Assume the command names a player. Which player does ${quoted} mean? The speaker is usually the answer.`,
            players,
        );
    }
    if (needed.has('villager') && world.villagers.length > 1) {
        const villagers = {};
        for (const v of world.villagers) villagers[String(v.id)] = `The villager with id ${v.id}, a ${v.profession}.`;
        questions.villager = choice(
            `Assume the command names a villager. Which villager does ${quoted} refer to?`,
            villagers,
        );
    }
    if (needed.has('count') || needed.has('distance') || needed.has('seconds')) {
        questions.amount = choice(
            `Assume the command takes a quantity. How many does ${quoted} ask for?`,
            AMOUNTS,
        );
    }
    return questions;
}

// ---------------------------------------------------------------------------
// Planning in code: the next step toward having an item
// ---------------------------------------------------------------------------

/** The item a request is about, named outright or chosen by the model. */
function resolveItem(request, answers, world, registry) {
    const candidates = Object.keys(itemCriteria(world));
    return literalName(request, [...registry.items, ...candidates]) ?? picked(answers.item, candidates);
}

/** A 2x2 hand grid holds four ingredients; anything more needs a crafting table. */
function needsTable(ingredients) {
    return Object.values(ingredients).reduce((a, b) => a + b, 0) > 4;
}

/**
 * Total base materials still needed to end up with `count` of `item`, walking
 * the recipe graph and consuming a copy of the inventory along the way.
 */
function baseNeeds(item, count, inventory, mc, needs = {}, depth = 0) {
    const have = inventory[item] || 0;
    const use = Math.min(have, count);
    inventory[item] = have - use;
    count -= use;
    if (count <= 0 || depth > 6) return needs;
    const smeltFrom = mc.getItemSmeltingIngredient(item);
    if (smeltFrom) return baseNeeds(smeltFrom, count, inventory, mc, needs, depth + 1);
    const recipes = mc.getItemCraftingRecipes(item);
    if (!recipes || !recipes.length) {
        needs[item] = (needs[item] || 0) + count;
        return needs;
    }
    const [ingredients, { craftedCount }] = recipes[0];
    const times = Math.ceil(count / (craftedCount || 1));
    for (const [ingredient, n] of Object.entries(ingredients)) baseNeeds(ingredient, n * times, inventory, mc, needs, depth + 1);
    inventory[item] = (inventory[item] || 0) + times * (craftedCount || 1) - count;
    return needs;
}

/**
 * The single next command toward having `count` of `item`: craft it if its
 * ingredients are in hand, otherwise smelt, craft or collect the first missing
 * ingredient. A base material is gathered the whole plan's worth at once (the
 * plan for the target plus a crafting table if one will be needed), so the bot
 * does not walk to the trees once per plank. Returns null when nothing
 * applicable is enabled or the item is unobtainable this way.
 */
function nextStepToward(item, count, world, mc, enabled) {
    const plan = baseNeeds(item, count, { ...world.inventory }, mc);
    const recipes = mc.getItemCraftingRecipes(item);
    if (recipes && recipes.length && needsTable(recipes[0][0]) && !hasTable(world)) {
        baseNeeds('crafting_table', 1, { ...world.inventory }, mc, plan);
    }
    return stepToward(item, count, world, mc, enabled, plan, 0);
}

function hasTable(world) {
    return world.inventory.crafting_table > 0 || world.blocks.includes('crafting_table');
}

function stepToward(item, count, world, mc, enabled, plan, depth) {
    const have = world.inventory[item] || 0;
    if (have >= count || depth > 6) return null;
    const missing = count - have;

    const smeltFrom = mc.getItemSmeltingIngredient(item);
    if (smeltFrom) {
        if ((world.inventory[smeltFrom] || 0) >= missing) {
            return enabled.has('!smeltItem') ? `!smeltItem(${JSON.stringify(smeltFrom)}, ${missing})` : null;
        }
        return stepToward(smeltFrom, missing, world, mc, enabled, plan, depth + 1);
    }

    const recipes = mc.getItemCraftingRecipes(item);
    if (recipes && recipes.length) {
        const [ingredients, { craftedCount }] = recipes[0];
        const times = Math.ceil(missing / (craftedCount || 1));
        if (needsTable(ingredients) && !hasTable(world)) {
            const tableStep = stepToward('crafting_table', 1, world, mc, enabled, plan, depth + 1);
            if (tableStep) return tableStep;
        }
        for (const [ingredient, n] of Object.entries(ingredients)) {
            if ((world.inventory[ingredient] || 0) < n * times) {
                return stepToward(ingredient, n * times, world, mc, enabled, plan, depth + 1);
            }
        }
        return enabled.has('!craftRecipe') ? `!craftRecipe(${JSON.stringify(item)}, ${times})` : null;
    }

    // A base material: collect it from the block that drops it.
    const total = Math.max(plan[item] || 0, missing);
    const sources = mc.getItemBlockSources(item);
    if (sources && sources.length) {
        const source = sources.find((s) => world.blocks.includes(s)) || sources[0];
        return enabled.has('!collectBlocks') ? `!collectBlocks(${JSON.stringify(source)}, ${Math.min(total, GATHER_CAP)})` : null;
    }
    const animal = mc.getItemAnimalSource(item);
    if (animal) {
        if (world.entities.includes(animal) && enabled.has('!attack')) return `!attack(${JSON.stringify(animal)})`;
        if (enabled.has('!searchForEntity')) return `!searchForEntity(${JSON.stringify(animal)}, ${RANGE_DEFAULT.search_range})`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Formatting the command line
// ---------------------------------------------------------------------------

/** An explicit number the player typed — exact, so code reads it, not the model. */
function explicitCount(request) {
    const m = /\b(\d{1,3})\b/.exec(request || '');
    if (!m) return null;
    const n = Number(m[1]);
    return n > 0 && n <= 512 ? n : null;
}

function explicitCoords(request) {
    const m = /(-?\d{1,6})\s*[, ]\s*(-?\d{1,3})\s*[, ]\s*(-?\d{1,6})/.exec(request || '');
    return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
}

/** A player the request names outright, matched case-insensitively as a whole word. */
function literalPlayer(request, players) {
    const text = normalizedWords(request);
    return players.find((p) => text.includes(` ${p.toLowerCase()} `)) || null;
}

/** A villager id the request names outright. */
function literalVillager(request, villagers) {
    for (const m of String(request || '').matchAll(/\b(\d{1,9})\b/g)) {
        const id = Number(m[1]);
        if (villagers.some((v) => v.id === id)) return id;
    }
    return null;
}

/** The model's pick for a speculative question, or null if it picked nothing usable. */
function picked(answer, allowed) {
    const value = answer && typeof answer.choice === 'string' ? answer.choice : null;
    if (!value || value === 'none') return null;
    return allowed.includes(value) ? value : null;
}

/**
 * Build the `!command(args)` line, or return null when some argument cannot
 * be resolved from the request, the world or the model's answers. Exact
 * lookups come first: a value the request names outright is never judged.
 */
function formatCommand(spec, answers, world, request, speaker, registry) {
    if (!spec.params.length) return spec.name;

    const coords = explicitCoords(request);
    const number = explicitCount(request);
    const amount = AMOUNT_VALUES[answers.amount?.choice] ?? AMOUNT_VALUES.a_few;
    const args = [];
    for (const [name, meta] of spec.params) {
        const kind = paramKind(spec.name, name, meta);
        let value;
        switch (kind) {
            case 'block': {
                const candidates = Object.keys(blockCriteria(world));
                value = literalName(request, [...registry.blocks, ...candidates]) ?? picked(answers.block, candidates);
                break;
            }
            case 'item':
                value = resolveItem(request, answers, world, registry);
                break;
            case 'entity': {
                const targets = attackable(world);
                value = literalName(request, targets)
                    ?? (targets.length === 1 ? targets[0] : picked(answers.entity, targets));
                break;
            }
            case 'entity_type':
                value = literalName(request, [...ENTITY_TYPES, ...world.entities]);
                break;
            case 'player':
                value = literalPlayer(request, world.players)
                    ?? (world.players.length === 1 ? world.players[0] : picked(answers.player, world.players))
                    ?? speaker;
                break;
            case 'villager': {
                const ids = world.villagers.map((v) => v.id);
                const chosen = picked(answers.villager, ids.map(String));
                value = literalVillager(request, world.villagers)
                    ?? (ids.length === 1 ? ids[0] : (chosen === null ? null : Number(chosen)));
                break;
            }
            case 'coord':
                value = coords ? coords[name] : null;
                break;
            case 'range':
                value = RANGE_DEFAULT[name];
                break;
            case 'distance':
                value = number ?? DISTANCE_DEFAULT[spec.name] ?? DISTANCE_FALLBACK;
                break;
            case 'seconds':
                value = number ?? SECONDS_DEFAULT;
                break;
            case 'count':
                value = number ?? amount;
                break;
            case 'boolean':
                value = true;
                break;
            case 'direction':
                value = 'at';
                break;
            default:
                value = null;
        }
        if (value === null || value === undefined) return null;
        args.push(typeof value === 'string' ? JSON.stringify(value) : value);
    }
    return `${spec.name}(${args.join(', ')})`;
}
