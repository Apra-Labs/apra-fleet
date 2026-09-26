// Parity test: pins apra-fleet-client's hand-maintained JSDoc typedefs in
// api.mjs against the server-side zod schemas (register_member, update_member)
// and the member_detail result shape they claim to mirror.
//
// The typedefs have no compile-time link to the server tools -- see
// apra-fleet-7dir.1.5 -- so this test reads the real source files (never a
// copied fixture) and textually parses:
//   - api.mjs: the JSDoc @typedef blocks for RegisterMemberOptions,
//     UpdateMemberOptions and MemberDetailResult, via a @property regex.
//   - register-member.ts / update-member.ts: the top-level keys of the
//     registerMemberSchema / updateMemberSchema z.object({...}) literals,
//     found by matching lines indented exactly two spaces inside the object
//     block (nested object literals such as model_tiers's {cheap, standard,
//     premium} sit at four spaces and are deliberately excluded).
//   - resolve-member.ts: the memberIdentifier fragment spread into
//     updateMemberSchema via `...memberIdentifier`, parsed the same way.
//   - member-detail.ts: member_detail has no zod schema for its JSON RESULT
//     shape (memberDetailSchema covers only the `format` input flag) -- the
//     result object is built imperatively, so this file's `result.xxx = `
//     assignments plus the initial `const result: Record<string, unknown> =
//     {...}` literal are parsed as the ground truth for MemberDetailResult.
//
// Both directions are asserted for each pair: a schema/result field with no
// typedef property fails, and a typedef property no schema/result field
// accepts fails. Writes nothing outside process memory; reads only.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const apiMjsSrc = readFileSync(path.join(__dirname, '..', 'src', 'client', 'api.mjs'), 'utf8');
const registerMemberSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'register-member.ts'), 'utf8');
const updateMemberSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'update-member.ts'), 'utf8');
const resolveMemberSrc = readFileSync(path.join(repoRoot, 'src', 'utils', 'resolve-member.ts'), 'utf8');
const memberDetailSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'member-detail.ts'), 'utf8');

/** Extract the text between a start marker (exclusive) and the next occurrence of an end marker. */
function extractBlock(source, startMarker, endMarker) {
    const startIdx = source.indexOf(startMarker);
    assert.notStrictEqual(startIdx, -1, `marker not found in source: ${startMarker}`);
    const contentStart = startIdx + startMarker.length;
    const endIdx = source.indexOf(endMarker, contentStart);
    assert.notStrictEqual(endIdx, -1, `end marker not found after ${startMarker}: ${endMarker}`);
    return source.slice(contentStart, endIdx);
}

/**
 * Property names of `@property {type} name - desc` / `@property {type} [name] - desc`
 * lines inside a JSDoc @typedef {Object} <name> block. The {type} portion is scanned
 * with a balanced-brace walk (not a `{[^}]*}` regex) because several properties here
 * use nested-brace object types, e.g. `{{cheap?: string, standard?: string}}` for
 * model_tiers, which a single-level regex mis-terminates at the first inner `}`.
 */
function extractTypedefProperties(source, typedefName) {
    const startMarker = `@typedef {Object} ${typedefName}`;
    const startIdx = source.indexOf(startMarker);
    assert.notStrictEqual(startIdx, -1, `typedef not found: ${typedefName}`);
    const blockEnd = source.indexOf('*/', startIdx);
    assert.notStrictEqual(blockEnd, -1, `closing */ not found for typedef: ${typedefName}`);
    const block = source.slice(startIdx, blockEnd);
    const props = new Set();
    let searchFrom = 0;
    for (;;) {
        const propIdx = block.indexOf('@property', searchFrom);
        if (propIdx === -1) break;
        let j = propIdx + '@property'.length;
        while (/\s/.test(block[j])) j++;
        assert.strictEqual(block[j], '{', `expected '{' after @property at offset ${propIdx} in ${typedefName}`);
        let depth = 0;
        do {
            if (block[j] === '{') depth++;
            else if (block[j] === '}') depth--;
            j++;
        } while (depth > 0);
        while (/\s/.test(block[j])) j++;
        if (block[j] === '[') j++;
        const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(block.slice(j));
        assert.ok(nameMatch, `could not parse property name for ${typedefName} near offset ${j}`);
        props.add(nameMatch[0]);
        searchFrom = j;
    }
    return props;
}

/**
 * Keys found on lines indented with exactly `indent` spaces, e.g. `  key: value,`
 * or the shorthand-property form `  key,` (used for `os` in member-detail.ts's
 * result literal). Deliberately ignores deeper-nested keys (sub-objects).
 */
function extractTopLevelKeys(block, indent) {
    const keys = new Set();
    const re = new RegExp(`^ {${indent}}([a-zA-Z_][a-zA-Z0-9_]*)\\s*[:,]`, 'gm');
    let m;
    while ((m = re.exec(block))) {
        keys.add(m[1]);
    }
    return keys;
}

/** Names spread into an object literal via `...name` on their own line. */
function extractSpreadNames(block) {
    const names = [];
    const re = /^\s*\.\.\.(\w+)/gm;
    let m;
    while ((m = re.exec(block))) {
        names.push(m[1]);
    }
    return names;
}

function registerMemberSchemaFields() {
    const block = extractBlock(registerMemberSrc, 'export const registerMemberSchema = z.object({', '\n});');
    return extractTopLevelKeys(block, 2);
}

function memberIdentifierFields() {
    const block = extractBlock(resolveMemberSrc, 'export const memberIdentifier = {', '\n};');
    return extractTopLevelKeys(block, 2);
}

function updateMemberSchemaFields() {
    const block = extractBlock(updateMemberSrc, 'export const updateMemberSchema = z.object({', '\n});');
    const fields = extractTopLevelKeys(block, 2);
    for (const spreadName of extractSpreadNames(block)) {
        if (spreadName === 'memberIdentifier') {
            for (const f of memberIdentifierFields()) fields.add(f);
        } else {
            assert.fail(`unhandled spread in updateMemberSchema: ...${spreadName} -- extend this test to resolve it`);
        }
    }
    return fields;
}

/** member_detail's json-format result object has no zod schema for its RESULT
 * shape (only the `format` input flag is validated) -- ground truth is the
 * imperative construction in member-detail.ts. */
function memberDetailResultFields() {
    const initialBlock = extractBlock(
        memberDetailSrc,
        'const result: Record<string, unknown> = {',
        '\n  };',
    );
    const fields = extractTopLevelKeys(initialBlock, 4);
    const assignRe = /result\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/g;
    let m;
    while ((m = assignRe.exec(memberDetailSrc))) {
        fields.add(m[1]);
    }
    return fields;
}

function assertFieldParity(label, schemaFields, typedefFields) {
    const missingFromTypedef = [...schemaFields].filter((f) => !typedefFields.has(f)).sort();
    const extraInTypedef = [...typedefFields].filter((f) => !schemaFields.has(f)).sort();

    assert.deepStrictEqual(
        missingFromTypedef,
        [],
        `${label}: fields present on the server but missing from the client typedef: ${missingFromTypedef.join(', ')}`,
    );
    assert.deepStrictEqual(
        extraInTypedef,
        [],
        `${label}: typedef properties the server construct does not accept: ${extraInTypedef.join(', ')}`,
    );
}

describe('apra-fleet-client typedef vs server zod schema parity', () => {
    test('RegisterMemberOptions matches registerMemberSchema field-for-field', () => {
        const schemaFields = registerMemberSchemaFields();
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'RegisterMemberOptions');

        // Sanity: these parsers must find a non-trivial number of fields, or a
        // marker drifted and the diff below would be vacuously "empty vs empty".
        assert.ok(schemaFields.size > 10, `expected many registerMemberSchema fields, parsed ${schemaFields.size}`);
        assert.ok(typedefFields.size > 10, `expected many RegisterMemberOptions properties, parsed ${typedefFields.size}`);

        // shell must be part of both sets: removing it from either side must fail this test.
        assert.ok(schemaFields.has('shell'), 'sanity: registerMemberSchema should declare shell');
        assert.ok(typedefFields.has('shell'), 'sanity: RegisterMemberOptions should declare shell');

        assertFieldParity('RegisterMemberOptions vs registerMemberSchema', schemaFields, typedefFields);
    });

    test('UpdateMemberOptions matches updateMemberSchema field-for-field', () => {
        const schemaFields = updateMemberSchemaFields();
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'UpdateMemberOptions');

        assert.ok(schemaFields.size > 10, `expected many updateMemberSchema fields, parsed ${schemaFields.size}`);
        assert.ok(typedefFields.size > 10, `expected many UpdateMemberOptions properties, parsed ${typedefFields.size}`);

        assert.ok(schemaFields.has('shell'), 'sanity: updateMemberSchema should declare shell');
        assert.ok(typedefFields.has('shell'), 'sanity: UpdateMemberOptions should declare shell');

        assertFieldParity('UpdateMemberOptions vs updateMemberSchema', schemaFields, typedefFields);
    });

    test('MemberDetailResult matches the json-format result object member-detail.ts builds', () => {
        const resultFields = memberDetailResultFields();
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'MemberDetailResult');

        assert.ok(resultFields.size > 5, `expected several member-detail.ts result fields, parsed ${resultFields.size}`);
        assert.ok(typedefFields.size > 5, `expected several MemberDetailResult properties, parsed ${typedefFields.size}`);

        assert.ok(resultFields.has('shell'), 'sanity: member-detail.ts result should assign shell');
        assert.ok(typedefFields.has('shell'), 'sanity: MemberDetailResult should declare shell');

        assertFieldParity('MemberDetailResult vs member-detail.ts result object', resultFields, typedefFields);
    });
});
