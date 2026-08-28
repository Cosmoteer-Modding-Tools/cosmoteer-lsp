import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
import { MentionIndex } from '../../../src/features/navigation/mention.index';
import {
    incomingCallsOf,
    outgoingCallsOf,
    prepareCallHierarchy,
} from '../../../src/features/structure/call-hierarchy.service';

const token = CancellationToken.None;
const dirs: string[] = [];

/** A throwaway project on disk, so the reference search has real files to narrow to. */
const buildWorkspace = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'call-hierarchy-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    MentionIndex.instance.reset();
    clearFsCaches();
    return dir;
};

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A shared fragment has no calls, but it does have callers, and an author about to change one asks
// for exactly that list. The three shapes a caller writes are all references that resolve to the
// same node, so one search answers for all of them.
describe('the declaration a hierarchy opens on', () => {
    it('is the member the caret sits in', () => {
        const items = prepareCallHierarchy(parseText('Shared\n{\n\tRange = 30\n}\n', 'file:///t.rules'), { line: 2, character: 3 }, []);
        expect(items?.map((item) => item.name)).toEqual(['Range']);
    });

    it('is the container when the caret is on its name', () => {
        const items = prepareCallHierarchy(parseText('Shared\n{\n\tRange = 30\n}\n', 'file:///t.rules'), { line: 0, character: 2 }, []);
        expect(items?.map((item) => item.name)).toEqual(['Shared']);
    });
});

describe('who reaches a shared declaration', () => {
    it('lists the file that includes it and the one that inherits it as one set of callers', async () => {
        const dir = buildWorkspace({
            'shared.rules': 'Shared\n{\n\tRange = 30\n}\n',
            'includer.rules': 'Weapon\n{\n\tSettings = &<shared.rules>/Shared\n}\n',
            'deriver.rules': 'Copy : <shared.rules>/Shared\n{\n\tExtra = 1\n}\n',
        });
        const source = parseText('Shared\n{\n\tRange = 30\n}\n', join(dir, 'shared.rules'));
        const [item] = prepareCallHierarchy(source, { line: 0, character: 2 }, [dir]) ?? [];
        const callers = await incomingCallsOf(item, [dir], token);
        expect(callers.map((call) => call.from.name).sort()).toEqual(['Copy', 'Settings']);
    });

    it(`lists the member own readers when the hierarchy opens on the member`, async () => {
        const dir = buildWorkspace({
            'shared.rules': 'Shared\n{\n\tRange = 30\n}\n',
            'reader.rules': 'Weapon\n{\n\tRange = &<shared.rules>/Shared/Range\n}\n',
        });
        const source = parseText('Shared\n{\n\tRange = 30\n}\n', join(dir, 'shared.rules'));
        const [item] = prepareCallHierarchy(source, { line: 2, character: 3 }, [dir]) ?? [];
        const callers = await incomingCallsOf(item, [dir], token);
        expect(callers.map((call) => call.from.name)).toEqual(['Range']);
        expect(callers[0].fromRanges).toHaveLength(1);
    });

    it('says nothing about a declaration nothing reads', async () => {
        const dir = buildWorkspace({ 'lonely.rules': 'Lonely\n{\n\tRange = 30\n}\n' });
        const source = parseText('Lonely\n{\n\tRange = 30\n}\n', join(dir, 'lonely.rules'));
        const [item] = prepareCallHierarchy(source, { line: 0, character: 2 }, [dir]) ?? [];
        expect(await incomingCallsOf(item, [dir], token)).toEqual([]);
    });
});

describe('what a declaration reaches', () => {
    it('is the declaration behind every reference it writes', async () => {
        const dir = buildWorkspace({
            'shared.rules': 'Shared\n{\n\tRange = 30\n}\n',
            'reader.rules': 'Weapon\n{\n\tRange = &<shared.rules>/Shared/Range\n}\n',
        });
        const source = parseText('Weapon\n{\n\tRange = &<shared.rules>/Shared/Range\n}\n', join(dir, 'reader.rules'));
        const [item] = prepareCallHierarchy(source, { line: 0, character: 2 }, [dir]) ?? [];
        const reached = await outgoingCallsOf(item, [dir], token);
        expect(reached.map((call) => call.to.name)).toEqual(['Range']);
    });
});
