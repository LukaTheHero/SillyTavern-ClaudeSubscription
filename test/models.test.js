import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CANONICAL_TIER_MODELS,
    CLAUDE_SUBSCRIPTION_MODELS,
    isAdaptiveOnlyModel,
    parseModelRequest,
    listModelsHandler,
} from '../lib/models.js';

test('CANONICAL_TIER_MODELS pins flagship models for each tier', () => {
    assert.equal(CANONICAL_TIER_MODELS.fable, 'claude-fable-5-1');
    assert.equal(CANONICAL_TIER_MODELS.opus, 'claude-opus-5');
    assert.equal(CANONICAL_TIER_MODELS.sonnet, 'claude-sonnet-4-6');
    assert.equal(CANONICAL_TIER_MODELS.haiku, 'claude-haiku-4-5');
});

test('CLAUDE_SUBSCRIPTION_MODELS contains Claude Fable 5.1 and Claude Opus 5', () => {
    const fable51 = CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === 'claude-fable-5-1');
    assert.ok(fable51, 'claude-fable-5-1 should exist in catalog');
    assert.equal(fable51.name, 'Claude Fable 5.1');
    assert.equal(fable51.tier, 'fable');
    assert.equal(fable51.oneM, true);
    assert.equal(fable51.adaptiveOnly, true);
    assert.equal(fable51.context, 200000);

    const opus5 = CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === 'claude-opus-5');
    assert.ok(opus5, 'claude-opus-5 should exist in catalog');
    assert.equal(opus5.name, 'Claude Opus 5');
    assert.equal(opus5.tier, 'opus');
    assert.equal(opus5.oneM, true);
    assert.equal(opus5.adaptiveOnly, true);
    assert.equal(opus5.context, 200000);

    // Existing models preserved
    assert.ok(CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === 'claude-fable-5'));
    assert.ok(CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === 'claude-opus-4-8'));
    assert.ok(CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === 'claude-opus-4-7'));
    assert.ok(CLAUDE_SUBSCRIPTION_MODELS.find((m) => m.id === 'claude-opus-4-6'));
});

test('listModelsHandler exposes base and 1M variants for Fable 5.1 and Opus 5', () => {
    let responseData = null;
    const mockRes = {
        json(payload) {
            responseData = payload;
        },
    };

    listModelsHandler({}, mockRes);
    assert.ok(responseData && Array.isArray(responseData.data));

    const ids = responseData.data.map((m) => m.id);
    assert.ok(ids.includes('claude-fable-5-1'));
    assert.ok(ids.includes('claude-fable-5-1[1m]'));
    assert.ok(ids.includes('claude-opus-5'));
    assert.ok(ids.includes('claude-opus-5[1m]'));

    const fable1m = responseData.data.find((m) => m.id === 'claude-fable-5-1[1m]');
    assert.equal(fable1m.display_name, 'Claude Fable 5.1 (1M context)');
    assert.equal(fable1m.context_window, 1000000);

    const opus1m = responseData.data.find((m) => m.id === 'claude-opus-5[1m]');
    assert.equal(opus1m.display_name, 'Claude Opus 5 (1M context)');
    assert.equal(opus1m.context_window, 1000000);
});

test('parseModelRequest correctly handles base and 1M requests for Claude Fable 5.1', () => {
    const base = parseModelRequest('claude-fable-5-1');
    assert.equal(base.baseId, 'claude-fable-5-1');
    assert.equal(base.tier, 'fable');
    assert.equal(base.oneM, false);
    assert.equal(base.sdkModel, 'claude-fable-5-1');
    assert.equal(base.adaptiveOnly, true);
    assert.equal(base.envPins.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5-1');
    assert.equal(base.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');

    const oneM = parseModelRequest('claude-fable-5-1[1m]');
    assert.equal(oneM.baseId, 'claude-fable-5-1');
    assert.equal(oneM.tier, 'fable');
    assert.equal(oneM.oneM, true);
    assert.equal(oneM.sdkModel, 'fable[1m]');
    assert.equal(oneM.adaptiveOnly, true);
    assert.equal(oneM.envPins.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5-1');
});

test('parseModelRequest correctly handles base and 1M requests for Claude Opus 5', () => {
    const base = parseModelRequest('claude-opus-5');
    assert.equal(base.baseId, 'claude-opus-5');
    assert.equal(base.tier, 'opus');
    assert.equal(base.oneM, false);
    assert.equal(base.sdkModel, 'claude-opus-5');
    assert.equal(base.adaptiveOnly, true);
    assert.equal(base.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
    assert.equal(base.envPins.ANTHROPIC_DEFAULT_FABLE_MODEL, 'claude-fable-5-1');

    const oneM = parseModelRequest('claude-opus-5[1m]');
    assert.equal(oneM.baseId, 'claude-opus-5');
    assert.equal(oneM.tier, 'opus');
    assert.equal(oneM.oneM, true);
    assert.equal(oneM.sdkModel, 'opus[1m]');
    assert.equal(oneM.adaptiveOnly, true);
    assert.equal(oneM.envPins.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5');
});

test('parseModelRequest normalizes dot-separated model requests', () => {
    const parsedDot = parseModelRequest('claude-fable-5.1');
    assert.equal(parsedDot.baseId, 'claude-fable-5-1');
    assert.equal(parsedDot.tier, 'fable');
    assert.equal(parsedDot.sdkModel, 'claude-fable-5-1');

    const parsedDot1m = parseModelRequest('claude-fable-5.1[1m]');
    assert.equal(parsedDot1m.baseId, 'claude-fable-5-1');
    assert.equal(parsedDot1m.tier, 'fable');
    assert.equal(parsedDot1m.oneM, true);
    assert.equal(parsedDot1m.sdkModel, 'fable[1m]');
});

test('isAdaptiveOnlyModel identifies adaptive-only model families', () => {
    // Fable family
    assert.equal(isAdaptiveOnlyModel('claude-fable-5-1'), true);
    assert.equal(isAdaptiveOnlyModel('claude-fable-5'), true);
    assert.equal(isAdaptiveOnlyModel('claude-fable-5.1'), true);
    assert.equal(isAdaptiveOnlyModel('fable-future-variant'), true);

    // Opus family
    assert.equal(isAdaptiveOnlyModel('claude-opus-5'), true);
    assert.equal(isAdaptiveOnlyModel('claude-opus-5-1'), true);
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-8'), true);
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-7'), true);
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-6'), false);
    assert.equal(isAdaptiveOnlyModel('claude-opus-4-5'), false);

    // Other families
    assert.equal(isAdaptiveOnlyModel('claude-sonnet-4-6'), false);
    assert.equal(isAdaptiveOnlyModel('claude-haiku-4-5'), false);
});

test('Package versions match across package.json and manifest.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'manifest.json'), 'utf8'));

    assert.equal(pkg.version, '2.2.0');
    assert.equal(manifest.version, '2.2.0');
});

test('handleStatus returns current version 2.2.0', async () => {
    const { handleStatus } = await import('../lib/status.js');
    let responseData = null;
    const mockRes = {
        json(payload) {
            responseData = payload;
        },
        status(code) {
            return {
                json(payload) {
                    responseData = { statusCode: code, ...payload };
                },
            };
        },
    };
    await handleStatus({}, mockRes);
    assert.ok(responseData);
    assert.equal(responseData.version, '2.2.0');
    assert.equal(responseData.plugin, 'claude-subscription');
});
