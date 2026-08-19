import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
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

// Every locale that ships, so dropping a bundle in is enough to have it checked.
const locales = readdirSync(L10N_DIR)
    .map((name) => /^bundle\.l10n\.([a-z]{2}(?:-[A-Za-z]+)?)\.json$/.exec(name)?.[1])
    .filter((locale): locale is string => !!locale);

// A single-quoted or double-quoted first argument of `l10n.t`, escapes included.
const MESSAGE_LITERAL = /\bl10n\.t\(\s*(['"])((?:[^\\]|\\.)*?)\1/g;

/**
 * Turn a source literal back into the text the exporter writes into the bundle.
 *
 * @param literal the literal's body, as it stands in the source.
 * @returns the message with its escapes resolved.
 */
const unescapeLiteral = (literal: string): string =>
    literal.replace(/\\(['"\\n])/g, (_, escaped: string) => (escaped === 'n' ? '\n' : escaped));

const SOURCE_DIRS = [join(__dirname, '..', 'src'), join(__dirname, '..', '..', 'client', 'src')];

/**
 * Collect every literal message the sources hand to `l10n.t`.
 *
 * The English bundle is generated, so a message added without re-running `npm run l10n` is missing
 * from every bundle at once, which no bundle-against-bundle check can see: the message reads as
 * English for a German user and nothing fails.
 *
 * @returns the messages found, with the file each one lives in.
 */
const sourceMessages = (): { message: string; file: string }[] => {
    const found: { message: string; file: string }[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'test' && entry.name !== 'node_modules') walk(path);
                continue;
            }
            if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
            const text = readFileSync(path, 'utf8');
            for (const match of text.matchAll(MESSAGE_LITERAL)) {
                found.push({ message: unescapeLiteral(match[2]), file: path });
            }
        }
    };
    for (const dir of SOURCE_DIRS) walk(dir);
    return found;
};

describe('translated l10n bundles', () => {
    const english = bundle('bundle.l10n.json');

    it('carries every message the sources hand to l10n.t', () => {
        const missing = sourceMessages()
            .filter(({ message }) => !(message in english))
            .map(({ message, file }) => `${message} (${file})`);
        expect(missing).toEqual([]);
    });

    for (const locale of locales) {
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
