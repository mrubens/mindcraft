// Minimal TypeSafe System One client.
//
// The official @typesafe-ai/sdk requires Node 20; this talks to
// POST /v1/systemone over plain fetch so the adapter has no extra dependency
// and works wherever mindcraft itself runs. Request and response shapes mirror
// the SDK's types exactly.

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export class TypeSafeError extends Error {
    constructor(message, { status, requestId } = {}) {
        super(message);
        this.name = 'TypeSafeError';
        this.status = status;
        this.requestId = requestId;
    }
}

/** A question that selects one label from a described set. */
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
/** A yes/no question returning a probability. */
export const noul = (instructions, criteria = null) => ({ type: 'noul', instructions, criteria });
/** A question that places its answer on an ordered rubric. */
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });

export class TypeSafeClient {
    constructor({ apiKey, baseURL, model = 'jev-latest', timeout = 15000, maxRetries = 2 } = {}) {
        this.apiKey = apiKey || process.env.TYPESAFE_API_KEY;
        this.baseURL = baseURL || process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL;
        this.model = model;
        this.timeout = timeout;
        this.maxRetries = maxRetries;
    }

    /**
     * Ask a batch of questions about one state. Every question is answered
     * independently and in parallel server-side, so speculative questions cost
     * tokens but no extra round trip.
     */
    async systemOne({ state, questions, model = this.model }) {
        if (!this.apiKey) {
            throw new TypeSafeError('No TypeSafe API key. Set TYPESAFE_API_KEY, or add TYPESAFE_API_KEY to keys.json.');
        }
        const body = JSON.stringify({ state, questions, model });
        let lastErr;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) {
                const backoff = Math.min(500 * 2 ** (attempt - 1), 5000);
                await new Promise((r) => setTimeout(r, backoff * (1 - Math.random() * 0.25)));
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeout);
            try {
                const res = await fetch(`${this.baseURL}/v1/systemone`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body,
                    signal: controller.signal,
                });
                const requestId = res.headers.get('x-request-id') || undefined;
                const text = await res.text();
                if (!res.ok) {
                    const err = new TypeSafeError(`TypeSafe ${res.status}: ${text.slice(0, 400)}`, { status: res.status, requestId });
                    if (RETRY_STATUSES.has(res.status) && attempt < this.maxRetries) { lastErr = err; continue; }
                    throw err;
                }
                return JSON.parse(text);
            } catch (err) {
                if (err instanceof TypeSafeError && !RETRY_STATUSES.has(err.status)) throw err;
                lastErr = err;
                if (attempt >= this.maxRetries) throw err;
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastErr;
    }
}
