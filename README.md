# apollo-link-debounce

[![npm version](https://badge.fury.io/js/apollo-link-debounce.svg)](https://badge.fury.io/js/apollo-link-debounce)
[![Build Status](https://travis-ci.org/helfer/apollo-link-debounce.svg?branch=master)](https://travis-ci.org/helfer/apollo-link-debounce)
[![codecov](https://codecov.io/gh/helfer/apollo-link-debounce/branch/master/graph/badge.svg)](https://codecov.io/gh/helfer/apollo-link-debounce)

An Apollo Link that debounces requests made within a certain interval of each other.

### Motivation

Sometimes it can be useful to debounce updates by the user before sending them to the server if all that matters is the final state, for example the value at which a slider comes to rest after being moved by the user. You could debounce the slider event at the component level, but that's not always an option when there are other parts of the UI that depend on having the most up-to-date information on the slider position.

Apollo-link-debounce can help in such situations by allowing you to debounce requests. Slider position, for example, could be debounced such that if multiple slider events happen within 100ms of each other, only the last position update (mutation) gets sent to the server. Once the server response comes back, all subscribers will receive the response to the last event. (Another option would be to immediately complete all but the last request. If you need that, feel free to make a PR implementing it!)

It is possible to debounce different events separately by setting different debounce keys. For example: if there are two sliders, they can use separate debounce keys (eg. the slider's name) to ensure that their updates don't get mixed up together.

Read more about debounce [here](https://john-dugan.com/javascript-debounce/).
See a real-world example of using a debounce link [here](https://github.com/helfer/zetteli/blob/817e43c598d55b81983b19cac4ff9f1b199d0e28/client/src/services/GraphQLClient.ts#L88).

### Installation

```sh
npm install apollo-link-debounce
```

or

```
yarn add apollo-link-debounce
```

### Usage

```js
import { ApolloLink } from 'apollo-link';
import { HttpLink } from 'apollo-link-http';
import { RetryLink } from 'apollo-link-retry';
import gql from 'graphql-tag';

import DebounceLink from 'apollo-link-debounce';

const DEBOUNCE_TIMEOUT = 100;
this.link = ApolloLink.from([
    new DebounceLink(DEBOUNCE_TIMEOUT),
    new HttpLink({ uri: URI_TO_YOUR_GRAPHQL_SERVER }),
]);

const op = {
    query: gql`mutation slide($val: Float){ moveSlider(value: $val) }`,
    variables: { val: 99 }
    context: {
        // Requests get debounced together if they share the same debounceKey.
        // Requests without a debounce key are passed to the next link unchanged.
        debounceKey: '1',
    },
};

const op2 = {
    query: gql`mutation slide($val: Float){ moveSlider(value: $val) }`,
    variables: { val: 100 },
    context: {
        // Requests get debounced together if they share the same debounceKey.
        // Requests without a debounce key are passed to the next link unchanged.
        debounceKey: '1',
    },
};

// No debounce key, so this request does not get debounced
const op3 = {
    query: gql`{ hello }`, // Server returns "World!"
};

link.execute(op).subscribe({
    next(response) { console.log('A', response.data.moveSlider); },
    complete() { console.log('A complete!'); },
});
link.execute(op2).subscribe({
    next(response) { console.log('B', response.data.moveSlider); },
    complete() { console.log('B complete!'); },
});
link.execute(op3).subscribe({
    next(response) { console.log('Hello', response.data.hello); },
    complete() { console.log('Hello complete!'); },
});

// Assuming the server responds with the value that was set, this will print
// -- no delay --
// Hello World!
// Hello complete!
// -- 100 ms delay --
// A 100 (after 100ms)
// A complete!
// B 100
// B complete!
```
