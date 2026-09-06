import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { SERVER_COMMANDS } from '../../src/lsp/server-commands';

// The language client registers an editor command for every id the server declares it executes. A
// server command sharing an id with one the extension registers itself throws while the client is
// initializing, which fails the whole server on startup with a message naming only the id, so
// nothing about the failure points at the two declarations that collide.
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string }> };
};
const contributed = manifest.contributes.commands.map((entry) => entry.command);

describe('the commands the server declares it executes', () => {
    it('shares no id with a command the extension contributes', () => {
        expect(SERVER_COMMANDS.filter((command) => contributed.includes(command))).toEqual([]);
    });

    it('declares each id once', () => {
        expect(SERVER_COMMANDS.length).toBe(new Set(SERVER_COMMANDS).size);
    });

    it('names every id in the namespace the extension owns', () => {
        expect(SERVER_COMMANDS.filter((command) => !command.startsWith('cosmoteer.'))).toEqual([]);
    });
});
