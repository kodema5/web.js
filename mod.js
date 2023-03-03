// deno cache -r mod.js
// deno run -A build.js

// wraps fetch
//
export {
    ajax,
    ajaxDefaults,
    ajaxFn,
} from 'https://raw.githubusercontent.com/kodema5/ajax.js/main/mod.js'


// for creating web-component
//
export {
    customElement,
    customElementDefaults,
    tmpl,
    wireElement,
} from 'https://raw.githubusercontent.com/kodema5/custom-element.js/main/mod.js'

export {
    wire,
} from 'https://raw.githubusercontent.com/kodema5/wire.js/main/mod.js'


// publish-subscribe using broadcast channel
//
export {
    PubSub,
} from 'https://raw.githubusercontent.com/kodema5/pubsub.js/main/mod.js'


// cache to local-storage
//
export {
    Store,
    // utility functions
    Arr,
    Is,
    Obj,
    Fn,
} from 'https://raw.githubusercontent.com/kodema5/store.js/main/mod.js'


// Waaf.wrap object/string/function/worker as web-worker
// Waaf.proxy for proxy to communicate with wrapped web-worker
//
export * as Waaf
    from 'https://raw.githubusercontent.com/kodema5/waaf.js/main/mod.js'

