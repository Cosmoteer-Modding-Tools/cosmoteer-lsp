import { connection } from '../context';
import { runServerCommand } from '../server-commands';

/**
 * Registers `workspace/executeCommand`. Every command the server owns changes something outside the
 * file the caret is in, which is why it runs here: one implementation, and both clients only trigger
 * it and render the summary it answers with.
 *
 * What each command does, and the preparation it needs, is declared in server-commands.ts. This
 * handler only routes, so the id list the server advertises and the implementations behind it cannot
 * drift apart.
 */
export function register(): void {
    connection.onExecuteCommand((params) => runServerCommand(params.command, params.arguments));
}
