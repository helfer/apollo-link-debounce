import {
    ApolloLink,
    FetchResult,
    Observable,
    Observer,
    Operation,
    NextLink,
} from '@apollo/client';

interface OperationQueueEntry {
    operation: Operation;
    forward: NextLink;
    observer: Observer<FetchResult>;
    subscription?: { unsubscribe: () => void };
}

interface RunningSubscriptions {
    [groupId: string]: {
        observers: Observer<FetchResult>[];
        subscription: { unsubscribe: () => void };
    };
}

interface DebounceMetadata {
        // tslint:disable-next-line no-any
        timeout: any;
        runningSubscriptions: RunningSubscriptions;
        queuedObservers: Observer<FetchResult>[];
        currentGroupId: number;
        lastRequest?: { operation: Operation, forward: NextLink };
}

interface ContextOptions {
    debounceKey: string;
    debounceTimeout: number;
}

export default class DebounceLink extends ApolloLink {
    // TODO(helfer): nodejs and browser typings seem incompatible here. setTimeout returns NodeJS.Timer,
    // but clearTimeout wants a number. If I use window.setTimeout, I can't test as easily any more.
    // tslint:disable-next-line no-any
    private debounceInfo: {
        [debounceKey: string]: DebounceMetadata,
    } = {};
    private defaultDelay: number;

    constructor(defaultDelay: number) {
        super();
        this.defaultDelay = defaultDelay;
    }

    public request(operation: Operation, forward: NextLink) {
        const { debounceKey, debounceTimeout } = operation.getContext();

        if (!debounceKey) {
            return forward(operation);
        }
        return new Observable<FetchResult>(observer => {
            const debounceGroupId = this.enqueueRequest({ debounceKey, debounceTimeout }, { operation, forward, observer });
            return () => {
                this.unsubscribe(debounceKey, debounceGroupId, observer);
            };
        });
    }

    // Set up all necessary debounce metadata for a given debounceKey.
    // This data gets cleaned up and reset if there are no subscribers and no running timers
    private setupDebounceInfo(debounceKey: string): DebounceMetadata {
        this.debounceInfo[debounceKey] = {
            runningSubscriptions: {},
            queuedObservers: [],
            // NOTE(helfer): In theory we could run out of numbers for groupId, but it's not a realistic use-case.
            // If the debouncer fired once every ms, it would take about 300,000 years to run out of safe integers.
            currentGroupId: 0,
            timeout: undefined,
            lastRequest: undefined,
        };
        return this.debounceInfo[debounceKey];
    }

    // Add a request to the debounce queue
    private enqueueRequest({ debounceKey, debounceTimeout }: ContextOptions, { operation, forward, observer }: OperationQueueEntry) {
        const dbi = this.debounceInfo[debounceKey] || this.setupDebounceInfo(debounceKey);

        dbi.queuedObservers.push(observer);
        dbi.lastRequest = { operation, forward };
        if (dbi.timeout) {
            clearTimeout(dbi.timeout);
        }

        dbi.timeout = setTimeout(() => this.flush(debounceKey), debounceTimeout || this.defaultDelay);
        return dbi.currentGroupId;
    }

    private cleanup = (debounceKey: string, groupId: number) => {
        const dbi = this.debounceInfo[debounceKey];
        if (!dbi) {
            // This can happen if cleanup already got called from somewhere else
            return;
        }
        delete dbi.runningSubscriptions[groupId];

        if (groupId === dbi.currentGroupId) {
            clearTimeout(dbi.timeout);
        }

        const noRunningSubscriptions = Object.keys(dbi.runningSubscriptions).length === 0;
        const noQueuedObservers = dbi.queuedObservers.length === 0;
        if (noRunningSubscriptions && noQueuedObservers) {
            delete this.debounceInfo[debounceKey];
        }
    }

    // flush the currently queued requests
    private flush(debounceKey: string) {
        const dbi = this.debounceInfo[debounceKey];
        if (dbi.queuedObservers.length === 0 || typeof dbi.lastRequest === 'undefined') {
            // The first should never happen, the second is a type guard
            return;
        }
        const { operation, forward } = dbi.lastRequest;
        const currentObservers = [...dbi.queuedObservers];
        const groupId = dbi.currentGroupId;
        const sub = forward(operation).subscribe({
            next: (v: FetchResult) => {
                currentObservers.forEach(observer => observer.next && observer.next(v));
            },
            error: (e: Error) => {
                currentObservers.forEach(observer => observer.error && observer.error(e));
                this.cleanup(debounceKey, groupId);
            },
            complete: () => {
                currentObservers.forEach(observer => observer.complete && observer.complete());
                this.cleanup(debounceKey, groupId);
            },
        });
        dbi.runningSubscriptions[dbi.currentGroupId] = {
            subscription: sub,
            observers: currentObservers,
        };
        dbi.queuedObservers = [];
        dbi.currentGroupId++;
    }

    private unsubscribe = (debounceKey: string, debounceGroupId: number, observer: Observer<FetchResult>) => {
        // NOTE(helfer): This breaks if the same observer is
        // used for multiple subscriptions to the same observable.
        // To be fair, I think all Apollo Links will currently execute the request
        // once for every subscriber, so it wouldn't really work anyway.

        // TODO(helfer): Test this extensively

        // TODO(helfer): Why do subscribers seem to unsubscribe when the subscription completes?
        // Isn't that unnecessary?

        const isNotObserver =  (obs: any) => obs !== observer;

        const dbi = this.debounceInfo[debounceKey];

        if (!dbi) {
            // We already cleaned up, no need to do anything any more.
            return;
        }


        // if this observer is in the queue that hasn't been executed yet, remove it
        if (debounceGroupId === dbi.currentGroupId) {
            dbi.queuedObservers = dbi.queuedObservers.filter(isNotObserver);
            if (dbi.queuedObservers.length === 0) {
                this.cleanup(debounceKey, debounceGroupId);
            }
            return;
        }

        // if this observer's observable has already been forwarded, cancel it
        const observerGroup = dbi.runningSubscriptions[debounceGroupId];
        if (observerGroup) {
            observerGroup.observers = observerGroup.observers.filter(isNotObserver);

            // if this was the last observer listening to the forwarded value, unsubscribe
            // from the subscription entirely and do cleanup.
            if (observerGroup.observers.length === 0) {
                observerGroup.subscription.unsubscribe();
                this.cleanup(debounceKey, debounceGroupId);
            }
        }
    }
}
