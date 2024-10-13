export abstract class AutoCompletionStrategy<T, P> {
    abstract complete(args: P): Promise<T>;
}
