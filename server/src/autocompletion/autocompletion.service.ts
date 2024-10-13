import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode } from '../parser/ast';
import { AutoCompletionReference } from './autocompletion.reference';
import { CancellationError } from '../utils/cancellation';

export class AutoCompletionService {
    private static _instance: AutoCompletionService;
    private completions: AutoCompletion<AbstractNode>[] = [new AutoCompletionReference()];

    private constructor() {}

    public static get instance(): AutoCompletionService {
        if (!AutoCompletionService._instance) {
            AutoCompletionService._instance = new AutoCompletionService();
        }
        return AutoCompletionService._instance;
    }

    public registerCompletion<T extends AbstractNode>(completion: AutoCompletion<T>): void {
        this.completions.push(completion);
    }

    public async getCompletions(node: AbstractNode, cancellationToken: CancellationToken): Promise<string[]> {
        const promises = this.completions
            .map((completion) => completion.getCompletions(node, cancellationToken))
            .flat();
        if (cancellationToken.isCancellationRequested) throw new CancellationError();
        const results = (await Promise.all(promises)).flat();
        return results;
    }
}

export interface AutoCompletion<T extends AbstractNode> {
    getCompletions(node: T, cancellationToken: CancellationToken): Promise<string[]>;
}
