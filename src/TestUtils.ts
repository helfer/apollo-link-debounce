import {
    ApolloLink,
    Operation,
    Observable,
    NextLink,
} from 'apollo-link';
import {
    ExecutionResult,
} from 'graphql';
import {
    ExecutionResultDataDefault,
} from 'graphql/execution/execute';

export interface ObservableValue {
    value?: ExecutionResult | Error;
    delay?: number;
    type: 'next' | 'error' | 'complete';
}

export interface Unsubscribable {
    unsubscribe: () => void;
}


export interface NextEvent {
    type: 'next';
    delay?: number;
    value: ExecutionResult;
}

export interface ErrorEvent {
    type: 'error';
    delay?: number;
    value: Error;
}

export interface CompleteEvent {
    type: 'complete';
    delay?: number;
}

export type ObservableEvent = NextEvent | ErrorEvent | CompleteEvent;

export class TestLink extends ApolloLink {
    public operations: Operation[];
    constructor() {
        super();
        this.operations = [];
    }

    public request(operation: Operation) {
        this.operations.push(operation);
        // TODO(helfer): Throw an error if neither testError nor testResponse is defined
        return new Observable(observer => {
            if (operation.getContext().testError) {
                setTimeout(() => observer.error(operation.getContext().testError), 0);
                return;
            }
            setTimeout(() => observer.next(operation.getContext().testResponse), 0);
            setTimeout(() => observer.complete(), 0);
        });
    }
}

export class TestSequenceLink extends ApolloLink {
    public operations: Operation[];
    constructor() {
        super();
        this.operations = [];
    }

    public request(operation: Operation, forward: NextLink) {
        if (!operation.getContext().testSequence) {
            return forward(operation);
        }
        this.operations.push(operation);
        // TODO(helfer): Throw an error if neither testError nor testResponse is defined
        return new Observable(observer => {
            operation.getContext().testSequence.forEach((event: ObservableEvent) => {
                if (event.type === 'error') {
                    setTimeout(() => observer.error(event.value), event.delay || 0);
                    return;
                }
                if (event.type === 'next') {
                    setTimeout(() => observer.next(event.value), event.delay || 0);
                }
                if (event.type === 'complete') {
                    setTimeout(() => observer.complete(), event.delay || 0);
                }
            });
        });
    }
}

export function mergeObservables(...observables: Observable<ExecutionResult>[]) {
    return new Observable(observer => {
        const numObservables = observables.length;
        let completedObservables = 0;
        observables.forEach(o => {
            o.subscribe({
                next: observer.next.bind(observer),
                error: observer.error.bind(observer),
                complete: () => {
                    completedObservables++;
                    if (completedObservables === numObservables) {
                        observer.complete();
                    }
                },
            });
        });
        // TODO(helfer): unsubscribe
    });
}

export function toResultValue(e: ObservableEvent): ObservableEvent {
    const obj = { ...e };
    delete obj.delay;
    return obj;
}

export const assertObservableSequence = (
    observable: Observable<ExecutionResult>,
    sequence: ObservableValue[],
    initializer: (sub: Unsubscribable) => void = () => undefined,
): Promise<boolean | Error> => {
    let index = 0;
    if (sequence.length === 0) {
        throw new Error('Observable sequence must have at least one element');
    }
    return new Promise((resolve, reject) => {
        const sub = observable.subscribe({
            next: (value) => {
                expect({ type: 'next', value }).toEqual(sequence[index]);
                index++;
                if (index === sequence.length) {
                    resolve(true);
                }
            },
            error: (value) => {
                expect({ type: 'error', value }).toEqual(sequence[index]);
                index++;
                // This check makes sure that there is no next element in
                // the sequence. If there is, it will print a somewhat useful error
                expect(undefined).toEqual(sequence[index]);
                resolve(true);
            },
            complete: () => {
                expect({ type: 'complete' }).toEqual(sequence[index]);
                index++;
                // This check makes sure that there is no next element in
                // the sequence. If there is, it will print a somewhat useful error
                expect(undefined).toEqual(sequence[index]);
                resolve(true);
            },
        });
        initializer(sub);
    });
};
