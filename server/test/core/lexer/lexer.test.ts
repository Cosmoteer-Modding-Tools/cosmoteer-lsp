import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { readFixture } from '../../helpers';

describe('lexer', () => {
    it('tokenizes a file with inheritance', () => {
        expect(lexer(readFixture('inheritance.rules'))).toMatchSnapshot();
    });

    it('tokenizes a file with internal references', () => {
        expect(lexer(readFixture('colors.rules'))).toMatchSnapshot();
    });

    it('tokenizes booleans, percentages and assignments', () => {
        expect(lexer('A = true\nB = false\nC = 50%\nD = 1.5')).toMatchSnapshot();
    });
});
