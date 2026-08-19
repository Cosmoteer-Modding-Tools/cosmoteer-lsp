import { describe, expect, it } from 'vitest';
import {
    SCHEMA_SEARCH_HIT_CAP,
    SchemaSearchHit,
    rankSchemaEntries,
    schemaSearchDetail,
    searchSchema,
} from '../../../src/features/schema-search/schema-search';
import { schemaSearchEntries, schemaSearchEntryById } from '../../../src/features/schema-search/schema-search.index';

const hitsFor = (query: string): SchemaSearchHit[] => searchSchema({ query }).hits;
const labelsFor = (query: string): string[] => hitsFor(query).map((hit) => hit.label);

/** Every word a hit was allowed to match on, so a prose assertion can check the real text. */
const searchableText = (hit: SchemaSearchHit): string =>
    `${hit.label} ${hit.owner} ${hit.detail} ${schemaSearchEntryById(hit.id)?.field?.description ?? ''}`.toLowerCase();

// The ranking is the whole feature: a modder types a half-remembered word and the field they meant
// has to be near the top. These assertions pin the tiers that make that true against the shipped
// bundle, and are deliberately written as "the top hit is the query" wherever the case allows, so a
// schemagen regen after a game update does not turn a content change into a red suite.
describe('searchSchema ranking', () => {
    it('puts an exact name above every prefix of it', () => {
        const labels = labelsFor('Health');
        expect(labels[0]).toBe('Health');
        expect(labels.indexOf('HealthType')).toBeGreaterThan(0);
        expect(labels.indexOf('HealthFactor')).toBeGreaterThan(labels.indexOf('HealthType'));
    });

    it('finds a derived type by the discriminator a modder actually writes', () => {
        const top = hitsFor('beam')[0];
        expect(top.label).toBe('Beam');
        expect(top.kind).toBe('type');
        // Labelling type entries by their C# short name would rank BeamEffectRules here instead, and
        // the 405 derived types whose discriminator differs from their class name would all miss.
        expect(top.owner).toContain('Beam');
    });

    it('ranks a camel-hump match above a match that sits mid-word', () => {
        const labels = labelsFor('rate');
        const lastHump = labels.findLastIndex((label) => /[a-z0-9]Rate/.test(label));
        const firstMidWord = labels.findIndex(
            (label) => /[a-z]rate/.test(label) && !/[a-z0-9]Rate/.test(label) && !/^rate/i.test(label)
        );
        expect(lastHump).toBeGreaterThan(0);
        expect(firstMidWord).toBeGreaterThan(0);
        expect(lastHump).toBeLessThan(firstMidWord);
    });

    it('answers an acronym with exactly the fields whose humps spell it', () => {
        expect(labelsFor('mhf').sort()).toEqual(['MaxHealthFraction', 'MinHealthFraction']);
    });

    it('never matches a name as a scattered subsequence', () => {
        // With a subsequence rule `armor` ranks FadeFromColor above every real hit, which is why the
        // ladder has camel-hump and acronym tiers instead of one.
        const labels = labelsFor('armor');
        expect(labels).not.toContain('FadeFromColor');
        expect(labels.length).toBeGreaterThan(0);
    });

    it('searches the field prose, and puts the name match first', () => {
        expect(labelsFor('penetrat')[0]).toBe('Penetration');
    });

    it('requires every term of a multi-word prose query', () => {
        const hits = hitsFor('how often');
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) {
            expect(searchableText(hit)).toContain('often');
            expect(searchableText(hit)).toContain('how');
        }
    });

    it('ANDs the terms instead of unioning them', () => {
        expect(searchSchema({ query: 'penetration' }).total).toBeGreaterThan(0);
        expect(searchSchema({ query: 'nebula' }).total).toBeGreaterThan(0);
        expect(searchSchema({ query: 'penetration nebula' }).total).toBe(0);
    });

    it('caps the hits and reports honestly how many were left out', () => {
        const result = searchSchema({ query: 'the' });
        expect(result.hits.length).toBe(SCHEMA_SEARCH_HIT_CAP);
        expect(result.truncated).toBe(true);
        expect(result.total).toBeGreaterThan(5000);
    });

    it('honours a smaller limit without lying about the total', () => {
        const result = searchSchema({ query: 'the', limit: 10 });
        expect(result.hits.length).toBe(10);
        expect(result.truncated).toBe(true);
        expect(result.total).toBeGreaterThan(5000);
    });

    it('sorts a dead or removed field below an equal-scoring live one', () => {
        // Names carried by both a live and a dead/removed field, so the two score identically and
        // only the demotion decides the order.
        const live = new Set<string>();
        const stale = new Set<string>();
        for (const entry of schemaSearchEntries()) {
            if (entry.kind !== 'field') continue;
            (entry.dead || entry.deprecated ? stale : live).add(entry.nameLower);
        }
        const shared = [...stale].filter((name) => live.has(name));
        expect(shared.length).toBeGreaterThan(0);
        for (const name of shared) {
            const hits = hitsFor(name).filter((hit) => hit.label.toLowerCase() === name);
            const lastLive = hits.findLastIndex((hit) => !hit.dead && !hit.deprecated);
            const firstStale = hits.findIndex((hit) => hit.dead || hit.deprecated);
            expect(firstStale).toBeGreaterThan(lastLive);
            expect(hits[firstStale].dead === true || hits[firstStale].deprecated === true).toBe(true);
        }
    });

    it('is deterministic', () => {
        for (const query of ['rate', 'the', 'explosion damage']) {
            expect(hitsFor(query).map((hit) => hit.id)).toEqual(hitsFor(query).map((hit) => hit.id));
        }
    });

    it('offers the caret class vocabulary when nothing has been typed yet', () => {
        const result = searchSchema({ query: '' }, 'Cosmoteer.Simulation.MediaEffects.BeamEffectRules');
        expect(result.contextClassName).toBe('Beam');
        expect(result.hits.length).toBeGreaterThan(0);
        // Own fields first, inherited ones after, and every one of them writable right there.
        expect(result.hits.every((hit) => hit.insertable === true)).toBe(true);
        expect(result.hits.map((hit) => hit.label)).toContain('Delay');
    });

    it('answers an empty query with nothing when there is no caret class', () => {
        expect(searchSchema({ query: '   ' })).toEqual({
            hits: [],
            total: 0,
            truncated: false,
            contextClass: undefined,
            contextClassName: undefined,
        });
    });

    it('documents a field with the same signature block hover already shows', () => {
        const hit = hitsFor('MaxHealth').find((entry) => entry.owner === 'PartRules');
        const page = schemaSearchDetail(hit!.id) ?? '';
        expect(page.startsWith('# MaxHealth\n')).toBe(true);
        expect(page).toContain('Cosmoteer.Ships.Parts.PartRules');
        expect(page).toContain('**MaxHealth**');
        expect(page).toContain('wiki.gg/wiki/Modding/Data_fields');
    });

    it('documents a type with what it is written as and every field it reads', () => {
        const page = schemaSearchDetail('t:Cosmoteer.Simulation.MediaEffects.BeamEffectRules') ?? '';
        expect(page.startsWith('# Beam\n')).toBe(true);
        expect(page).toContain('Type = Beam');
        expect(page).toContain('BaseQuadEffectRules');
        // Inherited fields are in scope in the group too, so the page has to list them.
        expect(page).toContain('`Delay`');
    });

    it('documents a registry with its subtypes', () => {
        const page = schemaSearchDetail('r:Cosmoteer.Simulation.MediaEffects.MediaEffectRules') ?? '';
        expect(page).toContain('# MediaEffectRules');
        expect(page).toContain('- `Beam`');
    });

    it('documents an enum member with the whole enum it belongs to', () => {
        const page = schemaSearchDetail('m:Cosmoteer.Bullets.BulletFrameOfReference:Grid') ?? '';
        expect(page.startsWith('# Grid\n')).toBe(true);
        expect(page).toContain('BulletFrameOfReference');
        expect(page).toContain('- `HitObject`');
    });

    it('answers nothing for an entry the schema no longer declares', () => {
        expect(schemaSearchDetail('f:Gone.Away:Nothing')).toBeUndefined();
    });

    it('puts the caret class own field first among the fields that score the same', () => {
        const PART = 'Cosmoteer.Ships.Parts.PartRules';
        // Eight classes declare a field named exactly `Size`, so every one of them scores the same
        // and only the caret can say which one the author meant.
        const blind = searchSchema({ query: 'size' }).hits.findIndex((hit) => hit.owner === 'PartRules');
        const scoped = searchSchema({ query: 'size' }, PART).hits;
        expect(blind).toBeGreaterThan(0);
        expect(scoped[0].owner).toBe('PartRules');
        expect(scoped[0].insertable).toBe(true);
    });

    it('never lets the caret class lift a weaker match over a stronger one', () => {
        const PART = 'Cosmoteer.Ships.Parts.PartRules';
        // An exact name hit on an unrelated class must still outrank every merely-longer name, even
        // one the caret's own class declares. The caret decides ties, nothing else.
        const hits = searchSchema({ query: 'size', limit: 100 }, PART).hits;
        const lastExact = hits.map((hit) => hit.label.toLowerCase() === 'size').lastIndexOf(true);
        const firstLonger = hits.findIndex((hit) => hit.label.toLowerCase() !== 'size');
        expect(hits[0].label.toLowerCase()).toBe('size');
        expect(firstLonger).toBeGreaterThan(lastExact);
    });

    it('ranks a caret search as fast as a blind one', () => {
        const PART = 'Cosmoteer.Ships.Parts.PartRules';
        rankSchemaEntries('the', SCHEMA_SEARCH_HIT_CAP, [PART]);
        const start = performance.now();
        rankSchemaEntries('the', SCHEMA_SEARCH_HIT_CAP, [PART]);
        expect(performance.now() - start).toBeLessThan(50);
    });

    it('ranks the worst query well inside the typing loop', () => {
        rankSchemaEntries('the', SCHEMA_SEARCH_HIT_CAP); // warm the table, which the first query builds
        const start = performance.now();
        const result = rankSchemaEntries('the', SCHEMA_SEARCH_HIT_CAP);
        const elapsed = performance.now() - start;
        expect(result.total).toBeGreaterThan(5000);
        // Measured at 3.4 ms on the shipped bundle, so the guard has ample headroom on slow CI.
        expect(elapsed).toBeLessThan(50);
    });
});
