import { TypeSafeClient, choice, noul } from './typesafe_client.js';
import { getKey, hasKey } from '../utils/keys.js';

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
//   * Exact values stay in code. A number the player typed is read with a
//     regex, not judged.
//   * Commands whose arguments are genuinely free text (!newAction's code
//     prompt, !searchWiki's query) cannot be expressed and are withheld; see
//     UNSUPPORTED below.
//   * The bot does not make conversation. Jev cannot write prose, so replies
//     are the command results mindcraft prints itself.
// ---------------------------------------------------------------------------

/**
 * Commands whose arguments cannot be produced without generating free text.
 * Offering them would guarantee a malformed call, so they are left out of the
 * choice entirely and logged once at startup.
 */
const UNSUPPORTED = new Set([
    '!newAction',          // a natural-language prompt for code generation
    '!goal',               // a self-prompt written in prose
    '!startConversation',  // an opening line to another bot
    '!searchWiki',         // a free-text query
    '!rememberHere',       // a name invented for a place
    '!endGoal',            // paired with !goal
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

/** Parameter names that are really a quantity, whatever the command calls them. */
const COUNT_PARAMS = new Set(['num', 'count', 'quantity', 'amount', 'levelNum', 'index', 'id']);
/** Parameter names that are really a distance or tolerance. */
const RANGE_PARAMS = new Set(['search_range', 'closeness', 'distance', 'follow_dist']);

const DEFAULT_RANGE = { search_range: 64, closeness: 1, distance: 8, follow_dist: 3 };

const AMOUNTS = {
    one: 'A single one, or the message implies just one.',
    a_few: 'A small handful — "a few", "some", "a couple".',
    a_lot: 'A large amount — "a stack", "lots", "as much as you can".',
};
const AMOUNT_VALUES = { one: 1, a_few: 4, a_lot: 32 };

/**
 * How sure Jev must be before the adapter will act.
 *
 * With 36-42 command labels on offer, probability spreads thin and a top pick
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
    '!givePlayer', '!consume', '!placeHere', '!useOn', '!activate',
    '!tradeWithVillager', '!moveAway', '!goToCoordinates',
]);

function floorFor(name, isAction) {
    if (CONSEQUENTIAL.has(name)) return FLOOR.consequential;
    return isAction(name) ? FLOOR.action : FLOOR.query;
}

/**
 * Materials worth naming even when none is in sight. A command like
 * !collectBlocks exists precisely because the thing is not already to hand, so
 * building the candidate set from nearby blocks alone made "collect 5 oak logs"
 * resolve to whatever happened to be underfoot.
 */
const COMMON_MATERIALS = {
    oak_log: 'Oak logs — tree trunks, the usual source of wood.',
    birch_log: 'Birch logs — the pale tree trunks.',
    spruce_log: 'Spruce logs — the dark tree trunks.',
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
    oak_planks: 'Crafted wooden planks.',
    stick: 'Sticks.',
};

/** Words players use for blocks, resolved in code rather than judged. */
const ALIASES = {
    wood: 'oak_log', log: 'oak_log', logs: 'oak_log', tree: 'oak_log', trees: 'oak_log',
    timber: 'oak_log', plank: 'oak_planks', planks: 'oak_planks',
    cobble: 'cobblestone', rock: 'stone', rocks: 'stone', stones: 'stone',
    coal: 'coal_ore', iron: 'iron_ore', gold: 'gold_ore', copper: 'copper_ore',
    diamond: 'diamond_ore', diamonds: 'diamond_ore', grass: 'grass_block',
};

/**
 * A block or item the player named outright. Exact lookups belong in code: if
 * the message literally says "oak logs" there is no judgment to make.
 */
function literalThing(request, candidates) {
    const text = String(request || '').toLowerCase();
    const direct = Object.keys(candidates).find((name) => name !== 'none' && text.includes(name));
    if (direct) return direct;
    for (const word of text.match(/[a-z_]+/g) || []) {
        const aliased = ALIASES[word];
        if (aliased && candidates[aliased]) return aliased;
    }
    return null;
}

export class Jev {
    static prefix = 'typesafe';

    constructor(model_name, url, params) {
        this.model_name = model_name || 'jev-latest';
        this.params = params || {};
        this.client = new TypeSafeClient({
            apiKey: hasKey('TYPESAFE_API_KEY') ? getKey('TYPESAFE_API_KEY') : process.env.TYPESAFE_API_KEY,
            baseURL: url,
            model: this.model_name,
            timeout: this.params.timeout ?? 15000,
        });
        this.getCommand = null;
        this.announced = false;
        // Mindcraft truncates history, so the turn carrying a player's message
        // eventually scrolls out of the window. Forgetting who spoke dropped
        // every player-targeting command again mid-task, which is how the bot
        // ended up looping !entities instead of continuing to come.
        this.lastSpeaker = null;
    }

    /**
     * Mindcraft's own command declarations, which carry real parameter types
     * and numeric domains — richer than the rendered COMMAND DOCS, where
     * BlockName and int are both flattened to "string" and "number".
     *
     * Imported lazily and through commands/index.js rather than actions.js:
     * index.js builds its combined list at module top level, so importing the
     * halves directly lands in the middle of a cycle and trips the temporal
     * dead zone.
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

    async sendRequest(turns, systemMessage) {
        let getCommand;
        try {
            getCommand = await this.loadCommands();
        } catch (err) {
            console.error('[jev] could not load command list:', err.message);
            return 'My brain disconnected, try again.';
        }

        // Debug capture of what the adapter actually receives. Skips mindcraft's
        // own bootstrap turn ("Respond with hello world and your name"), which
        // is not a player message and was all the first version ever caught.
        if (process.env.JEV_DUMP) {
            const fromPlayer = turns.some((t) => t && t.role !== 'system' &&
                typeof t.content === 'string' && /^\w+:\s/.test(t.content.trim()));
            if (fromPlayer) {
                const fs = await import('fs');
                fs.appendFileSync(process.env.JEV_DUMP,
                    JSON.stringify({ at: new Date().toISOString(), systemMessage, turns }) + '\n');
            }
        }

        const world = parseWorld(systemMessage);
        const enabled = parseEnabledCommands(systemMessage);
        const specs = this.specsFor(enabled, getCommand);
        const found = lastUserMessage(turns);
        const speaker = found.speaker || this.lastSpeaker;
        const request = found.text;
        if (found.speaker) this.lastSpeaker = found.speaker;
        // Whoever is talking to the bot is a valid target whether or not they
        // are in render distance. Building the player set from NEARBY_ENTITIES
        // alone meant that once the bot wandered out of range, every command
        // taking a player_name was dropped — so "come to me" could not be
        // chosen precisely when it was needed.
        if (speaker && !world.players.includes(speaker)) world.players.unshift(speaker);

        const usable = enabled.filter((name) => specs[name] && !UNSUPPORTED.has(name) && !SUPPRESSED.has(name) && canFormat(specs[name], world));
        if (!this.announced) {
            const withheld = enabled.filter((n) => UNSUPPORTED.has(n));
            const suppressed = enabled.filter((n) => SUPPRESSED.has(n));
            console.log(`[jev] ${usable.length} commands offered as typed choices` +
                (withheld.length ? `; ${withheld.length} withheld (need generated text): ${withheld.join(' ')}` : '') +
                (suppressed.length ? `; suppressed: ${suppressed.join(' ')}` : ''));
            this.announced = true;
        }
        if (usable.length === 0) return 'No commands are available to me right now.';

        const state = buildState(world, request, turns);
        const questions = buildQuestions(usable, specs, world, request);

        let result;
        try {
            result = await this.client.systemOne({ state, questions });
        } catch (err) {
            console.error('[jev]', err.message);
            return 'My brain disconnected, try again.';
        }

        // A plain reply with no command is how mindcraft is told to stop.
        if (result.answers.satisfied.noul >= 0.6) {
            console.log(`[jev] request satisfied (${result.answers.satisfied.noul.toFixed(2)}) — replying without a command`);
            return 'Done.';
        }

        const picked = result.answers.command.choice;
        const confidence = result.answers.command.confidence;
        const floor = floorFor(picked, this.isAction);
        if (confidence < floor) {
            // Replying without a command ends mindcraft's loop, so the bot
            // stops rather than acting on a guess.
            const ranked = Object.entries(result.answers.command.probabilities)
                .sort((a, b) => b[1] - a[1]).slice(0, 3)
                .map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
            console.log(`[jev] declining: ${picked} at ${confidence.toFixed(2)} is below the ${floor} floor  [${ranked}]`);
            return request
                ? `I'm not sure what you want me to do about that.`
                : 'Standing by.';
        }

        const line = formatCommand(specs[picked], result.answers, world, request);
        console.log(`[jev] ${picked} conf=${confidence.toFixed(2)}/${floor}` +
            ` -> ${line}  (${usable.length} options, ${result.usage.input_tokens} tok)`);
        return line;
    }

    /**
     * Jev returns judgments, not vectors. Configure a separate `embedding` in
     * the profile (or "none") — mindcraft falls back to word-overlap matching.
     */
    async embed() {
        throw new Error('Jev does not produce embeddings; set "embedding": "none" in the profile.');
    }
}

// ---------------------------------------------------------------------------
// Reading the prompt
// ---------------------------------------------------------------------------

/**
 * Mindcraft renders state into the system prompt as labelled line lists
 * (INVENTORY, NEARBY_BLOCKS, NEARBY_ENTITIES). Parsing them back out gives the
 * closed sets the argument questions need: the model can only pick an item the
 * bot actually has, or a block that is actually nearby.
 */
function parseWorld(systemMessage) {
    const text = String(systemMessage || '');
    const section = (label) => {
        const start = text.indexOf(label);
        if (start === -1) return [];
        const rest = text.slice(start + label.length);
        const end = rest.search(/\n\s*\n|\n[A-Z_]{4,}:?\n|\*COMMAND DOCS/);
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
        const name = line.split(':')[0].replace(/\s*\(.*\)$/, '').trim();
        if (/^[a-z_]+$/.test(name)) blocks.add(name);
    }

    const players = [];
    const entities = new Set();
    for (const line of section('NEARBY_ENTITIES')) {
        const p = /^(?:Human|Bot) player:\s*(.+)$/.exec(line);
        if (p) { players.push(p[1].trim()); continue; }
        const name = line.split(':')[0].replace(/\s*\(.*\)$/, '').trim();
        if (/^[a-z_]+$/.test(name)) entities.add(name);
    }

    const position = /Position:\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+)/.exec(text);
    const health = /Health:\s*(\d+)\s*\/\s*(\d+)/.exec(text);
    const hunger = /Hunger:\s*(\d+)\s*\/\s*(\d+)/.exec(text);

    return {
        inventory,
        nearbyPlayers: [...players],
        blocks: [...blocks],
        entities: [...entities],
        players,
        position: position ? { x: +position[1], y: +position[2], z: +position[3] } : null,
        health: health ? Number(health[1]) : null,
        hunger: hunger ? Number(hunger[1]) : null,
        statsText: text.slice(0, text.indexOf('*COMMAND DOCS') === -1 ? 1500 : text.indexOf('*COMMAND DOCS')).slice(-1200),
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
 * The last thing an actual player said.
 *
 * Mindcraft re-prompts after every action finishes, so the most recent turn is
 * usually its own output ("Action output: Collected 1 oak_log."), not a
 * request. Taking the last non-assistant turn therefore asked Jev to choose a
 * command in reply to the bot's own log roughly every other call — which is
 * where the aimless collecting and digging came from. Player messages are
 * formatted "Name: text", so match that.
 */
const PLAYER_LINE = /^\s*([A-Za-z0-9_]{1,16}):\s+(.+)$/s;

function lastUserMessage(turns) {
    for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (!t || t.role === 'assistant' || typeof t.content !== 'string') continue;
        const m = PLAYER_LINE.exec(t.content.trim());
        if (m) return { speaker: m[1], text: m[2].trim() };
    }
    return { speaker: null, text: '' };
}

/**
 * What has happened since, as events rather than as instructions: action
 * results, pathfinding failures, the behaviour log. These are what tell the
 * model a job is already done, or that it is stuck.
 */
function recentEvents(turns, limit = 6) {
    const events = [];
    for (let i = turns.length - 1; i >= 0 && events.length < limit; i--) {
        const t = turns[i];
        if (!t || typeof t.content !== 'string') continue;
        const text = t.content.trim();
        if (!text || PLAYER_LINE.test(text)) continue;
        if (text.startsWith('*COMMAND DOCS') || text.includes('You can use the following commands')) continue;
        if (t.role === 'assistant') { events.push({ bot_did: text.slice(0, 120) }); continue; }
        events.push({ happened: text.replace(/\s+/g, ' ').slice(0, 200) });
    }
    return events.reverse();
}

// ---------------------------------------------------------------------------
// Can this command's arguments be produced at all?
// ---------------------------------------------------------------------------

function paramKind(name, type) {
    if (type === 'ItemName' || type === 'BlockName' || type === 'BlockOrItemName') return 'thing';
    if (name === 'player_name') return 'player';
    if (RANGE_PARAMS.has(name)) return 'range';
    if (type === 'int' || type === 'float') {
        if (['x', 'y', 'z'].includes(name)) return 'coord';
        if (COUNT_PARAMS.has(name)) return 'count';
        return 'count';
    }
    if (type === 'boolean') return 'boolean';
    if (type === 'string') {
        if (name === 'type') return 'thing';            // !attack("zombie"), !searchForEntity
        if (name === 'name') return 'place';
        if (name === 'mode_name') return 'mode';
        if (name === 'direction') return 'direction';
        if (name === 'tool_name' || name === 'target') return 'thing';
        return 'freetext';
    }
    return 'freetext';
}

function canFormat(spec, world) {
    if (!spec) return false;
    for (const [name, meta] of spec.params) {
        const kind = paramKind(name, meta.type);
        if (kind === 'freetext' || kind === 'place' || kind === 'mode') return false;
        if (kind === 'player' && world.players.length === 0) return false;
        if (kind === 'coord' && !world.position) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Building the questions
// ---------------------------------------------------------------------------

function buildState(world, request, turns) {
    return {
        request,
        bot: {
            position: world.position,
            health: world.health,
            hunger: world.hunger,
        },
        inventory: Object.entries(world.inventory).map(([item, count]) => ({ item, count })),
        nearby_blocks: world.blocks.slice(0, 30),
        nearby_entities: world.entities.slice(0, 15),
        nearby_players: world.players,
        recent_events: recentEvents(turns),
    };
}

/** The closed set of things an item/block argument may name. */
function thingCriteria(world) {
    const criteria = {};
    for (const [item, count] of Object.entries(world.inventory)) {
        criteria[item] = `The ${item} the bot is carrying (${count}).`;
    }
    for (const block of world.blocks) {
        if (!criteria[block]) criteria[block] = `The block ${block}, present nearby.`;
    }
    for (const entity of world.entities) {
        if (!criteria[entity]) criteria[entity] = `The creature ${entity}, nearby.`;
    }
    for (const [name, description] of Object.entries(COMMON_MATERIALS)) {
        if (!criteria[name]) criteria[name] = `${description} Not in sight, so it would have to be found.`;
    }
    if (Object.keys(criteria).length === 0) criteria.none = 'Nothing suitable is available.';
    return criteria;
}

function buildQuestions(usable, specs, world, request) {
    const criteria = {};
    for (const name of usable) {
        const spec = specs[name];
        const args = spec.params.length
            ? ` Takes: ${spec.params.map(([p, m]) => `${p} (${m.type})`).join(', ')}.`
            : '';
        criteria[name] = `${spec.description}${args}`;
    }

    const questions = {
        // Mindcraft ends its loop when a reply contains no command. Without a
        // way to say "done", the adapter emitted a command every single turn
        // and the agent repeated !lookAtPlayer forever.
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
    // command actually takes.
    const things = thingCriteria(world);
    if (Object.keys(things).length > 1) {
        questions.thing = choice(
            `Assume the command the bot runs needs to name an item, block or creature. ` +
            `Which one does "${request}" refer to?`,
            things,
        );
    }
    if (world.players.length) {
        const players = {};
        for (const p of world.players) {
            players[p] = world.nearbyPlayers && world.nearbyPlayers.includes(p)
                ? `The player named ${p}, currently nearby.`
                : `The player named ${p}, who is talking to the bot but is not in sight — the bot would have to travel to reach them.`;
        }
        questions.player = choice(
            `Assume the command names a player. Which player does "${request}" mean? The speaker is usually the answer.`,
            players,
        );
    }
    questions.amount = choice(
        `Assume the command takes a quantity. How many does "${request}" ask for?`,
        AMOUNTS,
    );
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

function formatCommand(spec, answers, world, request) {
    if (!spec.params.length) return spec.name;

    const coords = explicitCoords(request);
    const args = [];
    for (const [name, meta] of spec.params) {
        const kind = paramKind(name, meta.type);
        switch (kind) {
            case 'thing': {
                const named = literalThing(request, answers.thing ? answers.thing.probabilities : {});
                const value = named
                    || (answers.thing && answers.thing.choice !== 'none' ? answers.thing.choice : null)
                    || Object.keys(world.inventory)[0] || world.blocks[0] || 'dirt';
                args.push(JSON.stringify(value));
                break;
            }
            case 'player':
                args.push(JSON.stringify(answers.player ? answers.player.choice : world.players[0]));
                break;
            case 'coord':
                args.push(coords ? coords[name] : Math.round(world.position ? world.position[name] : 0));
                break;
            case 'range':
                args.push(DEFAULT_RANGE[name] ?? 8);
                break;
            case 'boolean':
                args.push(true);
                break;
            case 'count':
            default: {
                const n = explicitCount(request) ?? AMOUNT_VALUES[answers.amount ? answers.amount.choice : 'a_few'];
                args.push(n);
                break;
            }
        }
    }
    return `${spec.name}(${args.join(', ')})`;
}
