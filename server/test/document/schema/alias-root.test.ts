import { describe, expect, it, beforeEach } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { aliasRootIndex, aliasedMemberType } from '../../../src/document/schema/alias-root';
import { fieldOf } from '../../../src/document/schema/schema';

// A stand-in cosmoteer.rules: a whole-file map alias (Buffs) and a member alias (Factions).
const ROOT_SRC = 'Buffs = &<buffs/buffs.rules>\nFactions = &<factions/factions.rules>/Factions';
const BUFFS_URI = 'file:///game/buffs/buffs.rules';
const FACTIONS_URI = 'file:///game/factions/factions.rules';

const docWith = (uri: string): AbstractNodeDocument => parser(lexer(''), uri).value;

const resolver = async (fileRef: string): Promise<AbstractNodeDocument | undefined> => {
    if (fileRef.includes('buffs')) return docWith(BUFFS_URI);
    if (fileRef.includes('factions')) return docWith(FACTIONS_URI);
    return undefined;
};

describe('alias-root index', () => {
    beforeEach(async () => {
        aliasRootIndex.invalidate();
        await aliasRootIndex.build(parser(lexer(ROOT_SRC), 'file:///game/cosmoteer.rules').value, resolver);
    });

    it('records a whole-file map alias on the file root', () => {
        const root = aliasRootIndex.rootType(BUFFS_URI);
        expect(root).toEqual(fieldOf('Cosmoteer.Data.Rules', 'Buffs')!.valueType);
        expect(root?.kind).toBe('map');
    });

    it('records a member alias on the named member', () => {
        const member = aliasRootIndex.memberType(FACTIONS_URI, 'Factions');
        expect(member).toEqual(fieldOf('Cosmoteer.Data.Rules', 'Factions')!.valueType);
        expect(member?.kind).toBe('list');
    });

    it('aliasedMemberType resolves a whole-file map member to the map value type', () => {
        const buffsDoc = docWith(BUFFS_URI);
        const memberType = aliasedMemberType(buffsDoc, 'Engine');
        const buffsValue = (fieldOf('Cosmoteer.Data.Rules', 'Buffs')!.valueType as any).value;
        expect(memberType).toEqual(buffsValue);
    });

    it('aliasedMemberType resolves an explicit member alias by name', () => {
        const factionsDoc = docWith(FACTIONS_URI);
        expect(aliasedMemberType(factionsDoc, 'Factions')?.kind).toBe('list');
    });

    it('returns undefined for a file that is not aliased', () => {
        expect(aliasRootIndex.rootType('file:///game/random.rules')).toBeUndefined();
        expect(aliasedMemberType(docWith('file:///game/random.rules'), 'Foo')).toBeUndefined();
    });
});
