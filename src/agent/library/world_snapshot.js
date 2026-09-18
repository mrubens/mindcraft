import * as world from './world.js';
import * as mc from '../../utils/mcdata.js';

/**
 * A structured snapshot of what the bot can observe right now, for model
 * adapters that consume state as data rather than as prose. Exposed to prompts
 * through the `$WORLD_JSON` placeholder. Every section is computed
 * independently and a failure in one leaves the others intact.
 */

const round1 = (n) => Math.round(n * 10) / 10;

function attempt(label, fn, fallback = null) {
    try {
        return fn();
    } catch (err) {
        console.warn(`world snapshot: ${label} unavailable: ${err?.message || err}`);
        return fallback;
    }
}

function timeOfDay(bot) {
    const t = bot.time?.timeOfDay;
    if (typeof t !== 'number') return null;
    if (t < 6000) return 'morning';
    if (t < 12000) return 'afternoon';
    return 'night';
}

function weather(bot) {
    if (bot.thunderState > 0) return 'thunderstorm';
    if (bot.rainState > 0) return 'rain';
    return 'clear';
}

function equipment(bot) {
    const slot = (i) => bot.inventory.slots[i]?.name || null;
    return {
        head: slot(5),
        torso: slot(6),
        legs: slot(7),
        feet: slot(8),
        hand: bot.heldItem?.name || null,
    };
}

/** Nearby block types, each with how many were seen and how close the nearest is. */
function nearbyBlocks(bot, distance = 16, limit = 30) {
    const here = bot.entity.position;
    const byType = new Map();
    for (const block of world.getNearestBlocks(bot, null, distance)) {
        const d = block.position.distanceTo(here);
        const entry = byType.get(block.name) || { type: block.name, count: 0, distance: Infinity };
        entry.count += 1;
        if (d < entry.distance) entry.distance = d;
        byType.set(block.name, entry);
    }
    return [...byType.values()]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map((e) => ({ type: e.type, count: e.count, distance: round1(e.distance) }));
}

/** Nearby creatures grouped by type, plus villagers individually (they are addressed by id). */
function nearbyEntities(bot, distance = 24, limit = 15) {
    const here = bot.entity.position;
    const byType = new Map();
    const villagers = [];
    for (const entity of world.getNearbyEntities(bot, distance)) {
        if (entity.type === 'player' || entity.name === 'item' || !entity.name) continue;
        const d = entity.position.distanceTo(here);
        const entry = byType.get(entity.name) || {
            type: entity.name, count: 0, distance: Infinity,
            hostile: mc.isHostile(entity), huntable: mc.isHuntable(entity),
        };
        entry.count += 1;
        if (d < entry.distance) entry.distance = d;
        byType.set(entity.name, entry);
        if (entity.name === 'villager') {
            const baby = !!(entity.metadata && entity.metadata[16] === 1);
            villagers.push({
                id: entity.id,
                profession: baby ? null : world.getVillagerProfession(entity),
                baby,
                distance: round1(d),
            });
        }
    }
    const entities = [...byType.values()]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map((e) => ({ ...e, distance: round1(e.distance) }));
    return { entities, villagers };
}

function nearbyPlayers(bot, distance = 64) {
    const here = bot.entity.position;
    return world.getNearbyPlayers(bot, distance)
        .filter((p) => p.username)
        .map((p) => ({ name: p.username, distance: round1(p.position.distanceTo(here)) }));
}

export function buildWorldSnapshot(agent) {
    const bot = agent.bot;
    if (!bot || !bot.entity) return { v: 1, error: 'bot has not spawned' };
    const pos = bot.entity.position;
    const { entities, villagers } = attempt('entities', () => nearbyEntities(bot), { entities: [], villagers: [] });
    return {
        v: 1,
        bot: {
            name: agent.name,
            position: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            gamemode: bot.game?.gameMode || null,
            biome: attempt('biome', () => world.getBiomeName(bot)),
            time_of_day: timeOfDay(bot),
            weather: weather(bot),
            current_action: agent.isIdle() ? 'idle' : (agent.actions?.currentActionLabel || 'busy'),
            modes: attempt('modes', () => bot.modes?.getJson?.() ?? null),
        },
        inventory: attempt('inventory', () =>
            Object.entries(world.getInventoryCounts(bot)).map(([item, count]) => ({ item, count })), []),
        equipment: attempt('equipment', () => equipment(bot), {}),
        craftable: attempt('craftable', () => world.getCraftableItems(bot), []),
        nearby_blocks: attempt('blocks', () => nearbyBlocks(bot), []),
        nearby_entities: entities,
        villagers,
        nearby_players: attempt('players', () => nearbyPlayers(bot), []),
    };
}
