/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import path from 'path';
import { readdirSync } from 'fs';
import Mocha from 'mocha';

export async function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
    });
    mocha.timeout(100000);

    const testsRoot = __dirname;

    // The suites sit flat in this folder, so a directory listing is the whole search.
    const files = readdirSync(testsRoot).filter((f) => f.endsWith('.test.js'));
    files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

    await new Promise<void>((resolve, reject) => {
        try {
            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            console.error(err);
            reject(err);
        }
    });
}
