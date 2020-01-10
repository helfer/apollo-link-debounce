import DebounceLink, { DebounceOpts } from './DebounceLink';
import {
    ObservableEvent,
    TestSequenceLink,
    toResultValue,
    assertObservableSequence,
} from './TestUtils';
import {
    execute,
    GraphQLRequest,
    ApolloLink,
} from 'apollo-link';
import {
    ExecutionResult,
} from 'graphql';

import gql from 'graphql-tag';
const merge = require('lodash.merge');

describe('DebounceLink', () => {
    let link: ApolloLink;
    let testLink: TestSequenceLink;
    let debounceLink: DebounceLink;

    const DEBOUNCE_TIMEOUT = 500;

    function makeSimpleResponse(value: string): ExecutionResult {
        return {
            data: {
                hello: value,
            },
        };
    }

    const testResponse = makeSimpleResponse('world');

    function makeSimpleSequence(response: ExecutionResult): ObservableEvent[] {
        return [
            {
                type: 'next',
                value: response,
            },
            {
                type: 'complete',
            },
        ];
    }

    function makeSimpleOp(sequence: ObservableEvent[], debounceKey: string, debounceTimeout: number): GraphQLRequest {
        return {
            query: gql`{ hello }`,
            context: {
                debounceKey,
                debounceTimeout,
                testSequence: sequence,
            },
        };
    }

    function makeVariableOp(debounceKey: string, variables: Record<string, any>, debounceOpts: DebounceOpts = { mergeVariables: true }): GraphQLRequest {
        return {
            query: gql`{hello}`,
            variables,
            context: {
                debounceKey,
                debounceOpts,
                testSequence: makeSimpleSequence(testResponse)
            }
        };
    }

    function getTestSubscriber(observedSequence: ObservableEvent[]) {
        return {
            next(value: ExecutionResult) {
                observedSequence.push({
                    type: 'next',
                    value,
                });
            },
            error(e: Error) {
                observedSequence.push({
                    type: 'error',
                    value: e,
                });
            },
            complete() {
                observedSequence.push({ type: 'complete' });
            },
        };
    }

    const testSequence = makeSimpleSequence(testResponse);

    const op = makeSimpleOp(
        testSequence,
        'key1',
    );

    const testError = new Error('Hello darkness my old friend');
    const testErrorSequence = [{ type: 'error', value: testError }];
    const opWithError: GraphQLRequest = {
        query: gql`{ hello }`,
        context: {
            debounceKey: 'key1',
            testSequence: testErrorSequence,
        },
    };

    beforeEach(() => {
        jest.useFakeTimers();
        testLink = new TestSequenceLink();
        debounceLink = new DebounceLink(DEBOUNCE_TIMEOUT);
        link = ApolloLink.from([debounceLink, testLink]);
    });

    it('forwards the operation', () => {
        return new Promise((resolve, reject) => {
            execute(link, op).subscribe({
                next: (data) => undefined,
                error: (error) => reject(error),
                complete: () => {
                    expect(testLink.operations.length).toBe(1);
                    expect(testLink.operations[0].query).toEqual(op.query);
                    resolve();
                },
            });
            jest.runAllTimers();
        });
    });
    it('forwards the operation if context.debounceKey is not defined', () => {
        const opWithoutKey: GraphQLRequest = {
            query: gql`{ hello }`,
            context: {
                testSequence: makeSimpleSequence(testResponse),
            },
        };
        return new Promise((resolve, reject) => {
            execute(link, opWithoutKey).subscribe({
                next: (data) => undefined,
                error: (error) => reject(error),
                complete: () => {
                    expect(testLink.operations.length).toBe(1);
                    expect(testLink.operations[0].query).toEqual(op.query);
                    resolve();
                },
            });
            jest.runAllTimers();
        });
    });
    it('calls next and complete as expected', () => {
        return Promise.resolve(assertObservableSequence(
            execute(link, op),
            [
                { type: 'next', value: testResponse },
                { type: 'complete' },
            ],
            () => jest.runAllTimers(),
        ));
    });
    it('passes through errors', () => {
        return Promise.resolve(assertObservableSequence(
            execute(link, opWithError),
            [
                { type: 'error', value: testError },
            ],
            () => jest.runAllTimers(),
        ));
    });
    it('debounces multiple queries within the debounce interval', () => {
        const observedSequence: ObservableEvent[] = [];
        const subscriber = getTestSubscriber(observedSequence);

        const s1 = execute(link, op).subscribe(subscriber);
        jest.runTimersToTime(DEBOUNCE_TIMEOUT - 1);
        // check that query did not execute.
        expect(testLink.operations.length).toBe(0);
        expect(observedSequence.length).toBe(0);

        // make another query, different params.
        const op2 = makeSimpleOp(
            makeSimpleSequence(makeSimpleResponse('op2')),
            'key1',
        );
        const s2 = execute(link, op2).subscribe(subscriber);
        jest.runTimersToTime(DEBOUNCE_TIMEOUT - 1);
        // check that query did not execute
        expect(testLink.operations.length).toBe(0);
        expect(observedSequence.length).toBe(0);

        // make another query, different params
        const op3sequence = makeSimpleSequence(makeSimpleResponse('op3'));
        const op3 = makeSimpleOp(
            op3sequence,
            'key1',
        );
        op3.operationName = 'op3';
        const s3 = execute(link, op3).subscribe(subscriber);
        jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);
        // check that all queries returned the sequence of the last query.
        const expectedSequence = [
            toResultValue(op3sequence[0]),
            toResultValue(op3sequence[0]),
            toResultValue(op3sequence[0]),
            toResultValue(op3sequence[1]),
            toResultValue(op3sequence[1]),
            toResultValue(op3sequence[1]),
        ];

        expect(testLink.operations.length).toEqual(1);
        expect(testLink.operations[0].operationName).toBe(op3.operationName);
        expect(observedSequence.length).toEqual(6);
        expect(observedSequence).toEqual(expectedSequence);
        s1.unsubscribe();
        s2.unsubscribe();
        s3.unsubscribe();
    });
    it('debounces multiple queries within the custom debounce interval provided in context', () => {
        const observedSequence: ObservableEvent[] = [];
        const subscriber = getTestSubscriber(observedSequence);
        const customDebounceTimeout = DEBOUNCE_TIMEOUT / 4;

        const op0 = makeSimpleOp(
            testSequence,
            'key1',
            customDebounceTimeout,
        );

        const s1 = execute(link, op0).subscribe(subscriber);
        jest.runTimersToTime(customDebounceTimeout - 1);
        // check that query did not execute.
        expect(testLink.operations.length).toBe(0);
        expect(observedSequence.length).toBe(0);

        // make another query, different params.
        const op2 = makeSimpleOp(
            makeSimpleSequence(makeSimpleResponse('op2')),
            'key1',
            customDebounceTimeout,
        );
        const s2 = execute(link, op2).subscribe(subscriber);
        jest.runTimersToTime(customDebounceTimeout - 1);
        // check that query did not execute
        expect(testLink.operations.length).toBe(0);
        expect(observedSequence.length).toBe(0);

        // make another query, different params
        const op3sequence = makeSimpleSequence(makeSimpleResponse('op3'));
        const op3 = makeSimpleOp(
            op3sequence,
            'key1',
            customDebounceTimeout,
        );
        op3.operationName = 'op3';
        const s3 = execute(link, op3).subscribe(subscriber);
        jest.runTimersToTime(customDebounceTimeout + 1);
        // check that all queries returned the sequence of the last query.
        const expectedSequence = [
            toResultValue(op3sequence[0]),
            toResultValue(op3sequence[0]),
            toResultValue(op3sequence[0]),
            toResultValue(op3sequence[1]),
            toResultValue(op3sequence[1]),
            toResultValue(op3sequence[1]),
        ];

        expect(testLink.operations.length).toEqual(1);
        expect(testLink.operations[0].operationName).toBe(op3.operationName);
        expect(observedSequence.length).toEqual(6);
        expect(observedSequence).toEqual(expectedSequence);
        s1.unsubscribe();
        s2.unsubscribe();
        s3.unsubscribe();
    });
    it('does not debounce queries that are not within the interval', () => {
        // make one query.
        // run timer for debounce + 1
        // check that query executed.
        // make one query.
        // run timer for debounce + 1
        // check that query executed.

        const observedSequence: ObservableEvent[] = [];
        const subscriber = getTestSubscriber(observedSequence);
        const s1 = execute(link, op).subscribe(subscriber);
        jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);
        // check that query did not execute.
        expect(testLink.operations.length).toBe(1);
        expect(observedSequence.length).toBe(2);

        // make another query, different params.
        const op2sequence = makeSimpleSequence(testResponse);
        const op2 = makeSimpleOp(
            op2sequence,
            'key1',
        );
        const s2 = execute(link, op2).subscribe(subscriber);
        jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);
        // check that query executed
        expect(testLink.operations.length).toBe(2);
        expect(observedSequence.length).toBe(4);

        const expectedSequence = [
            toResultValue(testSequence[0]),
            toResultValue(testSequence[1]),
            toResultValue(op2sequence[0]),
            toResultValue(op2sequence[1]),
        ];

        expect(observedSequence).toEqual(expectedSequence);
        s1.unsubscribe();
        s2.unsubscribe();
    });
    it('does not debounce queries with different debounceKey (even within the interval)', () => {
        // make query
        // make another query with different debounceKey
        // run timer for debounce +1.
        // check that both queries ran and returned different values

        const observedSequence: ObservableEvent[] = [];
        const subscriber = getTestSubscriber(observedSequence);
        const s1 = execute(link, op).subscribe(subscriber);

        // make another query, different debounceKey.
        const op2sequence = makeSimpleSequence(testResponse);
        const op2 = makeSimpleOp(
            op2sequence,
            'key2',
        );
        const observedSequence2: ObservableEvent[] = [];
        // Using a different subscriber, just for fun.
        const subscriber2 = getTestSubscriber(observedSequence2);
        const s2 = execute(link, op2).subscribe(subscriber2);

        jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);
        // check that both queries executed

        expect(testLink.operations.length).toBe(2);
        expect(observedSequence.length).toBe(2);
        expect(observedSequence2.length).toBe(2);

        const expectedSequence = [
            toResultValue(testSequence[0]),
            toResultValue(testSequence[1]),
        ];
        const expectedSequence2 = [
            toResultValue(op2sequence[0]),
            toResultValue(op2sequence[1]),
        ];

        expect(observedSequence).toEqual(expectedSequence);
        expect(observedSequence2).toEqual(expectedSequence2);

        s1.unsubscribe();
        s2.unsubscribe();
    });
    it('does not make any query if you unsubscribe before interval is over', () => {
        // make query
        // run timer for debounce -1
        // unsubscribe
        // run timer for debounce +1.
        // check that nothing ran

        const observedSequence: ObservableEvent[] = [];
        const subscriber = getTestSubscriber(observedSequence);
        const s1 = execute(link, op).subscribe(subscriber);

        jest.runTimersToTime(DEBOUNCE_TIMEOUT - 1);

        s1.unsubscribe();

        jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);

        expect(testLink.operations.length).toBe(0);
        expect(observedSequence.length).toBe(0);
    });
    it('correctly debounces a query that errors', () => {
        const observedSequence: ObservableEvent[] = [];
        const subscriber = getTestSubscriber(observedSequence);
        const s1 = execute(link, opWithError).subscribe(subscriber);

        jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);

        expect(testLink.operations.length).toBe(1);
        expect(observedSequence).toEqual(testErrorSequence);

        s1.unsubscribe();
    });
    it('runs the second to last query if the last one was unsubscribed from', () => {
        // make query
        // make another query
        // run timer for debounce -1
        // unsubscribe from second query
        // run timer for debounce +1.
        // check that first query executed and returned value
        const observedSequence: ObservableEvent[] = [];
        const subscriber = getTestSubscriber(observedSequence);
        const s1 = execute(link, op).subscribe(subscriber);

        // make another query
        const op2sequence = makeSimpleSequence(testResponse);
        const op2 = makeSimpleOp(
            op2sequence,
            'key1',
        );
        const observedSequence2: ObservableEvent[] = [];
        // Using a different subscriber, just for fun.
        const subscriber2 = getTestSubscriber(observedSequence2);
        const s2 = execute(link, op2).subscribe(subscriber2);

        jest.runTimersToTime(DEBOUNCE_TIMEOUT - 1);

        s2.unsubscribe();

        jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);

        expect(testLink.operations.length).toBe(1);
        expect(observedSequence.length).toBe(2);
        expect(observedSequence2.length).toBe(0);

        const expectedSequence = [
            toResultValue(testSequence[0]),
            toResultValue(testSequence[1]),
        ];
        expect(observedSequence).toEqual(expectedSequence);

        s1.unsubscribe();
    });
    describe('with variables', () => {
        let variables;
        let mergeVariables;

        const createAndQueueOps = (contextKey = 'key1') => {
            const variableOps = variables.map(v => makeVariableOp(contextKey, v, { mergeVariables }));
            const subscriber = getTestSubscriber([]);
            variableOps.forEach(vo => execute(link, vo).subscribe(subscriber));
        };

        const subject = () => {
            createAndQueueOps();
            jest.runTimersToTime(DEBOUNCE_TIMEOUT + 1);
        };

        beforeEach(() => {
            variables = [{ a: 5, b: { c: 6 } }, { b: { d: 4 } }, { e: 3 }];
            mergeVariables = true;
        });
        it('merges the operation variables key with the mergeVariables opt set', () => {
            subject();

            expect(testLink.operations.length).toEqual(1);
            expect(testLink.operations[0].variables).toEqual(variables.reduce(merge, {}));
        });
        it('does not merge the operation variables when the mergeVariables opt is false', () => {
            mergeVariables = false;
            subject();

            expect(testLink.operations.length).toEqual(1);
            expect(testLink.operations[0].variables).toEqual(variables.slice(-1)[0]);
        });
        it('merges only variables within an interval', () => {
            subject();

            variables = [{ d: 5 }];
            subject();

            expect(testLink.operations.length).toEqual(2);
            expect(testLink.operations[1].variables).toEqual(variables[0]);
        });
        it('merges variables with separate debounce keys separately', () => {
            createAndQueueOps('key2');
            const mergedVariables = variables.reduce(merge, {});
            variables = [{ d: 5 }];
            subject();

            expect(testLink.operations.length).toEqual(2);
            expect(testLink.operations[0].variables).toEqual(mergedVariables);
            expect(testLink.operations[1].variables).toEqual(variables.reduce(merge, {}));
        });
    });
});
})
