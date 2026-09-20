import { Token } from '../lexer/lexer';
import { ValueNodeTypes } from '../ast/ast';
import { ALLOWED_AUDIO_EXTENSIONS } from '../../utils/constants';

// Plain numbers: an integer/decimal mantissa, including a leading-dot decimal such as `.5`
// or `.75` (common in Cosmoteer, e.g. `Bleed = .75 * .5`), with an optional scientific
// exponent (`3.4028235E+38`, `1.5e10`). A `d`-suffixed number (`90d`) is not a plain number:
// the game's ExpressionEvaluator converts it degrees-to-radians, so it must stay a String and
// go through the suffix rules in the value evaluator (typing it `Number 90` showed 90 where
// the game computes 1.5708). The previous pattern also put the `^` anchor mid-expression
// (`[-.]?^…`), which made the leading `-`/`.` branch dead and typed `.5` as a String,
// breaking value typing, math validation and resolved-value computation.
export const IS_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

// Hoisted out of inferValueType, which runs for every value token of every parsed file. Building
// the pattern there compiled a fresh RegExp per token.
const IS_SOUND = new RegExp(ALLOWED_AUDIO_EXTENSIONS.join('|').replaceAll('.', '\\.'), 'i');

/**
 * The type a bare token's value reads as: a number, one of the asset kinds recognised by its
 * extension, a reference, or plain text.
 *
 * @param token the value token to type.
 * @returns the typed value the node carries.
 */
export function inferValueType(token: Token): ValueNodeTypes {
    if (typeof token.value === 'undefined') throw new Error('Token value is undefined');
    let value: ValueNodeTypes['value'] = token.value;
    let valueType: ValueNodeTypes['type'] = IS_NUMBER.test(token.value) ? 'Number' : 'String';
    // Every asset form below contains a dot, so one indexOf spares most strings the two regex
    // tests and the suffix check. Hot: this runs for every string value of every parse.
    // Extension matches fold case: the game resolves paths through the case-insensitive
    // Windows FS, so `Icon.PNG` or `<Foo.Rules>` load exactly like their lowercase spellings.
    const hasDot = token.value.includes('.');
    const lower = hasDot ? token.value.toLowerCase() : token.value;
    if (valueType === 'String' && hasDot && lower.includes('.png')) {
        valueType = 'Sprite';
        value = value as string;
    } else if (valueType === 'String' && hasDot && IS_SOUND.test(token.value)) {
        valueType = 'Sound';
        value = value as string;
    } else if (valueType === 'String' && hasDot && lower.endsWith('.shader')) {
        valueType = 'Shader';
        value = value as string;
    } else if (
        // A reference sigil must be followed by a path/name: a lone `~`, `/`, `^`, `&`, or `..`
        // (no member) is not a resolvable reference, it is a literal value (the keyboard key-name
        // strings `TildeBacktick = ~`, `SlashQuestion = /` in cosmoteer `strings/*.rules`). Typing
        // those as references produced spurious "Reference should start with an ampersand" errors.
        (token.value.startsWith('&') && token.value.length > 1) ||
        (token.value.startsWith('^') && token.value.length > 1) ||
        (token.value.startsWith('..') && token.value.length > 2) ||
        (token.value.startsWith('/') && token.value.length > 1) ||
        (token.value.startsWith('~') && token.value.length > 1) ||
        // Mods write rules content in `.txt` files too (the game's loader ignores the extension),
        // so `<file.txt>` paths are references exactly like `<file.rules>`.
        (token.value.startsWith('<') && (lower.includes('.rules') || lower.includes('.txt'))) ||
        (token.value.startsWith('<') && !token.value.includes('>'))
    ) {
        return {
            type: 'Reference',
            value: token.value,
        };
    }
    if (valueType === 'Number') {
        return { type: 'Number', value: parseFloat(value as string) };
    }
    return { type: valueType, value: value };
}
