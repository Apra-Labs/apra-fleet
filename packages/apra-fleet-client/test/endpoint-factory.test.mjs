import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

// Imports through the PACKAGE NAME (not a relative path), proving the
// './endpoint' subpath actually resolves from a package consumer.
import { makeEndpointApi } from '@apralabs/apra-fleet-client/endpoint';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';

const ENDPOINT_DIR = fileURLToPath(new URL('../src/endpoint/', import.meta.url));

test('makeEndpointApi - returns the three-method FleetApi surface for an openai config', () => {
    const api = makeEndpointApi({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-test'
    });

    assert.strictEqual(typeof api.executePrompt, 'function');
    assert.strictEqual(typeof api.executeCommand, 'function');
    assert.strictEqual(typeof api.getMemberModelPricing, 'function');
});

test('makeEndpointApi - returns the three-method FleetApi surface for an anthropic config', () => {
    const api = makeEndpointApi({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-test'
    });

    assert.strictEqual(typeof api.executePrompt, 'function');
    assert.strictEqual(typeof api.executeCommand, 'function');
    assert.strictEqual(typeof api.getMemberModelPricing, 'function');
});

test('makeEndpointApi - unrecognized provider is a construction-time TypeError', () => {
    assert.throws(
        () => makeEndpointApi({ provider: 'not-a-provider', baseUrl: 'x', apiKey: 'x', model: 'x' }),
        TypeError
    );
});

test('makeEndpointApi - prototype-chain provider names are a construction-time TypeError, not a broken FleetApi', () => {
    for (const provider of ['constructor', 'toString', 'hasOwnProperty']) {
        assert.throws(
            () => makeEndpointApi({ provider, baseUrl: 'x', apiKey: 'x', model: 'x' }),
            TypeError,
            `provider: ${provider} should throw TypeError`
        );
    }
});

test('makeEndpointApi - the returned object is accepted by new FleetWorkflow()', () => {
    const api = makeEndpointApi({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-test'
    });

    const workflow = new FleetWorkflow(api);

    assert.strictEqual(workflow.fleetApi, api);
});

test('endpoint module source never reads process.env', () => {
    // Assert, don't just intend: strip comments out of every source file
    // under src/endpoint/ and confirm none of the remaining executable code
    // references process.env. A raw substring check on the whole file would
    // false-positive on the doc comments that already describe this
    // constraint, so comments are removed first.
    const files = readdirSync(ENDPOINT_DIR).filter((name) => name.endsWith('.mjs'));
    assert.ok(files.length > 0, 'expected at least one source file under src/endpoint/');

    for (const file of files) {
        const source = readFileSync(new URL(file, `file://${ENDPOINT_DIR}`), 'utf8');
        const withoutComments = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        assert.ok(
            !withoutComments.includes('process.env'),
            `${file} must never read process.env directly; config is always injected by the caller`
        );
    }
});
