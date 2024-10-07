export const startsWithAmpersandAndLetter = (value: string) => /^&[A-Za-z_.]/.test(value);

export const isValidReference = (value: string) => {
    if (value.startsWith('&')) {
        const valueWithoutAmpersand = value.substring(1);
        if (
            (valueWithoutAmpersand.startsWith('<') && valueWithoutAmpersand.includes('.rules>')) ||
            valueWithoutAmpersand.startsWith('..') ||
            valueWithoutAmpersand.startsWith('~') ||
            valueWithoutAmpersand.startsWith('/') ||
            valueWithoutAmpersand.search(/^[A-Za-z_]/) !== -1
        ) {
            const nextValue = valueWithoutAmpersand.substring(1);
            if (nextValue.includes('&') || nextValue.includes('<') || nextValue.includes('~')) {
                return false;
            }
            return true;
        }
    } else if (
        (value.startsWith('<') && value.includes('.rules>')) ||
        value.startsWith('..') ||
        value.startsWith('/') ||
        value.startsWith('^') ||
        value.startsWith('~')
    ) {
        const nextValue = value.substring(1);
        if (
            nextValue.includes('&') ||
            nextValue.includes(' ') ||
            nextValue.includes('<') ||
            nextValue.includes('~') ||
            (!value.startsWith('^') && nextValue.startsWith('/'))
        ) {
            return false;
        }
        return true;
    }
    return false;
};
