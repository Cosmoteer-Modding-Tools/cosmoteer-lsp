import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// The English bundle is generated from the sources (`npm run l10n`), the translated bundles are kept
// by hand, so they drift silently: a new `l10n.t(...)` message just falls back to English for every
// translated locale. This test is the tripwire. It also catches the two ways a translation breaks at
// runtime rather than at build time: a key the English bundle no longer has (a reworded message
// leaves its translation stranded), and a translation that lost one of the `{0}` placeholders the
// message is formatted with.
const L10N_DIR = join(__dirname, '..', '..', 'l10n');
const bundle = (name: string): Record<string, string> =>
    JSON.parse(readFileSync(join(L10N_DIR, name), 'utf8')) as Record<string, string>;

const placeholders = (text: string): string[] => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();

describe('translated l10n bundles', () => {
    const english = bundle('bundle.l10n.json');

    for (const locale of ['de']) {
        describe(locale, () => {
            const translated = bundle(`bundle.l10n.${locale}.json`);

            it('translates every message the sources use', () => {
                expect(Object.keys(english).filter((key) => !(key in translated))).toEqual([]);
            });

            it('carries no message the sources no longer use', () => {
                expect(Object.keys(translated).filter((key) => !(key in english))).toEqual([]);
            });

            it('keeps every placeholder of each message', () => {
                const broken = Object.keys(english).filter(
                    (key) => translated[key] && placeholders(key).join() !== placeholders(translated[key]).join()
                );
                expect(broken).toEqual([]);
            });
        });
    }
});
