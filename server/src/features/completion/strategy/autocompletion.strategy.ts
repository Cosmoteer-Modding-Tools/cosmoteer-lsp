/**
 * A base class for auto-completion strategies, providing a common interface for different types of completion strategies.
 * @template T The type of the completion result.
 * @template P The type of the parameters required for completion.
 */
export abstract class AutoCompletionStrategy<T, P> {
    /**
     *  Perform auto-completion based on the provided parameters.
     * @param args  The parameters required for completion.
     * @returns A promise that resolves to the completion result of type T.
     */
    abstract complete(args: P): Promise<T>;
}
