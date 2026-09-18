// Replay captured prompts through the Jev adapter and print each decision.
//
//   JEV_DUMP=/tmp/jev.jsonl node main.js          # capture, while playing
//   node src/models/jev_replay.js /tmp/jev.jsonl  # replay, with TYPESAFE_API_KEY set
//
// Each line of the dump is {at, systemMessage, turns}. The replay constructs
// one adapter and feeds the records in order, so remembered state (the current
// task, the speaker) carries across records the way it does live. Run from the
// repository root so the command list and block registry can be imported.

import { readFileSync } from 'fs';
import { Jev } from './jev.js';

const [, , path, ...rest] = process.argv;
if (!path) {
    console.error('usage: node src/models/jev_replay.js <dump.jsonl> [--limit N] [--grep text]');
    process.exit(2);
}
const limit = rest.includes('--limit') ? Number(rest[rest.indexOf('--limit') + 1]) : Infinity;
const grep = rest.includes('--grep') ? rest[rest.indexOf('--grep') + 1] : null;

const records = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const jev = new Jev();
let n = 0;
for (const rec of records) {
    if (n >= limit) break;
    const lastPlayer = [...rec.turns].reverse().find((t) => t.role === 'user');
    if (grep && !(lastPlayer?.content || '').includes(grep)) continue;
    n += 1;
    console.log(`\n=== ${rec.at || ''}  ${lastPlayer ? lastPlayer.content.slice(0, 100) : '(no player turn)'}`);
    const started = Date.now();
    const reply = await jev.sendRequest(rec.turns, rec.systemMessage);
    console.log(`--> ${JSON.stringify(reply)}  (${Date.now() - started} ms)`);
}
