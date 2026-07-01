// ──────────────────────────────────────────────
// Server-side stop-sequence enforcement
// ──────────────────────────────────────────────
//
// The Agent SDK has no stop-sequence option (Marinara silently drops the
// `stop` array — a real regression for roleplay, where "\n{{user}}:" stop
// strings are the standard guard against the model impersonating the user).
// We enforce them here by scanning the visible-text stream: hold back a tail
// window shorter than the longest stop string so matches spanning chunk
// boundaries are caught, truncate at the first match, and let the caller
// abort the SDK query.

export class StopScanner {
    #stops;
    #holdback;
    #buffer = '';
    #done = false;

    /** @param {string[]} stops */
    constructor(stops) {
        this.#stops = (stops ?? []).filter((s) => typeof s === 'string' && s.length > 0);
        this.#holdback = this.#stops.length
            ? Math.max(...this.#stops.map((s) => s.length)) - 1
            : 0;
    }

    get active() {
        return this.#stops.length > 0;
    }

    /**
     * Feed a text delta. Returns { emit, matched }:
     *  - emit: text safe to forward downstream now
     *  - matched: true when a stop sequence fired (emit contains the final
     *    text up to — excluding — the stop string; feed no more after this)
     */
    feed(text) {
        if (this.#done) return { emit: '', matched: true };
        if (!this.active) return { emit: text, matched: false };

        this.#buffer += text;

        let earliest = -1;
        for (const stop of this.#stops) {
            const idx = this.#buffer.indexOf(stop);
            if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
        }

        if (earliest !== -1) {
            this.#done = true;
            const emit = this.#buffer.slice(0, earliest);
            this.#buffer = '';
            return { emit, matched: true };
        }

        if (this.#buffer.length > this.#holdback) {
            const emit = this.#buffer.slice(0, this.#buffer.length - this.#holdback);
            this.#buffer = this.#buffer.slice(this.#buffer.length - this.#holdback);
            return { emit, matched: false };
        }

        return { emit: '', matched: false };
    }

    /** Flush the held-back tail at end of stream (no stop ever matched). */
    flush() {
        if (this.#done) return '';
        const rest = this.#buffer;
        this.#buffer = '';
        return rest;
    }
}
