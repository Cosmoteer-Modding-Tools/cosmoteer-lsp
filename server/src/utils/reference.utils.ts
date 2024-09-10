export const startsWithAmpersandAndLetter = (value: string) =>
    /^&[A-Za-z_]/.test(value);
