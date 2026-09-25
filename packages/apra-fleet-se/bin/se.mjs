#!/usr/bin/env node
// =============================================================================
// `fleet-se` -- project export/import CLI
// =============================================================================
//
// Provides 'export' and 'import' subcommands to export/import project
// configurations from/to the supervisor store (supervisor.sqlite).
// The export format is a portable, diffable JSON that can be committed
// to the beads repo (e.g. .fleet/project.json).
//
// Exit codes:
//   0 = OK
//   1 = usage error (missing required args, invalid flags)
//   2 = unknown project / bad file / other operational error
//   3 = import refused (live run detected)
// =============================================================================

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { openStore, defaultStorePath } from '../src/projects/store/db.mjs';
import {
    createProject,
    getProject,
    updateProject,
    listProjects,
} from '../src/projects/store/projects.mjs';
import { listMemberGit, upsertMemberGit } from '../src/projects/store/member-git.mjs';
import { createLedger, defaultDataDir } from '../src/supervisor/ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXPORT_FORMAT = 'apra-fleet-se/project-export@1';

/**
 * Check if this module is being run directly (not imported as a library).
 * Handles Windows realpath / argv[1] edge cases like bin/cli.mjs.
 *
 * @returns {boolean}
 */
function isMainModule() {
    try {
        // Never self-execute when this module is loaded as a test file.
        if (process.env.NODE_TEST_CONTEXT) return false;
        if (process.argv[1] === undefined) return false;
        const invokedUrl = pathToFileURL(process.argv[1]).href;
        const moduleUrl = import.meta.url;
        if (moduleUrl === invokedUrl) return true;

        // On macOS, compare realpath'd paths too.
        try {
            const realInvokedUrl = pathToFileURL(realpathSync(process.argv[1])).href;
            const realModuleUrl = pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
            return realInvokedUrl === realModuleUrl;
        } catch {
            return false;
        }
    } catch {
        return false;
    }
}

/**
 * Export a project to JSON format.
 *
 * @param {object} options
 * @param {any} options.db The store database handle
 * @param {any} options.ledger The supervisor ledger
 * @param {string} options.projectId Project ID to export
 * @returns {object} The exported project structure
 * @throws {Error} If project not found
 */
export function exportProject({ db, ledger, projectId }) {
    const project = getProject(db, projectId);
    if (!project) {
        const err = new Error(`unknown project: ${projectId}`);
        err.code = 'ERR_PROJECT_NOT_FOUND';
        throw err;
    }

    const memberGit = listMemberGit(db, projectId);

    return {
        format: EXPORT_FORMAT,
        exportedAt: new Date().toISOString(),
        project,
        memberGit,
        history: [],
        note: 'history table does not yet exist in supervisor.sqlite; history is empty',
    };
}

/**
 * Import a project from JSON format.
 *
 * @param {object} options
 * @param {any} options.db The store database handle
 * @param {any} options.ledger The supervisor ledger
 * @param {object} options.data The parsed export data
 * @returns {object} The imported project
 * @throws {Error} On format error, validation error, or live run detected
 */
export function importProject({ db, ledger, data }) {
    // Validate format
    if (!data || typeof data !== 'object' || data.format !== EXPORT_FORMAT) {
        const err = new Error(`invalid export format: expected ${EXPORT_FORMAT}`);
        err.code = 'ERR_BAD_FORMAT';
        throw err;
    }

    const { project, memberGit: importedMemberGit } = data;
    if (!project || typeof project !== 'object') {
        const err = new Error('export missing "project" field');
        err.code = 'ERR_BAD_FORMAT';
        throw err;
    }

    // Check for live runs BEFORE modifying anything
    const reservations = ledger.list();
    const liveRuns = reservations.filter((r) => r.exitedAt === null && r.exitedAt === undefined);

    // Collect all members that would be affected: bound members from member_git + backlog member
    const affectedMembers = new Set();
    if (project.backlogMember) {
        affectedMembers.add(project.backlogMember);
    }
    if (Array.isArray(importedMemberGit)) {
        for (const mg of importedMemberGit) {
            if (mg && mg.member) {
                affectedMembers.add(mg.member);
            }
        }
    }

    // Check if any live run overlaps with affected members
    for (const run of liveRuns) {
        if (!Array.isArray(run.members)) continue;
        for (const member of run.members) {
            if (affectedMembers.has(member)) {
                const err = new Error(
                    `cannot import: project has a live run (members: ${run.members.join(', ')})`,
                );
                err.code = 'ERR_LIVE_RUN';
                throw err;
            }
        }
    }

    // Upsert project: create if absent, else update
    const existing = getProject(db, project.id);
    let result;
    if (existing) {
        result = updateProject(db, project.id, {
            name: project.name,
            backlogMember: project.backlogMember,
            beads: project.beads,
            operator: project.operator,
        });
    } else {
        result = createProject(db, {
            id: project.id,
            name: project.name,
            backlogMember: project.backlogMember,
            beads: project.beads,
            operator: project.operator,
        });
    }

    // Upsert member_git rows
    if (Array.isArray(importedMemberGit)) {
        for (const mg of importedMemberGit) {
            if (mg && typeof mg === 'object') {
                upsertMemberGit(db, {
                    projectId: project.id,
                    member: mg.member,
                    originSlug: mg.originSlug,
                    originUrl: mg.originUrl,
                    checkoutPath: mg.checkoutPath,
                    branch: mg.branch,
                    upstream: mg.upstream,
                    dirty: mg.dirty,
                    worktrees: mg.worktrees,
                    playbooks: mg.playbooks,
                    bibleCommit: mg.bibleCommit,
                    statusJson: mg.statusJson,
                    probedAt: mg.probedAt,
                });
            }
        }
    }

    return result;
}

/**
 * Main CLI entry point.
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: fleet-se <export|import> [options]');
        process.exit(1);
    }

    const command = args[0];

    if (command === 'export') {
        return await handleExport(args.slice(1));
    } else if (command === 'import') {
        return await handleImport(args.slice(1));
    } else if (command === '-h' || command === '--help') {
        printHelp();
        process.exit(0);
    } else {
        console.error(`unknown command: ${command}`);
        console.error('Usage: fleet-se <export|import> [options]');
        process.exit(1);
    }
}

/**
 * Handle the 'export' subcommand.
 */
async function handleExport(args) {
    const { values, positionals } = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
            'with-history': { type: 'boolean' },
            'out': { type: 'string' },
            'data-dir': { type: 'string' },
            'help': { type: 'boolean', short: 'h' },
        },
    });

    if (values.help) {
        console.log(`
Usage: fleet-se export <projectId> [options]

Export a project to JSON format.

Arguments:
  <projectId>           Project ID to export

Options:
      --with-history    Include history (currently empty)
      --out <file>      Output file path (default: stdout)
      --data-dir <dir>  Service data directory (default: ~/.apra-fleet-se)
  -h, --help            Show this help message
`);
        process.exit(0);
    }

    const projectId = positionals[0];
    if (!projectId) {
        console.error('Error: missing projectId');
        console.error('Usage: fleet-se export <projectId> [options]');
        process.exit(1);
    }

    try {
        const dataDir = values['data-dir'] ? path.resolve(values['data-dir']) : defaultDataDir();
        const storePath = defaultStorePath({ dataDir });

        const store = openStore({ dataDir });
        const ledger = createLedger({ dataDir });
        await ledger.start();

        try {
            const exported = exportProject({
                db: store.db,
                ledger,
                projectId,
            });

            const json = JSON.stringify(exported, null, 2) + '\n';

            if (values.out) {
                await fs.writeFile(path.resolve(values.out), json, 'utf-8');
                console.error(`Exported to ${values.out}`);
            } else {
                process.stdout.write(json);
            }

            await ledger.stop();
            store.close();
            process.exit(0);
        } catch (err) {
            await ledger.stop();
            store.close();
            throw err;
        }
    } catch (err) {
        if (err?.code === 'ERR_PROJECT_NOT_FOUND') {
            console.error(`Error: ${err.message}`);
            process.exit(2);
        }
        console.error(`Error: ${err?.message || err}`);
        process.exit(2);
    }
}

/**
 * Handle the 'import' subcommand.
 */
async function handleImport(args) {
    const { values, positionals } = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
            'data-dir': { type: 'string' },
            'help': { type: 'boolean', short: 'h' },
        },
    });

    if (values.help) {
        console.log(`
Usage: fleet-se import <file> [options]

Import a project from JSON format.

Arguments:
  <file>                Path to export file

Options:
      --data-dir <dir>  Service data directory (default: ~/.apra-fleet-se)
  -h, --help            Show this help message
`);
        process.exit(0);
    }

    const filePath = positionals[0];
    if (!filePath) {
        console.error('Error: missing file path');
        console.error('Usage: fleet-se import <file> [options]');
        process.exit(1);
    }

    try {
        const dataDir = values['data-dir'] ? path.resolve(values['data-dir']) : defaultDataDir();

        // Read and parse the file
        let data;
        try {
            const content = await fs.readFile(path.resolve(filePath), 'utf-8');
            data = JSON.parse(content);
        } catch (err) {
            const e = new Error(`failed to read or parse file: ${err?.message || err}`);
            e.code = 'ERR_BAD_FILE';
            throw e;
        }

        const store = openStore({ dataDir });
        const ledger = createLedger({ dataDir });
        await ledger.start();

        try {
            const imported = importProject({
                db: store.db,
                ledger,
                data,
            });

            await ledger.stop();
            store.close();
            console.error(`Imported project: ${imported.id}`);
            process.exit(0);
        } catch (err) {
            await ledger.stop();
            store.close();
            throw err;
        }
    } catch (err) {
        if (err?.code === 'ERR_LIVE_RUN') {
            console.error(`Error: ${err.message}`);
            process.exit(3);
        }
        if (err?.code === 'ERR_BAD_FILE' || err?.code === 'ERR_BAD_FORMAT') {
            console.error(`Error: ${err.message}`);
            process.exit(2);
        }
        console.error(`Error: ${err?.message || err}`);
        process.exit(2);
    }
}

/**
 * Print help message.
 */
function printHelp() {
    console.log(`
Usage: fleet-se <export|import> [options]

Manage project configurations in the fleet-sprint supervisor.

Commands:
  export <projectId> [options]    Export a project to JSON
  import <file> [options]         Import a project from JSON

Global Options:
  -h, --help                      Show this help message

Run 'fleet-se <command> --help' for command-specific options.

Exit codes:
  0  Success
  1  Usage error
  2  Operational error (unknown project, bad file, etc.)
  3  Import refused (live run detected)
`);
}

// Declare the launcher contract (same as bin/cli.mjs)
export const selfExecuting = true;

if (isMainModule()) {
    main().catch((err) => {
        console.error(`Fatal error: ${err?.message || err}`);
        process.exit(2);
    });
}
