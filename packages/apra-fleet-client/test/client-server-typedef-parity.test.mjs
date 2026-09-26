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
const credentialStoreSetSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'credential-store-set.ts'), 'utf8');
const memberGitStatusSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'member-git-status.ts'), 'utf8');
const memberOwnerSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'member-owner.ts'), 'utf8');
const memberReservationSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'member-reservation.ts'), 'utf8');
const listMembersSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'list-members.ts'), 'utf8');

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

/**
 * member_reservation's INPUT schema (apra-fleet-ecjf.4.2). Like
 * updateMemberSchema it spreads `...memberIdentifier`, so the same resolution
 * path is reused rather than adding a second one -- extractSpreadNames's
 * assert.fail on an unhandled spread is what forces that.
 */
function memberReservationSchemaFields() {
    const block = extractBlock(memberReservationSrc, 'export const memberReservationSchema = z.object({', '\n});');
    const fields = extractTopLevelKeys(block, 2);
    for (const spreadName of extractSpreadNames(block)) {
        if (spreadName === 'memberIdentifier') {
            for (const f of memberIdentifierFields()) fields.add(f);
        } else {
            assert.fail(`unhandled spread in memberReservationSchema: ...${spreadName} -- extend this test to resolve it`);
        }
    }
    return fields;
}

/**
 * Field names declared on a TS `interface Name { field: type; ... }` block
 * (apra-fleet-972p.2.2: `CredentialStoreSetUrlResult` in credential-store-
 * set.ts has no zod schema -- it is a plain result interface, not an input).
 * Only top-level (2-space indented) `name: type;` / `name?: type;` members
 * are collected; an index signature (`[key: string]: unknown;`) is
 * deliberately excluded since it carries no fixed field name to pin.
 */
function extractInterfaceFields(source, interfaceName) {
    // Most interfaces pinned by this test are exported, but apra-fleet-g6ap.6:
    // MemberOwnerFields (member-owner.ts) is a module-private interface -- it
    // has no `export` keyword since it is only used internally there (the
    // exported MemberOwnerStructured extends it). Try the exported marker
    // first and fall back to the unexported form rather than requiring every
    // interface pinned here to be exported.
    const exportedMarker = `export interface ${interfaceName} {`;
    const marker = source.includes(exportedMarker) ? exportedMarker : `interface ${interfaceName} {`;
    const block = extractBlock(source, marker, '\n}');
    const fields = new Set();
    const re = /^  ([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/gm;
    let m;
    while ((m = re.exec(block))) {
        fields.add(m[1]);
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

/** list_members's "json"-format `members` array entries have no zod schema of their own
 * (list_members has no INPUT schema fields for its result shape either) -- ground truth is
 * the imperative object literal built by `members: agents.map((a, i) => ({ ... })),` in
 * list-members.ts. */
function listMembersMemberFields() {
    const block = extractBlock(
        listMembersSrc,
        'members: agents.map((a, i) => ({',
        '\n      })),',
    );
    return extractTopLevelKeys(block, 8);
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

    // Pins the client's ListedMember typedef (the "json"-format `members` array entry
    // shape list_members returns) against the object literal list-members.ts builds --
    // including `reservation`, the structured view alongside the legacy `reservedBy`
    // string, so a future field added there can no longer land without the client
    // declaring it too.
    test('ListedMember matches the json-format member object list-members.ts builds', () => {
        const resultFields = listMembersMemberFields();
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'ListedMember');

        assert.ok(resultFields.size > 5, `expected several list-members.ts member fields, parsed ${resultFields.size}`);
        assert.ok(typedefFields.size > 5, `expected several ListedMember properties, parsed ${typedefFields.size}`);

        assert.ok(resultFields.has('reservation'), 'sanity: list-members.ts member object should assign reservation');
        assert.ok(typedefFields.has('reservation'), 'sanity: ListedMember should declare reservation');

        assertFieldParity('ListedMember vs list-members.ts member object', resultFields, typedefFields);
    });

    // apra-fleet-ecjf.4.2 (F12): pins the client's MemberReservationOptions
    // typedef against member_reservation's INPUT zod schema, so a server-side
    // option (owner_ref, pid, ...) can no longer land without the client
    // declaring it -- the drift this whole file exists to catch.
    test('MemberReservationOptions matches memberReservationSchema field-for-field', () => {
        const schemaFields = memberReservationSchemaFields();
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'MemberReservationOptions');

        assert.ok(schemaFields.size > 3, `expected several memberReservationSchema fields, parsed ${schemaFields.size}`);
        assert.ok(typedefFields.size > 3, `expected several MemberReservationOptions properties, parsed ${typedefFields.size}`);

        // owner_ref and pid must be on both sides: dropping either from the
        // typedef or the schema must fail this test, not pass vacuously.
        assert.ok(schemaFields.has('owner_ref'), 'sanity: memberReservationSchema should declare owner_ref');
        assert.ok(schemaFields.has('pid'), 'sanity: memberReservationSchema should declare pid');
        assert.ok(typedefFields.has('owner_ref'), 'sanity: MemberReservationOptions should declare owner_ref');
        assert.ok(typedefFields.has('pid'), 'sanity: MemberReservationOptions should declare pid');

        assertFieldParity('MemberReservationOptions vs memberReservationSchema', schemaFields, typedefFields);
    });

    // apra-fleet-972p.2.2 (F3): pins the client's CredentialStoreSetResult
    // typedef (the return_url structuredContent shape) against the server's
    // CredentialStoreSetUrlResult interface in credential-store-set.ts.
    test('CredentialStoreSetResult matches the CredentialStoreSetUrlResult interface field-for-field', () => {
        const interfaceFields = extractInterfaceFields(credentialStoreSetSrc, 'CredentialStoreSetUrlResult');
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'CredentialStoreSetResult');

        assert.ok(interfaceFields.has('url'), 'sanity: CredentialStoreSetUrlResult should declare url');
        assert.ok(interfaceFields.has('expiresAt'), 'sanity: CredentialStoreSetUrlResult should declare expiresAt');
        assert.ok(typedefFields.has('url'), 'sanity: CredentialStoreSetResult should declare url');
        assert.ok(typedefFields.has('expiresAt'), 'sanity: CredentialStoreSetResult should declare expiresAt');

        assertFieldParity('CredentialStoreSetResult vs CredentialStoreSetUrlResult', interfaceFields, typedefFields);
    });

    // apra-fleet-4qtu.3.2 (F2): pins the client's MemberGitStatusResult
    // typedef (the structuredContent shape of member_git_status) against the
    // server's MemberGitStatusFields interface in member-git-status.ts. That
    // tool has no zod schema for its RESULT shape either -- only its input --
    // so the interface is the ground truth, exactly as for
    // CredentialStoreSetUrlResult above.
    test('MemberGitStatusResult matches the MemberGitStatusFields interface field-for-field', () => {
        const interfaceFields = extractInterfaceFields(memberGitStatusSrc, 'MemberGitStatusFields');
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'MemberGitStatusResult');

        assert.ok(interfaceFields.has('checkout'), 'sanity: MemberGitStatusFields should declare checkout');
        assert.ok(interfaceFields.has('outcome'), 'sanity: MemberGitStatusFields should declare outcome');
        assert.ok(typedefFields.has('checkout'), 'sanity: MemberGitStatusResult should declare checkout');
        assert.ok(typedefFields.has('outcome'), 'sanity: MemberGitStatusResult should declare outcome');

        assertFieldParity('MemberGitStatusResult vs MemberGitStatusFields', interfaceFields, typedefFields);
    });

    // apra-fleet-g6ap.6 (DQ-22 followup to apra-fleet-g6ap.5): pins the
    // client's MemberOwnerStructured typedef against the server's
    // MemberOwnerFields interface in member-owner.ts, so the heldBy field
    // (and any future field) added to one side is caught if not mirrored on
    // the other. MemberOwnerFields has no zod schema either -- same shape as
    // MemberGitStatusFields above -- and is module-private (not exported),
    // which extractInterfaceFields() now falls back to handling.
    test('MemberOwnerStructured matches the MemberOwnerFields interface field-for-field', () => {
        const interfaceFields = extractInterfaceFields(memberOwnerSrc, 'MemberOwnerFields');
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'MemberOwnerStructured');

        assert.ok(interfaceFields.has('outcome'), 'sanity: MemberOwnerFields should declare outcome');
        assert.ok(interfaceFields.has('heldBy'), 'sanity: MemberOwnerFields should declare heldBy');
        assert.ok(typedefFields.has('outcome'), 'sanity: MemberOwnerStructured should declare outcome');
        assert.ok(typedefFields.has('heldBy'), 'sanity: MemberOwnerStructured should declare heldBy');

        assertFieldParity('MemberOwnerStructured vs MemberOwnerFields', interfaceFields, typedefFields);
    });

    // Nested-shape counterpart to the subtest above: heldBy entries are
    // MemberHeldByEntry[] on both sides -- pin that shape too so a field
    // added only to the entry (not just the outer MemberOwnerFields/
    // MemberOwnerStructured) is also caught.
    test('MemberHeldByEntry (client typedef) matches the MemberHeldByEntry interface field-for-field', () => {
        const interfaceFields = extractInterfaceFields(memberOwnerSrc, 'MemberHeldByEntry');
        const typedefFields = extractTypedefProperties(apiMjsSrc, 'MemberHeldByEntry');

        assert.ok(interfaceFields.has('package'), 'sanity: MemberHeldByEntry interface should declare package');
        assert.ok(interfaceFields.has('reason'), 'sanity: MemberHeldByEntry interface should declare reason');
        assert.ok(typedefFields.has('package'), 'sanity: MemberHeldByEntry typedef should declare package');
        assert.ok(typedefFields.has('reason'), 'sanity: MemberHeldByEntry typedef should declare reason');

        assertFieldParity('MemberHeldByEntry typedef vs MemberHeldByEntry interface', interfaceFields, typedefFields);
    });
});
