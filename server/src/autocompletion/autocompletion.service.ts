import { AbstractNode } from '../parser/ast';
import { AutoCompletionReference } from './autocompletion.reference';

export class AutoCompletionService {
    private static _instance: AutoCompletionService;
    private completions: AutoCompletion<AbstractNode>[] = [
        new AutoCompletionReference(),
    ];

    private constructor() {}

    public static get instance(): AutoCompletionService {
        if (!AutoCompletionService._instance) {
            AutoCompletionService._instance = new AutoCompletionService();
        }
        return AutoCompletionService._instance;
    }

    public registerCompletion<T extends AbstractNode>(
        completion: AutoCompletion<T>
    ): void {
        this.completions.push(completion);
    }

    public getCompletions(node: AbstractNode): string[] {
        for (const completion of this.completions) {
            const completions = completion.getCompletions(node);
            if (completions.length > 0) {
                return completions;
            }
        }
        return [];
    }
}

export interface AutoCompletion<T extends AbstractNode> {
    getCompletions(node: T): string[];
}
