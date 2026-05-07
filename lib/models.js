// ──────────────────────────────────────────────
// Curated Claude Subscription model list
// ──────────────────────────────────────────────
//
// Mirrors CLAUDE_SUBSCRIPTION_MODELS in Marinara's shared/constants/model-lists.ts.
// Anthropic gates which model IDs are reachable per Pro/Max plan tier; the
// SDK surfaces a clear error if the signed-in plan can't run the requested
// model. List is restricted to currently tool-eligible families to avoid
// offering retired aliases the subscription path no longer accepts.

export const CLAUDE_SUBSCRIPTION_MODELS = [
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', context: 1000000, maxOutput: 128000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context: 1000000, maxOutput: 32000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context: 1000000, maxOutput: 32000 },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', context: 1000000, maxOutput: 32000 },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', context: 1000000, maxOutput: 16000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', context: 200000, maxOutput: 8192 },
];

export function listModelsHandler(_req, res) {
    res.json({
        object: 'list',
        data: CLAUDE_SUBSCRIPTION_MODELS.map((m) => ({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: 'anthropic',
        })),
    });
}
