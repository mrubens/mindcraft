import { TypeSafeClient, choice, noul } from './typesafe_client.js';
import { getKey } from '../utils/keys.js';

// ---------------------------------------------------------------------------
// Jev — TypeSafe's System One model — as a mindcraft chat model.
//
// Mindcraft's other adapters ask an LLM to *write* a line of text and then
// regex a command out of it. Jev does not generate text at all: it returns
// typed judgments. So this adapter inverts the arrangement. It reads the
// command list mindcraft already declares, turns it into a closed choice
// question, asks Jev which command to run and what its arguments should be,
// and formats the `!command("arg", 3)` line itself.
//
// The consequences worth knowing:
//
//   * The command and every argument come back typed and bounded. The model
//     cannot invent a command that does not exist or an item that is not in
//     the closed set, so the malformed-call failure mode disappears.
//   * Exact values stay in code. A number, a block, an item or a player the
//     request names outright is read with a regex against the candidate set,
//     not judged. The model is consulted only when the request is vague.
//   * Commands whose arguments are genuinely free text (!newAction's code
//     prompt, !searchWiki's query) cannot be expressed and are withheld; see
//     UNSUPPORTED below.
//   * The bot does not make conversation. Jev cannot write prose, so replies
//     are the command results mindcraft prints itself.
// ---------------------------------------------------------------------------

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
 * Commands withheld for reasons other than being unexpressible.
 *
 * !help prints the whole command list into chat. Jev reaches for it as a
 * fallback whenever nothing else obviously applies — it was chosen at 0.36-0.51
 * repeatedly, clearing the query floor every time because reading help is
 * harmless. Harmless but useless: a player who wants the command list can ask
 * for it, and leaving it on the menu only drains probability from commands that
 * would actually do something.
 */
const SUPPRESSED = new Set(['!help']);

/** Distance-like parameters and the value used when the request names none. */
const RANGE_DEFAULT = { closeness: 1, search_range: 64, follow_dist: 3 };
/** Default for a `distance` parameter, per command, when the request names none. */
const DISTANCE_DEFAULT = { '!digDown': 4, '!moveAway': 8 };
const DISTANCE_FALLBACK = 8;
/** Default for !stay when the request names no number of seconds. */
const SECONDS_DEFAULT = 30;

const AMOUNTS = {
    one: 'A single one, or the message implies just one.',
    a_few: 'A small handful — "a few", "some", "a couple".',
    a_lot: 'A large amount — "a stack", "lots", "as much as you can".',
};
const AMOUNT_VALUES = { one: 1, a_few: 4, a_lot: 32 };

/**
 * How sure Jev must be before the adapter will act.
 *
 * With 30-40 command labels on offer, probability spreads thin and a top pick
 * of 0.16 is close to a coin flip between several options — which is how the
 * bot ended up collecting things nobody asked for and digging aimlessly.
 * Below the floor it declines to act instead of running the top of a flat
 * distribution.
 *
 * The bar rises with consequence. Answering "what are you carrying?" wrongly
 * costs nothing and can be corrected by asking again; digging a shaft or
 * throwing away an inventory cannot.
 */
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

/** How sure the `satisfied` check must be before the adapter stops without a command. */
const SATISFIED_THRESHOLD = 0.6;

function floorFor(name, isAction) {
    if (CONSEQUENTIAL.has(name)) return FLOOR.consequential;
    return isAction(name) ? FLOOR.action : FLOOR.query;
}

/**
 * Blocks worth naming even when none is in sight. A command like
 * !collectBlocks exists precisely because the thing is not already to hand, so
 * building the candidate set from nearby blocks alone made "collect 5 oak logs"
 * resolve to whatever happened to be underfoot.
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

/**
 * Items worth naming even when the bot is not carrying them, for commands
 * such as !craftRecipe and !takeFromChest whose argument is something the bot
 * wants rather than something it has.
 */
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
    iron_ingot: 'Iron ingots, smelted from iron ore.',
    coal: 'Coal, fuel.',
};

/** Words players use for blocks and items, resolved in code rather than judged. */
const ALIASES = {
    wood: 'oak_log', log: 'oak_log', logs: 'oak_log', tree: 'oak_log', trees: 'oak_log',
    timber: 'oak_log', plank: 'oak_planks', planks: 'oak_planks', sticks: 'stick',
    cobble: 'cobblestone', rock: 'stone', rocks: 'stone', stones: 'stone',
    coal: 'coal_ore', iron: 'iron_ore', gold: 'gold_ore', copper: 'copper_ore',
    diamond: 'diamond_ore', diamonds: 'diamond_ore', grass: 'grass_block',
    pickaxe: 'wooden_pickaxe', pick: 'wooden_pickaxe', axe: 'wooden_axe', sword: 'wooden_sword',
    table: 'crafting_table', torches: 'torch', food: 'bread',
};

/** Lower-cased request text with punctuation removed, padded so whole-word checks are simple. */
function normalizedWords(request) {
    return ` ${String(request || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim()} `;
}

/**
 * A candidate the request names outright, as a whole word or phrase, singular
 * or plural, with or without underscores. Longer names win so "dark oak logs"
 * resolves to dark_oak_log rather than oak_log, and "sandstone" no longer
 * matches "stone". Aliases ("wood", "cobble") are tried last.
 */
function literalName(request, names) {
    const text = normalizedWords(request);
    if (text.trim() === '' || !names.length) return null;
    const sorted = [...names].filter((n) => n && n !== 'none').sort((a, b) => b.length - a.length);
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
        this.announced = false;
        this.warnedOtherPrompt = new Set();
        // Mindcraft truncates history, so the turn carrying a player's message
        // eventually scrolls out of the window mid-task. Remember who spoke and
        // what they asked so the task can be finished; both are cleared when
        // the adapter replies without a command, which ends the task.
        this.lastSpeaker = null;
        this.lastRequest = null;
    }

    /**
     * Mindcraft's own command declarations, which carry real parameter types
     * and numeric domains — richer than the rendered COMMAND DOCS, where
     * BlockName and int are both flattened to "string" and "number".
     */
    async loadCommands() {
        if (this.getCommand) return this.getCommand;
        const idx = await import('../agent/commands/index.js');
        if (typeof idx.getCommand !== 'function') throw new Error('getCommand not exported');
        this.getCommand = idx.getCommand;
        // isAction separates world-changing commands from read-only queries,
        // which is what the confidence floor is graded on.
        this.isAction = typeof idx.isAction === 'function' ? idx.isAction : () => true;
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
     * ends mindcraft's loop for this request, so forget it.
     */
    finish(reply) {
        this.lastRequest = null;
        return reply;
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
        // carry a real player message.
        if (process.env.JEV_DUMP) {
            const fromPlayer = turns.some((t) => t && t.role === 'user' &&
                typeof t.content === 'string' && PLAYER_LINE.test(t.content.trim()));
            if (fromPlayer) {
                const fs = await import('fs');
                fs.appendFileSync(process.env.JEV_DUMP,
                    JSON.stringify({ at: new Date().toISOString(), systemMessage, turns }) + '\n');
            }
        }

        const found = lastUserMessage(turns);
        if (found.speaker) {
            this.lastSpeaker = found.speaker;
            this.lastRequest = found.text;
        }
        const speaker = found.speaker || this.lastSpeaker;
        const request = found.text || this.lastRequest || '';
        if (!request) {
            // Nothing has been asked: mindcraft's bootstrap turn, or a system
            // event with no task in flight. An empty reply ends the loop
            // quietly and costs no API call.
            return '';
        }

        const world = parseWorld(system);
        // Whoever is talking to the bot is a valid target whether or not they
        // are in render distance: "come to me" is asked precisely when the bot
        // is not beside you.
        if (speaker && !world.players.includes(speaker)) world.players.unshift(speaker);

        const enabled = parseEnabledCommands(system);
        const specs = this.specsFor(enabled, getCommand);
        const usable = enabled.filter((name) => specs[name] && !UNSUPPORTED.has(name) &&
            !SUPPRESSED.has(name) && canFormat(specs[name], world, request));
        if (!this.announced) {
            const withheld = enabled.filter((n) => UNSUPPORTED.has(n));
            const suppressed = enabled.filter((n) => SUPPRESSED.has(n));
            console.log(`[jev] ${usable.length} commands offered as typed choices` +
                (withheld.length ? `; ${withheld.length} withheld (need text the model cannot produce): ${withheld.join(' ')}` : '') +
                (suppressed.length ? `; suppressed: ${suppressed.join(' ')}` : ''));
            this.announced = true;
        }
        if (usable.length === 0) return this.finish('No commands are available to me right now.');

        const state = buildState(world, request, speaker, turns, found.index);
        const questions = buildQuestions(usable, specs, world, request);

        let result;
        try {
            result = await this.client.systemOne({ state, questions });
        } catch (err) {
            console.error('[jev]', err.message);
            return this.finish('My brain disconnected, try again.');
        }

        const answers = result?.answers;
        if (!answers || !answers.command || typeof answers.command.choice !== 'string') {
            console.error('[jev] unexpected response shape:', JSON.stringify(result).slice(0, 300));
            return this.finish('My brain disconnected, try again.');
        }

        // A plain reply with no command is how mindcraft is told to stop.
        const satisfied = answers.satisfied?.noul;
        if (typeof satisfied === 'number' && satisfied >= SATISFIED_THRESHOLD) {
            console.log(`[jev] request satisfied (${satisfied.toFixed(2)}) — replying without a command`);
            return this.finish('Done.');
        }

        const picked = answers.command.choice;
        const confidence = typeof answers.command.confidence === 'number' ? answers.command.confidence : 0;
        const floor = floorFor(picked, this.isAction);
        if (!usable.includes(picked)) {
            console.error(`[jev] model chose ${picked}, which was not offered`);
            return this.finish("I'm not sure what you want me to do about that.");
        }
        if (confidence < floor) {
            // Replying without a command ends mindcraft's loop, so the bot
            // stops rather than acting on a guess.
            const ranked = Object.entries(answers.command.probabilities || {})
                .sort((a, b) => b[1] - a[1]).slice(0, 3)
                .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(' ');
            console.log(`[jev] declining: ${picked} at ${confidence.toFixed(2)} is below the ${floor} floor  [${ranked}]`);
            return this.finish("I'm not sure what you want me to do about that.");
        }

        const line = formatCommand(specs[picked], answers, world, request, speaker);
        if (!line) {
            console.log(`[jev] ${picked} chosen at ${confidence.toFixed(2)} but an argument could not be resolved from "${request}"`);
            return this.finish("I'm not sure which one you mean.");
        }
        console.log(`[jev] ${picked} conf=${confidence.toFixed(2)}/${floor}` +
            ` -> ${line}  (${usable.length} options, ${result.usage?.input_tokens ?? '?'} tok)`);
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

// ---------------------------------------------------------------------------
// Reading the prompt
// ---------------------------------------------------------------------------

/**
 * Mindcraft renders state into the system prompt as labelled line lists:
 * STATS, INVENTORY, and — appended to $STATS by the prompter — NEARBY_ENTITIES
 * and NEARBY_BLOCKS. Parsing them back out gives the closed sets the argument
 * questions need. Only the text before COMMAND DOCS is read, so few-shot
 * examples rendered after it can never leak into the world.
 */
function parseWorld(systemMessage) {
    const full = String(systemMessage || '');
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

    const inventory = {};
    for (const line of section('INVENTORY')) {
        const m = /^(.+?):\s*(\d+)$/.exec(line);
        if (m) inventory[m[1].trim()] = Number(m[2]);
    }

    const blocks = new Set();
    for (const line of section('NEARBY_BLOCKS')) {
        // "oak_log", "water (source)", "Block Below: grass_block",
        // "First Solid Block Above Head: none"
        const positional = /^(?:Block Below|Block at Legs|Block at Head|First Solid Block Above Head):\s*([a-z_]+)$/.exec(line);
        const name = positional ? positional[1] : line.replace(/\s*\(.*\)$/, '').trim();
        if (/^[a-z_]+$/.test(name) && name !== 'air' && name !== 'none') blocks.add(name);
    }

    const players = [];
    const entityCounts = {};
    const villagers = [];
    for (const line of section('NEARBY_ENTITIES')) {
        const p = /^(?:Human|Bot) player:\s*(.+)$/.exec(line);
        if (p) { players.push(p[1].trim()); continue; }
        // "entities: 2 zombie(s)" or
        // "entities: 3 villager(s) - Adults: (123:farmer), (124:none) - Baby IDs: 130 (babies cannot trade)"
        const e = /^entities:\s*(\d+)\s+([a-z_]+)\(s\)(.*)$/.exec(line);
        if (!e) continue;
        entityCounts[e[2]] = (entityCounts[e[2]] || 0) + Number(e[1]);
        if (e[2] === 'villager') {
            for (const v of e[3].matchAll(/\((\d+):([a-z_]+)\)/g)) {
                villagers.push({ id: Number(v[1]), profession: v[2] });
            }
        }
    }
    // STATS also lists nearby players by name; use it when the entity list is missing.
    if (players.length === 0) {
        const m = /Nearby Human Players:\s*([^\n]+)/.exec(text);
        if (m && !/^none\.?$/i.test(m[1].trim())) {
            for (const name of m[1].split(',')) if (name.trim()) players.push(name.trim().replace(/\.$/, ''));
        }
    }

    const position = /Position:\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+)/.exec(text);
    const health = /Health:\s*(\d+)\s*\/\s*(\d+)/.exec(text);
    const hunger = /Hunger:\s*(\d+)\s*\/\s*(\d+)/.exec(text);

    return {
        inventory,
        nearbyPlayers: [...players],
        players,
        blocks: [...blocks],
        entities: Object.keys(entityCounts),
        entityCounts,
        villagers,
        position: position ? { x: +position[1], y: +position[2], z: +position[3] } : null,
        health: health ? Number(health[1]) : null,
        hunger: hunger ? Number(hunger[1]) : null,
    };
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

/**
 * The last thing an actual player (or another bot) said.
 *
 * Mindcraft re-prompts after every action finishes, so the most recent turn is
 * usually its own output ("Action output: Collected 1 oak_log."), not a
 * request. History gives every speaker other than the bot itself the `user`
 * role and formats the content "Name: text", so require both: system turns
 * such as "INVENTORY: Nothing" look like a speaker line but are not one.
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

/**
 * What has happened since the request, as events rather than as instructions:
 * action results, pathfinding failures, the behaviour log. These are what tell
 * the model a job is already done, or that it is stuck.
 */
function recentEvents(turns, fromIndex, limit = 6) {
    const events = [];
    for (let i = turns.length - 1; i > fromIndex && events.length < limit; i--) {
        const t = turns[i];
        if (!t || typeof t.content !== 'string') continue;
        const text = t.content.trim();
        if (!text) continue;
        if (t.role === 'user') continue;
        if (text.startsWith('*COMMAND DOCS') || text.includes('You can use the following commands')) continue;
        if (t.role === 'assistant') { events.push({ bot_did: text.slice(0, 120) }); continue; }
        events.push({ happened: text.replace(/\s+/g, ' ').slice(0, 200) });
    }
    return events.reverse();
}

// ---------------------------------------------------------------------------
// Can this command's arguments be produced at all?
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
    if (type === 'string' && name === 'type') return 'entity';   // !attack, !searchForEntity
    return 'freetext';
}

function kindsOf(spec) {
    return spec.params.map(([name, meta]) => paramKind(spec.name, name, meta));
}

function canFormat(spec, world, request) {
    if (!spec) return false;
    for (const kind of kindsOf(spec)) {
        if (kind === 'freetext') return false;
        if (kind === 'player' && world.players.length === 0) return false;
        if (kind === 'entity' && world.entities.length === 0) return false;
        if (kind === 'villager' && world.villagers.length === 0) return false;
        // A coordinate the player did not type is a guess; do not offer it.
        if (kind === 'coord' && !explicitCoords(request)) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Building the questions
// ---------------------------------------------------------------------------

function buildState(world, request, speaker, turns, requestIndex) {
    return {
        request,
        speaker,
        bot: {
            position: world.position,
            health: world.health,
            hunger: world.hunger,
        },
        inventory: Object.entries(world.inventory).map(([item, count]) => ({ item, count })),
        nearby_blocks: world.blocks.slice(0, 30),
        nearby_entities: Object.entries(world.entityCounts).slice(0, 15).map(([type, count]) => ({ type, count })),
        nearby_players: world.nearbyPlayers,
        recent_events: recentEvents(turns, requestIndex),
    };
}

/** The closed set of blocks a BlockName argument may name. */
function blockCriteria(world) {
    const criteria = {};
    for (const block of world.blocks) criteria[block] = `The block ${block}, present nearby.`;
    for (const [name, description] of Object.entries(COMMON_BLOCKS)) {
        if (!criteria[name]) criteria[name] = `${description} Not in sight, so it would have to be found.`;
    }
    return criteria;
}

/** The closed set of items an ItemName argument may name. */
function itemCriteria(world) {
    const criteria = {};
    for (const [item, count] of Object.entries(world.inventory)) {
        criteria[item] = `The ${item} the bot is carrying (${count}).`;
    }
    for (const [name, description] of Object.entries(COMMON_ITEMS)) {
        if (!criteria[name]) criteria[name] = `${description} Not carried; would have to be crafted, found or taken.`;
    }
    return criteria;
}

/** The closed set of creatures an entity-type argument may name. */
function entityCriteria(world) {
    const criteria = {};
    for (const [type, count] of Object.entries(world.entityCounts)) {
        criteria[type] = `${count} ${type}${count === 1 ? '' : 's'} nearby.`;
    }
    return criteria;
}

function buildQuestions(usable, specs, world, request) {
    const criteria = {};
    const needed = new Set();
    for (const name of usable) {
        const spec = specs[name];
        for (const kind of kindsOf(spec)) needed.add(kind);
        const args = spec.params.length
            ? ` Takes: ${spec.params.map(([p, m]) => `${p} (${m.type})`).join(', ')}.`
            : '';
        criteria[name] = `${spec.description}${args}`;
    }

    const questions = {
        // Mindcraft ends its loop when a reply contains no command. Without a
        // way to say "done", the adapter emitted a command every single turn
        // and the agent repeated the same command forever.
        satisfied: noul(
            `A player said to the bot: "${request}". Looking at what the bot has already done in ` +
            '`recent_events` and the state it is now in, has that request been carried out completely?',
            {
                true: 'The request is done; there is nothing further for the bot to do about it.',
                false: 'Some part of the request is still outstanding, or the bot has not started it.',
            },
        ),
        command: choice(
            `A player said to the bot: "${request}". Which single command should the bot run next to serve what they asked for? ` +
            `Judge by what the bot is carrying, what is nearby, and what has already happened.`,
            criteria,
        ),
    };

    // Speculative arguments. These are answered in parallel with the command
    // choice and cost no extra round trip; code reads only the ones the chosen
    // command actually takes, and asks only when a value the request names
    // outright would not settle it (a single candidate needs no question).
    if (needed.has('block')) {
        questions.block = choice(
            `Assume the command the bot runs needs to name a block type. Which block does "${request}" refer to?`,
            blockCriteria(world),
        );
    }
    if (needed.has('item')) {
        questions.item = choice(
            `Assume the command the bot runs needs to name an item. Which item does "${request}" refer to?`,
            itemCriteria(world),
        );
    }
    if (needed.has('entity') && world.entities.length > 1) {
        questions.entity = choice(
            `Assume the command names a creature nearby. Which creature does "${request}" refer to?`,
            entityCriteria(world),
        );
    }
    if (needed.has('player') && world.players.length > 1) {
        const players = {};
        for (const p of world.players) {
            players[p] = world.nearbyPlayers.includes(p)
                ? `The player named ${p}, currently nearby.`
                : `The player named ${p}, who is talking to the bot but is not in sight — the bot would have to travel to reach them.`;
        }
        questions.player = choice(
            `Assume the command names a player. Which player does "${request}" mean? The speaker is usually the answer.`,
            players,
        );
    }
    if (needed.has('villager') && world.villagers.length > 1) {
        const villagers = {};
        for (const v of world.villagers) villagers[String(v.id)] = `The villager with id ${v.id}, a ${v.profession}.`;
        questions.villager = choice(
            `Assume the command names a villager. Which villager does "${request}" refer to?`,
            villagers,
        );
    }
    if (needed.has('count') || needed.has('distance') || needed.has('seconds')) {
        questions.amount = choice(
            `Assume the command takes a quantity. How many does "${request}" ask for?`,
            AMOUNTS,
        );
    }
    return questions;
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
function formatCommand(spec, answers, world, request, speaker) {
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
                value = literalName(request, candidates) ?? picked(answers.block, candidates);
                break;
            }
            case 'item': {
                const candidates = Object.keys(itemCriteria(world));
                value = literalName(request, candidates) ?? picked(answers.item, candidates);
                break;
            }
            case 'entity':
                value = literalName(request, world.entities)
                    ?? (world.entities.length === 1 ? world.entities[0] : picked(answers.entity, world.entities));
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
