let processBody = (data, type)=>{
    switch(type){
        case "any":
            return data;
        case "text":
            return data ? data.toString() : data;
        case "json":
            return JSON.stringify(data);
    }
    throw new Error('unknown request data type');
};
let processResponse = (res, type)=>{
    switch(type){
        case 'arrayBuffer':
            return res.arrayBuffer();
        case 'blob':
            return res.blob();
        case 'formData':
            return res.formData();
        case 'json':
            return res.json();
        case 'text':
            return res.text();
    }
    throw new Error('unknown response type');
};
let ajaxDefaults = {
    baseHref: '',
    timeout: 0,
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    requestType: 'json',
    responseType: 'json'
};
function ajax({ url , data , body , input =(a)=>a , output =(a)=>a , baseHref =ajaxDefaults.baseHref , method =ajaxDefaults.method , headers =ajaxDefaults.headers , timeout =ajaxDefaults.timeout , requestType =ajaxDefaults.requestType , responseType =ajaxDefaults.responseType  } = {}) {
    if (!url) throw new Error('url required');
    url = url.indexOf('http') < 0 && baseHref ? baseHref + url : url;
    data = input(data);
    let opt = {
        method,
        headers: {
            ...headers
        }
    };
    let hasBody = !(method === 'GET' || method === 'HEAD');
    if (hasBody) {
        opt.body = body || processBody(data, requestType);
    }
    let Abort = new AbortController();
    opt.signal = Abort.signal;
    let p = new Promise(async (ok, err)=>{
        let tId;
        if (timeout) {
            tId = setTimeout(()=>{
                Abort.abort();
            }, timeout);
        }
        opt.signal.onabort = ()=>{
            err(new Error('aborted'));
        };
        try {
            let res = await fetch(url, opt);
            if (tId) clearTimeout(tId);
            if (!res.ok) {
                await res.body.cancel();
                throw {
                    [res.status]: res.statusText
                };
            }
            let body = await processResponse(res, responseType);
            ok(await output(body));
        } catch (e) {
            err(e);
        }
    });
    p.abort = ()=>Abort.abort();
    return p;
}
const isObject = (a)=>a !== null && a instanceof Object && a.constructor === Object;
const ajaxFn = (cfg)=>async (data)=>{
        let a = await ajax({
            ...cfg,
            data: {
                ...cfg.data || {},
                ...data
            }
        });
        if (isObject(a)) {
            let { data: d , errors  } = a;
            if (Boolean(d) ^ Boolean(errors)) {
                if (errors) throw errors;
                return d;
            }
        }
        return a;
    };
let STRIP_COMMENTS = /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|(\s*=[^,\)]*(('(?:\\'|[^'\r\n])*')|("(?:\\"|[^"\r\n])*"))|(\s*=[^,\)]*))/mg;
let ARGUMENT_NAMES = /([^\s,]+)/g;
function getArgNames(func) {
    if (typeof func !== "function") return [];
    let fnStr = func.toString().replace(STRIP_COMMENTS, '');
    let arr = fnStr.slice(fnStr.indexOf('(') + 1, fnStr.indexOf(')')).match(ARGUMENT_NAMES);
    return arr ?? [];
}
let queryArg = (obj, path)=>{
    if (!obj || typeof obj !== 'object') return;
    let n = path.length;
    if (n === 0) return;
    var cur = obj;
    var val = undefined;
    for (let n of path){
        if (!cur.hasOwnProperty(n)) {
            val = undefined;
            break;
        }
        val = cur = cur[n];
    }
    return val;
};
let queryArgs = (ctx, names, delimiter = '$')=>{
    return Array.from(names).map((n)=>n.split(delimiter).filter(Boolean)).filter(Boolean).map((ns)=>queryArg(ctx, ns));
};
let equalArgs = (args1, args2)=>{
    if (args1.length !== args2.length) return false;
    return args1.every((a, i)=>{
        let b = args2[i];
        return typeof a == 'object' ? a == b : a === b;
    });
};
class MemoFunction {
    constructor(func){
        this.func = func;
        this.argNames = getArgNames(func);
    }
    call(thisArg) {
        if (this.argNames.length === 0) {
            return this.func.call(thisArg);
        }
        if (arguments.length === 0) {
            return this.curOutput;
        }
        return this.apply(thisArg, queryArgs(thisArg, this.argNames));
    }
    apply(thisArg, args) {
        let f = arguments.length === 0 || this.curArgs && equalArgs(args, this.curArgs);
        if (f) return this.curOutput;
        this.curArgs = args;
        this.curOutput = this.func.apply(thisArg, args);
        return this.curOutput;
    }
}
let Tmpl = class {
    constructor(strings, funcs){
        this.strings = strings;
        this.functions = funcs.map((f)=>{
            return typeof f === 'function' ? new MemoFunction(f) : ()=>f;
        });
    }
    build(context) {
        let n = arguments.length;
        return this.strings.map((str, indx)=>{
            let f = this.functions[indx];
            let t = f ? n === 0 ? f.call() : f.call(context) : '';
            if (t && t instanceof Tmpl) {
                t = context ? t.build(context) : t.build();
            }
            return [
                str,
                t
            ];
        }).flat().filter(Boolean).join('');
    }
};
let tmpl = (strings, ...funcs)=>{
    return new Tmpl(strings, funcs);
};
let wire = (root, cfg, arg)=>new Circuit(root, cfg, arg);
let Circuit = class {
    constructor(rootEl, eventConfigs, { thisObj ={} , queryFnName ='querySelectorAll' , listenFnName ='addEventListener' , unlistenFnName ='removeEventListener' , notifyFnName ='dispatchEvent' , validator =(e)=>e.parentNode  } = {}){
        let me = this;
        me.rootEl = rootEl;
        me.nodes = {};
        me.wires = new WeakMap();
        me.funcs = {
            queryFnName,
            listenFnName,
            unlistenFnName,
            notifyFnName,
            validator
        };
        me.this = new Proxy(thisObj, {
            get (_, name) {
                if (name === 'top_' && !('top_' in thisObj)) return me;
                if (name === 'fire_' && !('fire_' in thisObj)) return me.fire.bind(me);
                return me.nodes && me.nodes[name] || Reflect.get(...arguments);
            },
            deleteProperty (_, name) {
                if (!me.nodes || !me.nodes[name]) {
                    return Reflect.deleteProperty(...arguments);
                }
                let el = me.nodes[name];
                me.dewire(el);
                delete me.nodes[name];
            }
        });
        Object.entries(eventConfigs).forEach(([qry, eventConfig])=>{
            if (typeof eventConfig === 'function') {
                let eventConfigFn = eventConfig;
                me.#getElems(qry).forEach((el, i, arr)=>{
                    let a = eventConfigFn.call(me.this, el, i, arr);
                    let { cfg , nodeId  } = me.#getCfg(a);
                    me.wire(el, cfg, nodeId);
                });
            } else {
                let { cfg , nodeId  } = me.#getCfg(eventConfig);
                me.#getElems(qry).forEach((el, i, arr)=>{
                    me.wire(el, cfg, nodeId);
                });
            }
        });
    }
    #getElems(qry) {
        let me = this;
        let queryFnName = me.funcs.queryFnName;
        let isRoot = qry === '.';
        return isRoot ? [
            me.rootEl
        ] : [
            ...me.rootEl[queryFnName](qry)
        ];
    }
    #getCfg(eventConfig) {
        let me = this;
        let meta = {};
        let cfg = Object.fromEntries(Object.entries(eventConfig).filter(([name, val])=>{
            let isConfig = name[0] === '_';
            if (isConfig) {
                let k = name.slice(1);
                meta[k] = val;
                return false;
            }
            return true;
        }));
        let nodeId = meta.id;
        let isConflict = me.this[nodeId] || typeof me.this[nodeId] === 'function';
        if (isConflict) {
            throw new Error(`conflicting nodes "${nodeId}"`);
        }
        return {
            cfg,
            nodeId
        };
    }
    static _id = 0;
    wire(el, events, nodeId) {
        let me = this;
        if (!me.wires.has(el)) {
            me.wires.set(el, []);
            let id = nodeId || `node-${++Circuit._id}`;
            me.nodes[id] = el;
        }
        let listen = me.funcs.listenFnName;
        Object.entries(events).forEach(([type, listener])=>{
            let fn = listener.bind(me.this);
            el[listen](type, fn);
            me.wires.get(el).push([
                type,
                fn
            ]);
        });
    }
    dewire(el) {
        let me = this;
        let wm = me.wires;
        if (!wm.has(el)) return false;
        let unlisten = me.funcs.unlistenFnName;
        wm.get(el).forEach(([type, fn])=>{
            el[unlisten](type, fn);
        });
    }
    delete() {
        let me = this;
        Object.values(me.nodes).forEach((el)=>me.dewire(el));
        me.rootEl = null;
        me.nodes = null;
        me.wires = null;
    }
    clean() {
        let me = this;
        let validate = me.funcs.validator;
        for (let [id, el] of Object.entries(me.nodes)){
            if (el == me.rootEl || validate(el)) continue;
            me.dewire(el);
            delete me.nodes[id];
        }
    }
    nodesThatListenTo(eventName, { isSkipRootEl =false  } = {}) {
        let me = this;
        let wm = me.wires;
        return Object.values(me.nodes).filter((el)=>{
            if (!wm.has(el) || isSkipRootEl && el === me.rootEl) return;
            return wm.get(el).find(([name, _])=>name === eventName);
        });
    }
    fire(evt, { isSkipRootEl =false  } = {}) {
        if (!evt || !evt.type) {
            throw new Error('invalid event');
        }
        let me = this;
        let fn = me.funcs.notifyFnName;
        let eventType = evt.type;
        me.nodesThatListenTo(eventType, {
            isSkipRootEl
        }).forEach((el)=>{
            if (!el[fn]) return;
            el[fn].call(el, evt);
        });
    }
};
let customElementDefaults = {
    header: '',
    footer: ''
};
let customElement = (template, { _header =customElementDefaults.header , _footer =customElementDefaults.footer , _wires ={} , _attributes ={} , _formAssociated =true , ...context } = {}, { HTMLElement =globalThis.HTMLElement , document =globalThis.document , CustomEvent =globalThis.CustomEvent  } = {})=>{
    return class extends HTMLElement {
        static formAssociated = _formAssociated;
        constructor(){
            super();
            this.template_ = template;
            this.context_ = Object.assign({
                root_: this,
                build_: this.build.bind(this),
                fire_: this.fire.bind(this)
            }, context);
            this.wiresConfig = _wires;
            this.attachShadow({
                mode: 'open'
            });
            this.build();
        }
        build(updateContext = {}) {
            if (this.wires_) {
                this.wires_.delete();
            }
            Object.assign(this.context_, updateContext);
            let r = this.shadowRoot;
            while(r.firstChild){
                r.removeChild(r.firstChild);
            }
            let t = document.createElement('template');
            t.innerHTML = [
                _header,
                template.build(this.context_),
                _footer
            ].filter(Boolean).join('');
            r.appendChild(t.content.cloneNode(true));
            t = null;
            this.wires_ = wire(r, this.wiresConfig, {
                thisObj: this.context_
            });
            this.this = this.wires_.this;
        }
        fire(ev) {
            this.wires_.fire(ev);
            this.dispatchEvent(ev);
        }
        connectedCallback() {
            let me = this;
            let ev = new CustomEvent('connected', {
                detail: null
            });
            me.fire(ev);
        }
        disconnectedCallback() {
            let me = this;
            let ev = new CustomEvent('disconnected', {
                detail: null
            });
            me.fire(ev);
        }
        adoptedCallback() {
            let me = this;
            let ev = new CustomEvent('adopted', {
                detail: null
            });
            me.fire(ev);
        }
        static get observedAttributes() {
            return Object.keys(_attributes);
        }
        attributeChangedCallback(name, oldValue, value) {
            let f = _attributes[name];
            if (f && typeof f === 'function') {
                f.call(this.context_, value, oldValue);
            }
            let me = this;
            let ev = new CustomEvent('attribute_changed', {
                detail: {
                    name,
                    value,
                    oldValue
                }
            });
            me.fire(ev);
        }
    };
};
let wireElement = (rootEl, template, cfg, { document =globalThis.document  } = {})=>{
    return new WiredElement(rootEl, template, cfg, {
        document
    });
};
let WiredElement = class {
    constructor(rootEl, template, { _wires ={} , ...context } = {}, { document =globalThis.document  }){
        this.root = rootEl;
        this.template_ = template;
        this.context_ = Object.assign({
            root_: this,
            build_: this.build.bind(this),
            fire_: this.fire.bind(this)
        }, context);
        this.wiresConfig = _wires;
        this.document = document;
        this.build();
    }
    build(updateContext = {}) {
        if (this.wires_) {
            this.wires_.delete();
        }
        Object.assign(this.context_, updateContext);
        let r = this.root;
        while(r.firstChild){
            r.removeChild(r.firstChild);
        }
        let t = this.document.createElement('template');
        t.innerHTML = this.template_.build(this.context_), r.appendChild(t.content.cloneNode(true));
        t = null;
        this.wires_ = wire(r, this.wiresConfig, {
            thisObj: this.context_
        });
        this.this = this.wires_.this;
    }
    fire(ev) {
        this.wires_.fire(ev, {
            isSkipRootEl: true
        });
        this.root.dispatchEvent(ev);
    }
};
class PubSub {
    constructor({ broadcastChannelId  }){
        var me = this;
        me._id = 0;
        me.channels = {};
        if (broadcastChannelId) {
            let bc = new BroadcastChannel(broadcastChannelId);
            bc.onmessage = (ev)=>{
                let { channel , args  } = ev.data;
                me.publish_.apply(me, [
                    channel
                ].concat(args));
            };
            me.broadcastChannel = bc;
        }
    }
    reset() {
        this._id = 0;
        this.channels = {};
    }
    channelId(id) {
        let [ch, ...ns] = (id || '').split('.');
        return [
            ch,
            ns.join('.') || `_${++this._id}`
        ];
    }
    subscribe(id, fn, override = false) {
        let [ch, n] = this.channelId(id);
        if (!ch) return;
        let channels = this.channels;
        if (!channels[ch]) channels[ch] = {};
        let subs = channels[ch];
        if (subs[n] && !override) {
            throw new Error(`subscribe: ${id} already exists`);
        }
        subs[n] = fn;
        return [
            ch,
            n
        ].join('.');
    }
    unsubscribe() {
        let me = this;
        Array.from(arguments).flat().forEach((id)=>{
            let [ch, n] = me.channelId(id);
            if (!ch) return;
            let subs = me.channels[ch];
            if (!subs) return;
            delete subs[n];
        });
    }
    publish_(ch, ...args) {
        let subs = this.channels[ch];
        if (!subs) return;
        Object.values(subs).forEach((fn)=>{
            fn.apply(null, args);
        });
    }
    publish(channel, ...args) {
        let broadcast = channel.slice(-1) === '!';
        channel = broadcast ? channel.slice(0, -1) : channel;
        if (broadcast && this.broadcastChannel) {
            this.broadcastChannel.postMessage({
                channel,
                args
            });
        }
        return this.publish_.apply(this, [
            channel
        ].concat(args));
    }
    async exec(ch, ...args) {
        let subs = this.channels[ch];
        if (!subs) return;
        let fns = Object.values(subs).map((fn)=>fn.apply(null, args));
        let arr = await Promise.all(fns);
        return Object.keys(subs).reduce((x, id, i)=>{
            x[id] = arr[i];
            return x;
        }, {});
    }
}
const WEB_PUBSUB_BROADCAST_CHANNEL_ID = globalThis.WEB_PUBSUB_BROADCAST_CHANNEL_ID || 'web-pubsub-broadcast-channel-id';
let pubsub = new PubSub({
    broadcastChannelId: WEB_PUBSUB_BROADCAST_CHANNEL_ID
});
pubsub.publish.bind(pubsub);
pubsub.subscribe.bind(pubsub);
pubsub.unsubscribe.bind(pubsub);
pubsub.exec.bind(pubsub);
const isEmpty = (a)=>a == null || a === '' || Array.isArray(a) && a.length === 0;
const isString = (a)=>typeof a === 'string';
const isBoolean = (a)=>typeof a === 'boolean';
const isFunction = (a)=>typeof a === 'function';
const isObject1 = (a)=>a !== null && a instanceof Object && a.constructor === Object;
const mod = {
    isEmpty: isEmpty,
    isString: isString,
    isBoolean: isBoolean,
    isFunction: isFunction,
    isObject: isObject1
};
let clean = (obj)=>{
    let v = {};
    for(let k in obj){
        let a = obj[k];
        if (isEmpty(a)) continue;
        v[k] = a;
    }
    return v;
};
let set = (root, path, value)=>{
    let keys = path.split('.');
    let lastKey = keys.pop();
    var r = root || {};
    keys.forEach((k)=>{
        if (!r.hasOwnProperty(k)) r[k] = {};
        r = r[k];
    });
    r[lastKey] = value;
    return root;
};
let get = (root, path, defaultValue)=>{
    let keys = path.split('.');
    let r = root || {};
    for (let k of keys){
        if (!r.hasOwnProperty(k)) return defaultValue;
        r = r[k];
    }
    return r;
};
let trim = (root, path)=>{
    let keys = path.split('.');
    let lastKey = keys.pop();
    var r = root || {};
    for (let k of keys){
        if (!r.hasOwnProperty(k)) return false;
        r = r[k];
    }
    return delete r[lastKey];
};
let parse = (str, defaultValue)=>{
    try {
        return JSON.parse(str);
    } catch (x) {
        return defaultValue;
    }
};
const mod1 = {
    clean: clean,
    set: set,
    get: get,
    trim: trim,
    parse: parse
};
const from = (val)=>val === undefined || val === null ? [] : Array.isArray(val) ? val : [
        val
    ];
const mod2 = {
    from: from
};
let from1 = (a)=>isFunction(a) ? a : ()=>a;
const mod3 = {
    from: from1
};
class Store {
    constructor(id, { initial ={} , store =globalThis.sessionStorage  } = {}){
        if (!id) throw new Error('store id required');
        this.id = id;
        this.value = initial;
        this.store = store;
    }
    set(path, values) {
        this.value = mod1.set(this.value || {}, path, values);
        this.save();
        return this;
    }
    get(path, defaultValue) {
        return this.value && path ? mod1.get(this.value, path, defaultValue) : this.value;
    }
    trim(path) {
        if (path) {
            mod1.trim(this.value, path);
        } else {
            this.value = {};
        }
        return this;
    }
    save() {
        this.store.setItem(this.id, JSON.stringify(this.value));
        return this;
    }
    load() {
        let s = this.store.getItem(this.id);
        this.value = mod1.parse(s) || {};
        return this;
    }
    reset() {
        this.value = {};
        this.store.removeItem(this.id);
        return this;
    }
}
let wrap = (w)=>{
    if (w instanceof Worker) {
        return wrap_worker(w);
    }
    let src;
    if (typeof w === 'function') {
        src = `(${proxy})(${w})`;
    } else if (w instanceof Object && w.constructor === Object) {
        src = `(${proxy})(${toSrc(w)})`;
    } else if (typeof w === 'string') {
        src = w;
    }
    if (!src) throw new Error('unsupported type');
    let b = new Blob([
        src
    ], {
        type: 'text/javascript'
    });
    let u = URL.createObjectURL(b);
    let a = new Worker(u, "Deno" in globalThis ? {
        type: 'module'
    } : {});
    return wrap_worker(a);
};
let toSrc = (obj)=>{
    return `{ ${Object.entries(obj).map(([key, val])=>{
        return `${key}:${typeof val === 'function' ? val + '' : JSON.stringify(val)}`;
    }).join(',')} }`;
};
let wrap_worker = (w)=>{
    let _id = 0;
    let _cb = {};
    let fn = (...args)=>new Promise((ok, err)=>{
            let id = ++_id;
            w.postMessage({
                id,
                args
            });
            _cb[id] = {
                ok,
                err
            };
        });
    w.onmessage = (e)=>{
        if (!e) return;
        let { id , data , error  } = e.data || {};
        if (!id) return;
        let cb = _cb[id];
        if (!cb) return;
        delete _cb[id];
        let { ok , err  } = cb;
        return error ? err(error) : ok(data);
    };
    return new Proxy(fn, {
        get (_, prop) {
            if (prop === '__worker') {
                return w;
            }
            return (...args)=>new Promise((ok, err)=>{
                    let id = ++_id;
                    w.postMessage({
                        id,
                        fn: prop,
                        args
                    });
                    _cb[id] = {
                        ok,
                        err
                    };
                });
        }
    });
};
let proxy = (arg, scope = null)=>{
    let Fn = {};
    if (typeof arg === 'function') {
        Fn._ = arg;
    } else if (arg !== null && arg instanceof Object && arg.constructor === Object) {
        Fn = arg;
    } else {
        throw new Error('please pass function/object');
    }
    globalThis.onmessage = function(e) {
        if (!e) return;
        let { id , fn ='_' , args  } = e.data || {};
        {
            (async ()=>{
                var p = {
                    id
                };
                try {
                    if (!Fn.hasOwnProperty(fn)) {
                        throw new Error('undefined property');
                    }
                    let f = Fn[fn];
                    let isFn = typeof f === 'function';
                    p.data = isFn ? await f.apply(scope || Fn, args) : f;
                    if (!isFn && args.length > 0) {
                        Fn[fn] = args[0];
                    }
                } catch (e) {
                    p.error = e;
                }
                globalThis.postMessage(p);
            })();
        }
    };
};
const mod4 = {
    wrap,
    wrap_worker,
    proxy
};
export { ajax as ajax, ajaxDefaults as ajaxDefaults, ajaxFn as ajaxFn };
export { customElement as customElement, customElementDefaults as customElementDefaults, tmpl as tmpl, wireElement as wireElement };
export { wire as wire };
export { PubSub as PubSub };
export { Store as Store, mod2 as Arr, mod as Is, mod1 as Obj, mod3 as Fn };
export { mod4 as Waaf };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L2FqYXguanMvbWFpbi9zcmMvaW5kZXguanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9tZW1vLWZ1bmN0aW9uLmpzL21haW4vc3JjL21lbW8uanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS90bXBsLmpzL21haW4vc3JjL3RtcGwuanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS93aXJlLmpzL21haW4vc3JjL3dpcmUuanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9jdXN0b20tZWxlbWVudC5qcy9tYWluL3NyYy9jdXN0b20tZWxlbWVudC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L2N1c3RvbS1lbGVtZW50LmpzL21haW4vc3JjL3dpcmUtZWxlbWVudC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3B1YnN1Yi5qcy9tYWluL3NyYy9pbmRleC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3N0b3JlLmpzL21haW4vc3JjL2lzLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvb2JqLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvYXJyLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvZm4uanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9zdG9yZS5qcy9tYWluL3NyYy9pbmRleC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3dhYWYuanMvbWFpbi9zcmMvaW5kZXguanMiLCJmaWxlOi8vL1VzZXJzL2hhbi9zcmMva29kZW1hNS9yZWFkbWUuanMvd2ViLmpzL21vZC5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJcclxubGV0IHByb2Nlc3NCb2R5ID0gKGRhdGEsIHR5cGUpID0+IHtcclxuICAgIHN3aXRjaCh0eXBlKSB7XHJcbiAgICAgICAgY2FzZSBcImFueVwiOiByZXR1cm4gZGF0YVxyXG4gICAgICAgIGNhc2UgXCJ0ZXh0XCI6IHJldHVybiBkYXRhID8gZGF0YS50b1N0cmluZygpIDogZGF0YVxyXG4gICAgICAgIGNhc2UgXCJqc29uXCI6IHJldHVybiBKU09OLnN0cmluZ2lmeShkYXRhKVxyXG4gICAgfVxyXG5cclxuICAgIHRocm93IG5ldyBFcnJvcigndW5rbm93biByZXF1ZXN0IGRhdGEgdHlwZScpXHJcbn1cclxuXHJcbmxldCBwcm9jZXNzUmVzcG9uc2UgPSAocmVzLCB0eXBlKSA9PiB7XHJcbiAgICBzd2l0Y2godHlwZSkge1xyXG4gICAgICAgIGNhc2UgJ2FycmF5QnVmZmVyJzogcmV0dXJuIHJlcy5hcnJheUJ1ZmZlcigpXHJcbiAgICAgICAgY2FzZSAnYmxvYic6IHJldHVybiByZXMuYmxvYigpXHJcbiAgICAgICAgY2FzZSAnZm9ybURhdGEnOiByZXR1cm4gcmVzLmZvcm1EYXRhKClcclxuICAgICAgICBjYXNlICdqc29uJzogcmV0dXJuIHJlcy5qc29uKClcclxuICAgICAgICBjYXNlICd0ZXh0JzogcmV0dXJuIHJlcy50ZXh0KClcclxuICAgIH1cclxuXHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Vua25vd24gcmVzcG9uc2UgdHlwZScpXHJcbn1cclxuXHJcbmV4cG9ydCBsZXQgYWpheERlZmF1bHRzID0ge1xyXG4gICAgYmFzZUhyZWY6JycsXHJcbiAgICB0aW1lb3V0OiAwLFxyXG5cclxuICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgaGVhZGVyczoge1xyXG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbidcclxuICAgIH0sXHJcblxyXG4gICAgcmVxdWVzdFR5cGU6ICdqc29uJywgLy8ganNvbiwgdGV4dCwgYW55XHJcbiAgICByZXNwb25zZVR5cGU6ICdqc29uJywgLy8gYXJyYXlCdWZmZXIsIGJsb2IsIGZvcm1EYXRhLCBqc29uLCB0ZXh0LFxyXG59XHJcblxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGFqYXggKHtcclxuICAgIHVybCxcclxuICAgIGRhdGEsXHJcbiAgICBib2R5LCAvLyBmb3IgRm9ybURhdGEsIFVSTFNlYXJjaFBhcmFtcywgc3RyaW5nLCBldGNcclxuXHJcbiAgICAvLyB0cmFuc2Zvcm1lci92YWxpZGF0b3JcclxuICAgIGlucHV0ID0gKGEpID0+IGEsXHJcbiAgICBvdXRwdXQgPSAoYSkgPT4gYSxcclxuXHJcbiAgICBiYXNlSHJlZiA9IGFqYXhEZWZhdWx0cy5iYXNlSHJlZixcclxuICAgIG1ldGhvZCA9IGFqYXhEZWZhdWx0cy5tZXRob2QsXHJcbiAgICBoZWFkZXJzID0gYWpheERlZmF1bHRzLmhlYWRlcnMsXHJcbiAgICB0aW1lb3V0ID0gYWpheERlZmF1bHRzLnRpbWVvdXQsXHJcbiAgICByZXF1ZXN0VHlwZSA9IGFqYXhEZWZhdWx0cy5yZXF1ZXN0VHlwZSxcclxuICAgIHJlc3BvbnNlVHlwZSA9IGFqYXhEZWZhdWx0cy5yZXNwb25zZVR5cGUsXHJcbn0gPSB7fSkge1xyXG5cclxuICAgIGlmICghdXJsKSB0aHJvdyBuZXcgRXJyb3IoJ3VybCByZXF1aXJlZCcpXHJcblxyXG4gICAgdXJsID0gdXJsLmluZGV4T2YoJ2h0dHAnKSA8IDAgJiYgYmFzZUhyZWZcclxuICAgICAgICA/IGJhc2VIcmVmICsgdXJsXHJcbiAgICAgICAgOiB1cmxcclxuXHJcbiAgICBkYXRhID0gaW5wdXQoZGF0YSlcclxuXHJcbiAgICBsZXQgb3B0ID0ge1xyXG4gICAgICAgIG1ldGhvZCxcclxuICAgICAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgICAgIC4uLihoZWFkZXJzKVxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBsZXQgaGFzQm9keSA9ICEobWV0aG9kPT09J0dFVCcgfHwgbWV0aG9kPT09J0hFQUQnKVxyXG4gICAgaWYgKGhhc0JvZHkpIHtcclxuICAgICAgICBvcHQuYm9keSA9IGJvZHkgfHwgcHJvY2Vzc0JvZHkoZGF0YSwgcmVxdWVzdFR5cGUpXHJcbiAgICB9XHJcblxyXG4gICAgbGV0IEFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpXHJcbiAgICBvcHQuc2lnbmFsID0gQWJvcnQuc2lnbmFsXHJcblxyXG4gICAgbGV0IHAgPSBuZXcgUHJvbWlzZShhc3luYyAob2ssIGVycikgPT4ge1xyXG4gICAgICAgIGxldCB0SWRcclxuICAgICAgICBpZiAodGltZW91dCkge1xyXG4gICAgICAgICAgICB0SWQgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgICAgIEFib3J0LmFib3J0KClcclxuICAgICAgICAgICAgfSwgdGltZW91dClcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIG9wdC5zaWduYWwub25hYm9ydCA9ICgpID0+IHtcclxuICAgICAgICAgICAgZXJyKG5ldyBFcnJvcignYWJvcnRlZCcpKVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgbGV0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwgb3B0KVxyXG5cclxuICAgICAgICAgICAgaWYgKHRJZCkgY2xlYXJUaW1lb3V0KHRJZClcclxuXHJcbiAgICAgICAgICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCByZXMuYm9keS5jYW5jZWwoKVxyXG4gICAgICAgICAgICAgICAgdGhyb3cge1xyXG4gICAgICAgICAgICAgICAgICAgIFtyZXMuc3RhdHVzXTogcmVzLnN0YXR1c1RleHRcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgbGV0IGJvZHkgPSBhd2FpdCBwcm9jZXNzUmVzcG9uc2UocmVzLCByZXNwb25zZVR5cGUpXHJcblxyXG4gICAgICAgICAgICBvayhhd2FpdCBvdXRwdXQoYm9keSkpXHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNhdGNoKGUpIHtcclxuICAgICAgICAgICAgZXJyKGUpXHJcbiAgICAgICAgfVxyXG4gICAgfSlcclxuXHJcbiAgICBwLmFib3J0ID0gKCkgPT4gQWJvcnQuYWJvcnQoKVxyXG5cclxuICAgIHJldHVybiBwXHJcbn1cclxuXHJcbi8vIHdyYXBzIGFqYXgtY2FsbCBhcyBhIGZ1bmN0aW9uXHJcbi8vXHJcbmNvbnN0IGlzT2JqZWN0ID0gKGEpID0+IChhICE9PSBudWxsICYmIGEgaW5zdGFuY2VvZiBPYmplY3QgJiYgYS5jb25zdHJ1Y3RvciA9PT0gT2JqZWN0KVxyXG5cclxuZXhwb3J0IGNvbnN0IGFqYXhGbiA9IChjZmcpID0+IGFzeW5jIChkYXRhKSA9PiB7XHJcbiAgICBsZXQgYSA9IGF3YWl0IGFqYXgoe1xyXG4gICAgICAgIC4uLihjZmcpLFxyXG4gICAgICAgIGRhdGE6IHtcclxuICAgICAgICAgICAgLi4uKGNmZy5kYXRhIHx8IHt9KSxcclxuICAgICAgICAgICAgLi4uKGRhdGEpXHJcbiAgICAgICAgfVxyXG4gICAgfSlcclxuXHJcbiAgICAvLyBwcm9jZXNzIGRhdGEvZXJyb3JzLFxyXG4gICAgLy8gYm9ycm93ZWQgZnJvbSBncmFwaFFMXHJcbiAgICAvL1xyXG4gICAgaWYgKGlzT2JqZWN0KGEpKSB7XHJcbiAgICAgICAgbGV0IHsgZGF0YTpkLCBlcnJvcnMgfSA9IGFcclxuICAgICAgICBpZiAoQm9vbGVhbihkKSBeIEJvb2xlYW4oZXJyb3JzKSkge1xyXG4gICAgICAgICAgICBpZiAoZXJyb3JzKSB0aHJvdyBlcnJvcnNcclxuICAgICAgICAgICAgcmV0dXJuIGRcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGFcclxufVxyXG4iLCJcbi8vIHJlZjogaHR0cHM6Ly9zdGFja292ZXJmbG93LmNvbS9xdWVzdGlvbnMvMTAwNzk4MS9ob3ctdG8tZ2V0LWZ1bmN0aW9uLXBhcmFtZXRlci1uYW1lcy12YWx1ZXMtZHluYW1pY2FsbHlcbi8vXG5sZXQgU1RSSVBfQ09NTUVOVFMgPSAvKFxcL1xcLy4qJCl8KFxcL1xcKltcXHNcXFNdKj9cXCpcXC8pfChcXHMqPVteLFxcKV0qKCgnKD86XFxcXCd8W14nXFxyXFxuXSkqJyl8KFwiKD86XFxcXFwifFteXCJcXHJcXG5dKSpcIikpfChcXHMqPVteLFxcKV0qKSkvbWc7XG5sZXQgQVJHVU1FTlRfTkFNRVMgPSAvKFteXFxzLF0rKS9nO1xuZnVuY3Rpb24gZ2V0QXJnTmFtZXMoZnVuYykge1xuICAgIGlmICh0eXBlb2YoZnVuYykhPT1cImZ1bmN0aW9uXCIpIHJldHVybiBbXVxuXG4gICAgbGV0IGZuU3RyID0gZnVuY1xuICAgICAgICAudG9TdHJpbmcoKVxuICAgICAgICAucmVwbGFjZShTVFJJUF9DT01NRU5UUywgJycpXG4gICAgbGV0IGFyciA9IGZuU3RyXG4gICAgICAgIC5zbGljZShmblN0ci5pbmRleE9mKCcoJykrMSwgZm5TdHIuaW5kZXhPZignKScpKVxuICAgICAgICAubWF0Y2goQVJHVU1FTlRfTkFNRVMpO1xuICAgIHJldHVybiBhcnIgPz8gW11cbn1cblxuLy8gcXVlcnkgb2JqZWN0IGZvciBwYXRoXG4vL1xubGV0IHF1ZXJ5QXJnID0gKG9iaiwgcGF0aCkgPT4ge1xuICAgIGlmICghb2JqIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm5cblxuICAgIGxldCBuID0gcGF0aC5sZW5ndGhcbiAgICBpZiAobj09PTApIHJldHVyblxuXG4gICAgdmFyIGN1ciA9IG9ialxuICAgIHZhciB2YWwgPSB1bmRlZmluZWRcbiAgICBmb3IgKGxldCBuIG9mIHBhdGgpIHtcbiAgICAgICAgaWYgKCFjdXIuaGFzT3duUHJvcGVydHkobikpIHtcbiAgICAgICAgICAgIHZhbCA9IHVuZGVmaW5lZFxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgfVxuICAgICAgICB2YWwgPSBjdXIgPSBjdXJbbl1cbiAgICB9XG4gICAgcmV0dXJuIHZhbFxufVxuXG4vLyBxdWVyeSBmb3IgZWFjaCBuYW1lc1xuLy9cbmxldCBxdWVyeUFyZ3MgPSAoXG4gICAgY3R4LFxuICAgIG5hbWVzLFxuICAgIGRlbGltaXRlcj0nJCcsIC8vIHZhbGlkIHZhci1uYW1lcyBpcyBbYS16QS1aMC05XyRdXG4pID0+IHtcbiAgICByZXR1cm4gQXJyYXlcbiAgICAgICAgLmZyb20obmFtZXMpXG4gICAgICAgIC5tYXAobiA9PiBuLnNwbGl0KGRlbGltaXRlcikuZmlsdGVyKEJvb2xlYW4pKVxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAgIC5tYXAobnMgPT4gcXVlcnlBcmcoY3R4LCBucykpXG59XG5cblxuLy8gY2hlY2sgaWYgc2FtZVxuLy9cbmxldCBlcXVhbEFyZ3MgPSAoYXJnczEsIGFyZ3MyKSA9PiB7XG5cbiAgICBpZiAoYXJnczEubGVuZ3RoIT09YXJnczIubGVuZ3RoKSByZXR1cm4gZmFsc2VcblxuICAgIHJldHVybiBhcmdzMS5ldmVyeSgoYSwgaSkgPT4ge1xuICAgICAgICBsZXQgYiA9IGFyZ3MyW2ldXG4gICAgICAgIHJldHVybiB0eXBlb2YoYSkgPT0gJ29iamVjdCdcbiAgICAgICAgICAgID8gYSA9PSBiIC8vIGNoZWNrIHBvaW50ZXIgb25seVxuICAgICAgICAgICAgOiBhID09PSBiXG4gICAgfSlcbn1cblxuXG4vLyBjYWNoZXMgbGFzdCBvdXRwdXRcbi8vXG5leHBvcnQgY2xhc3MgTWVtb0Z1bmN0aW9uIHtcblxuICAgIGNvbnN0cnVjdG9yKGZ1bmMpIHtcbiAgICAgICAgdGhpcy5mdW5jID0gZnVuY1xuICAgICAgICB0aGlzLmFyZ05hbWVzID0gZ2V0QXJnTmFtZXMoZnVuYylcbiAgICB9XG5cbiAgICBjYWxsKHRoaXNBcmcpIHtcblxuICAgICAgICBpZiAodGhpcy5hcmdOYW1lcy5sZW5ndGg9PT0wKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5mdW5jLmNhbGwodGhpc0FyZylcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChhcmd1bWVudHMubGVuZ3RoPT09MCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY3VyT3V0cHV0XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5hcHBseShcbiAgICAgICAgICAgIHRoaXNBcmcsXG4gICAgICAgICAgICBxdWVyeUFyZ3ModGhpc0FyZywgdGhpcy5hcmdOYW1lcykpXG4gICAgfVxuXG4gICAgYXBwbHkodGhpc0FyZywgYXJncykge1xuXG4gICAgICAgIGxldCBmID0gKGFyZ3VtZW50cy5sZW5ndGggPT09IDApXG4gICAgICAgICAgICB8fCAoXG4gICAgICAgICAgICAgICAgdGhpcy5jdXJBcmdzXG4gICAgICAgICAgICAgICAgJiYgZXF1YWxBcmdzKGFyZ3MsIHRoaXMuY3VyQXJncylcbiAgICAgICAgICAgIClcbiAgICAgICAgaWYgKGYpIHJldHVybiB0aGlzLmN1ck91dHB1dFxuXG5cbiAgICAgICAgdGhpcy5jdXJBcmdzID0gYXJnc1xuICAgICAgICB0aGlzLmN1ck91dHB1dCA9IHRoaXMuZnVuYy5hcHBseSh0aGlzQXJnLCBhcmdzKVxuICAgICAgICByZXR1cm4gdGhpcy5jdXJPdXRwdXRcbiAgICB9XG59IiwiaW1wb3J0IHsgTWVtb0Z1bmN0aW9uIH0gZnJvbSAnLi9kZXBzLmpzJ1xuXG4vLyByZWZyZXNoYWJsZSBzdHJpbmcgdGVtcGxhdGUgd2l0aCBtZW1vaXplZCBmdW5jdGlvbnNcbi8vXG5sZXQgVG1wbCA9IGNsYXNzIHtcbiAgICBjb25zdHJ1Y3RvcihzdHJpbmdzLCBmdW5jcykge1xuICAgICAgICB0aGlzLnN0cmluZ3MgPSBzdHJpbmdzXG4gICAgICAgIHRoaXMuZnVuY3Rpb25zID0gZnVuY3NcbiAgICAgICAgICAgIC5tYXAoZiA9PiB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHR5cGVvZihmKSA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgICAgICAgICA/IG5ldyBNZW1vRnVuY3Rpb24oZilcbiAgICAgICAgICAgICAgICAgICAgOiAoKCkgPT4gZilcbiAgICAgICAgICAgIH0pXG4gICAgfVxuXG5cbiAgICBidWlsZChjb250ZXh0KSB7XG4gICAgICAgIGxldCBuID0gYXJndW1lbnRzLmxlbmd0aFxuICAgICAgICByZXR1cm4gdGhpcy5zdHJpbmdzXG4gICAgICAgICAgICAubWFwKChzdHIsIGluZHgpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgZiA9IHRoaXMuZnVuY3Rpb25zW2luZHhdXG4gICAgICAgICAgICAgICAgbGV0IHQgPSBmID8gKG49PT0wID8gZi5jYWxsKCk6IGYuY2FsbChjb250ZXh0KSkgOiAnJ1xuICAgICAgICAgICAgICAgIGlmICh0ICYmIHQgaW5zdGFuY2VvZiBUbXBsKSB7XG4gICAgICAgICAgICAgICAgICAgIHQgPSBjb250ZXh0ID8gdC5idWlsZChjb250ZXh0KSA6IHQuYnVpbGQoKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgICAgICAgICBzdHIsXG4gICAgICAgICAgICAgICAgICAgIHQsXG4gICAgICAgICAgICAgICAgXVxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5mbGF0KClcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgICAgIC5qb2luKCcnKVxuICAgIH1cbn1cblxuZXhwb3J0IGxldCB0bXBsID0gKHN0cmluZ3MsIC4uLmZ1bmNzKSA9PiB7XG4gICAgcmV0dXJuIG5ldyBUbXBsKHN0cmluZ3MsIGZ1bmNzKVxufVxuIiwiLy8gd2lyZSBlbGVtZW50cyB3aXRoIGV2ZW50c1xuLy9cbmV4cG9ydCBsZXQgd2lyZSA9IChyb290LCBjZmcsIGFyZykgPT4gbmV3IENpcmN1aXQocm9vdCwgY2ZnLCBhcmcpXG5cbmV4cG9ydCBsZXQgQ2lyY3VpdCA9IGNsYXNzIHtcblxuICAgIGNvbnN0cnVjdG9yKFxuICAgICAgICByb290RWwsXG4gICAgICAgIGV2ZW50Q29uZmlncyxcbiAgICAgICAge1xuICAgICAgICAgICAgdGhpc09iaiA9IHt9LFxuICAgICAgICAgICAgcXVlcnlGbk5hbWUgPSAncXVlcnlTZWxlY3RvckFsbCcsXG4gICAgICAgICAgICBsaXN0ZW5Gbk5hbWUgPSAnYWRkRXZlbnRMaXN0ZW5lcicsXG4gICAgICAgICAgICB1bmxpc3RlbkZuTmFtZT0gJ3JlbW92ZUV2ZW50TGlzdGVuZXInLFxuICAgICAgICAgICAgbm90aWZ5Rm5OYW1lPSdkaXNwYXRjaEV2ZW50JyxcbiAgICAgICAgICAgIHZhbGlkYXRvciA9IChlKSA9PiBlLnBhcmVudE5vZGUsXG4gICAgICAgIH0gPSB7fVxuICAgICkge1xuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIG1lLnJvb3RFbCA9IHJvb3RFbFxuICAgICAgICBtZS5ub2RlcyA9IHt9XG4gICAgICAgIG1lLndpcmVzID0gbmV3IFdlYWtNYXAoKVxuICAgICAgICBtZS5mdW5jcyA9IHtcbiAgICAgICAgICAgIHF1ZXJ5Rm5OYW1lLFxuICAgICAgICAgICAgbGlzdGVuRm5OYW1lLFxuICAgICAgICAgICAgdW5saXN0ZW5Gbk5hbWUsXG4gICAgICAgICAgICBub3RpZnlGbk5hbWUsXG4gICAgICAgICAgICB2YWxpZGF0b3IsXG4gICAgICAgIH1cblxuICAgICAgICAvLyBldmVudCdzIGxpc3RlbmVycyBzY29wZVxuICAgICAgICAvL1xuICAgICAgICBtZS50aGlzID0gbmV3IFByb3h5KHRoaXNPYmosIHtcbiAgICAgICAgICAgIGdldChfLCBuYW1lKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5hbWUgPT09ICd0b3BfJyAmJiAhKCd0b3BfJyBpbiB0aGlzT2JqKSkgcmV0dXJuIG1lXG4gICAgICAgICAgICAgICAgaWYgKG5hbWUgPT09ICdmaXJlXycgJiYgISgnZmlyZV8nIGluIHRoaXNPYmopKSByZXR1cm4gbWUuZmlyZS5iaW5kKG1lKVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIG1lLm5vZGVzICYmIG1lLm5vZGVzW25hbWVdXG4gICAgICAgICAgICAgICAgICAgIHx8IFJlZmxlY3QuZ2V0KC4uLmFyZ3VtZW50cylcbiAgICAgICAgICAgIH0sXG5cbiAgICAgICAgICAgIGRlbGV0ZVByb3BlcnR5KF8sIG5hbWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoIW1lLm5vZGVzIHx8ICFtZS5ub2Rlc1tuYW1lXSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gUmVmbGVjdC5kZWxldGVQcm9wZXJ0eSguLi5hcmd1bWVudHMpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxldCBlbCA9IG1lLm5vZGVzW25hbWVdXG4gICAgICAgICAgICAgICAgbWUuZGV3aXJlKGVsKVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBtZS5ub2Rlc1tuYW1lXVxuICAgICAgICAgICAgfSxcbiAgICAgICAgfSlcblxuICAgICAgICAvLyBpbml0aWFsaXplIGV2ZW50LWNvbmZpZ3NcbiAgICAgICAgLy9cbiAgICAgICAgT2JqZWN0LmVudHJpZXMoZXZlbnRDb25maWdzKS5mb3JFYWNoKChbcXJ5LCBldmVudENvbmZpZ10pID0+IHtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiBldmVudENvbmZpZyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGxldCBldmVudENvbmZpZ0ZuID0gZXZlbnRDb25maWdcblxuICAgICAgICAgICAgICAgIG1lLiNnZXRFbGVtcyhxcnkpLmZvckVhY2goIChlbCwgaSwgYXJyKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBhID0gZXZlbnRDb25maWdGbi5jYWxsKG1lLnRoaXMsIGVsLCBpLCBhcnIpXG4gICAgICAgICAgICAgICAgICAgIGxldCB7IGNmZywgbm9kZUlkIH0gPSBtZS4jZ2V0Q2ZnKGEpXG5cbiAgICAgICAgICAgICAgICAgICAgbWUud2lyZShlbCwgY2ZnLCBub2RlSWQpXG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbGV0IHsgY2ZnLCBub2RlSWQgfSA9IG1lLiNnZXRDZmcoZXZlbnRDb25maWcpXG5cbiAgICAgICAgICAgICAgICBtZS4jZ2V0RWxlbXMocXJ5KS5mb3JFYWNoKCAoZWwsIGksIGFycikgPT4ge1xuICAgICAgICAgICAgICAgICAgICBtZS53aXJlKGVsLCBjZmcsIG5vZGVJZClcbiAgICAgICAgICAgICAgICB9KVxuXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgfVxuXG4gICAgI2dldEVsZW1zKHFyeSkge1xuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIGxldCBxdWVyeUZuTmFtZSA9IG1lLmZ1bmNzLnF1ZXJ5Rm5OYW1lXG4gICAgICAgIGxldCBpc1Jvb3QgPSBxcnk9PT0nLidcbiAgICAgICAgcmV0dXJuIGlzUm9vdFxuICAgICAgICAgICAgPyBbbWUucm9vdEVsXVxuICAgICAgICAgICAgOiBbLi4uKG1lLnJvb3RFbFtxdWVyeUZuTmFtZV0ocXJ5KSldXG4gICAgfVxuXG4gICAgI2dldENmZyhldmVudENvbmZpZykge1xuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIGxldCBtZXRhID0ge31cbiAgICAgICAgbGV0IGNmZyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICAgIE9iamVjdFxuICAgICAgICAgICAgLmVudHJpZXMoZXZlbnRDb25maWcpXG4gICAgICAgICAgICAuZmlsdGVyKCAoW25hbWUsIHZhbF0pID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgaXNDb25maWcgPSBuYW1lWzBdPT09J18nXG4gICAgICAgICAgICAgICAgaWYgKGlzQ29uZmlnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBrID0gbmFtZS5zbGljZSgxKVxuICAgICAgICAgICAgICAgICAgICBtZXRhW2tdID0gdmFsXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgfSlcbiAgICAgICAgKVxuXG4gICAgICAgIGxldCBub2RlSWQgPSBtZXRhLmlkXG4gICAgICAgIGxldCBpc0NvbmZsaWN0ID0gbWUudGhpc1tub2RlSWRdXG4gICAgICAgICAgICB8fCB0eXBlb2YgbWUudGhpc1tub2RlSWRdID09PSAnZnVuY3Rpb24nXG4gICAgICAgIGlmIChpc0NvbmZsaWN0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGNvbmZsaWN0aW5nIG5vZGVzIFwiJHtub2RlSWR9XCJgKVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGNmZyxcbiAgICAgICAgICAgIG5vZGVJZCxcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIGNvdW50ZXIgZm9yIHVubmFtZWQgbm9kZUlkXG4gICAgLy9cbiAgICBzdGF0aWMgX2lkID0gMFxuXG4gICAgLy8gYXR0YWNoIGV2ZW50cyB0byBlbGVtZW50XG4gICAgLy9cbiAgICB3aXJlKGVsLCBldmVudHMsIG5vZGVJZCkge1xuICAgICAgICBsZXQgbWUgPSB0aGlzXG5cbiAgICAgICAgaWYgKCFtZS53aXJlcy5oYXMoZWwpKSB7XG4gICAgICAgICAgICBtZS53aXJlcy5zZXQoZWwsIFtdKVxuICAgICAgICAgICAgbGV0IGlkID0gbm9kZUlkIHx8IGBub2RlLSR7KytDaXJjdWl0Ll9pZH1gXG4gICAgICAgICAgICBtZS5ub2Rlc1tpZF0gPSBlbFxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpc3RlbiA9IG1lLmZ1bmNzLmxpc3RlbkZuTmFtZVxuICAgICAgICBPYmplY3RcbiAgICAgICAgLmVudHJpZXMoZXZlbnRzKVxuICAgICAgICAuZm9yRWFjaCgoW3R5cGUsIGxpc3RlbmVyXSkgPT4ge1xuICAgICAgICAgICAgbGV0IGZuID0gbGlzdGVuZXIuYmluZChtZS50aGlzKVxuICAgICAgICAgICAgZWxbbGlzdGVuXSh0eXBlLCBmbilcblxuICAgICAgICAgICAgbWUud2lyZXNcbiAgICAgICAgICAgICAgICAuZ2V0KGVsKVxuICAgICAgICAgICAgICAgIC5wdXNoKFt0eXBlLCBmbl0pXG4gICAgICAgIH0pXG4gICAgfVxuXG5cbiAgICAvLyByZW1vdmUgZXZlbnRzIGZyb20gYW4gZWxlbWVudFxuICAgIC8vXG4gICAgZGV3aXJlKGVsKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbGV0IHdtID0gbWUud2lyZXNcbiAgICAgICAgaWYgKCF3bS5oYXMoZWwpKSByZXR1cm4gZmFsc2VcblxuICAgICAgICBsZXQgdW5saXN0ZW4gPSBtZS5mdW5jcy51bmxpc3RlbkZuTmFtZVxuICAgICAgICB3bS5nZXQoZWwpLmZvckVhY2goIChbdHlwZSwgZm5dKSA9PiB7XG4gICAgICAgICAgICBlbFt1bmxpc3Rlbl0odHlwZSwgZm4pXG4gICAgICAgIH0pXG4gICAgfVxuXG4gICAgLy8gZGVsZXRlIGV2ZW50cyBmcm9tIGFsbCBlbGVtZW50c1xuICAgIC8vXG4gICAgZGVsZXRlKCkge1xuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIE9iamVjdC52YWx1ZXMobWUubm9kZXMpLmZvckVhY2goZWwgPT4gbWUuZGV3aXJlKGVsKSlcbiAgICAgICAgbWUucm9vdEVsID0gbnVsbFxuICAgICAgICBtZS5ub2RlcyA9IG51bGxcbiAgICAgICAgbWUud2lyZXMgPSBudWxsXG4gICAgfVxuXG4gICAgLy8gcmVtb3ZlIG9ycGhhbmVkIGVsZW1lbnRzXG4gICAgLy9cbiAgICBjbGVhbigpIHtcbiAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICBsZXQgdmFsaWRhdGUgPSBtZS5mdW5jcy52YWxpZGF0b3JcbiAgICAgICAgZm9yIChsZXQgW2lkLCBlbF0gb2YgT2JqZWN0LmVudHJpZXMobWUubm9kZXMpKSB7XG4gICAgICAgICAgICBpZiAoZWw9PW1lLnJvb3RFbCB8fCB2YWxpZGF0ZShlbCkpIGNvbnRpbnVlXG5cbiAgICAgICAgICAgIG1lLmRld2lyZShlbClcbiAgICAgICAgICAgIGRlbGV0ZSBtZS5ub2Rlc1tpZF1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vIGdldCBub2RlcyB3aGljaCBoYXMgZXZlbnROYW1lXG4gICAgLy9cbiAgICBub2Rlc1RoYXRMaXN0ZW5UbyhldmVudE5hbWUse1xuICAgICAgICBpc1NraXBSb290RWw9ZmFsc2UsXG4gICAgfSA9IHt9KSB7XG5cbiAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICBsZXQgd20gPSBtZS53aXJlc1xuXG4gICAgICAgIHJldHVybiBPYmplY3RcbiAgICAgICAgICAgIC52YWx1ZXMobWUubm9kZXMpXG4gICAgICAgICAgICAuZmlsdGVyKGVsID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICAgICF3bS5oYXMoZWwpXG4gICAgICAgICAgICAgICAgICAgIHx8IGlzU2tpcFJvb3RFbCAmJiBlbD09PW1lLnJvb3RFbFxuICAgICAgICAgICAgICAgICkgcmV0dXJuXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gd20uZ2V0KGVsKVxuICAgICAgICAgICAgICAgICAgICAuZmluZCggKFtuYW1lLF9dKSA9PiBuYW1lPT09ZXZlbnROYW1lKVxuICAgICAgICAgICAgfSlcbiAgICB9XG5cbiAgICAvLyB0cmlnZ2VycyBldmVudHMgb2Ygc3BlY2lmaWMgbmFtZVxuICAgIC8vXG4gICAgZmlyZShldnQsIHtcbiAgICAgICAgaXNTa2lwUm9vdEVsPWZhbHNlLFxuICAgIH0gPSB7fSkge1xuICAgICAgICBpZiAoIWV2dCB8fCAhZXZ0LnR5cGUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignaW52YWxpZCBldmVudCcpXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIGxldCBmbiA9IG1lLmZ1bmNzLm5vdGlmeUZuTmFtZVxuXG4gICAgICAgIGxldCBldmVudFR5cGUgPSBldnQudHlwZVxuICAgICAgICBtZVxuICAgICAgICAubm9kZXNUaGF0TGlzdGVuVG8oZXZlbnRUeXBlLCB7IGlzU2tpcFJvb3RFbCB9KVxuICAgICAgICAuZm9yRWFjaChlbCA9PiB7XG4gICAgICAgICAgICBpZiAoIWVsW2ZuXSkgcmV0dXJuXG4gICAgICAgICAgICBlbFtmbl0uY2FsbChlbCwgZXZ0KVxuICAgICAgICB9KVxuICAgIH1cbn1cbiIsImV4cG9ydCB7IHRtcGwsIH0gZnJvbSAnLi9kZXBzLmpzJ1xuaW1wb3J0IHsgd2lyZSwgfSBmcm9tICcuL2RlcHMuanMnXG5cbmV4cG9ydCBsZXQgY3VzdG9tRWxlbWVudERlZmF1bHRzID0ge1xuICAgIGhlYWRlcjogJycsXG4gICAgZm9vdGVyOiAnJyxcbn1cblxuLy8gYnVpbGRzIGEgd2lyZWQgY3VzdG9tLWVsZW1lbnQgZnJvbSBhIHN0cmluZyB0ZW1wbGF0ZVxuLy9cbmV4cG9ydCBsZXQgY3VzdG9tRWxlbWVudCA9IChcbiAgICB0ZW1wbGF0ZSxcbiAgICB7XG4gICAgICAgIF9oZWFkZXIgPSBjdXN0b21FbGVtZW50RGVmYXVsdHMuaGVhZGVyLFxuICAgICAgICBfZm9vdGVyID0gY3VzdG9tRWxlbWVudERlZmF1bHRzLmZvb3RlcixcbiAgICAgICAgX3dpcmVzID0ge30sXG4gICAgICAgIF9hdHRyaWJ1dGVzID0ge30sXG4gICAgICAgIF9mb3JtQXNzb2NpYXRlZCA9IHRydWUsXG4gICAgICAgIC4uLmNvbnRleHRcbiAgICB9ID0ge30sXG5cbiAgICAvLyBuZWVkZWQgY2xhc3NlcyBmb3IgdGVzdGluZ1xuICAgIHtcbiAgICAgICAgSFRNTEVsZW1lbnQgPSBnbG9iYWxUaGlzLkhUTUxFbGVtZW50LFxuICAgICAgICBkb2N1bWVudCA9IGdsb2JhbFRoaXMuZG9jdW1lbnQsXG4gICAgICAgIEN1c3RvbUV2ZW50ID0gZ2xvYmFsVGhpcy5DdXN0b21FdmVudCxcbiAgICB9ID0ge30sXG4pID0+IHtcblxuICAgIHJldHVybiBjbGFzcyBleHRlbmRzIEhUTUxFbGVtZW50IHtcbiAgICAgICAgc3RhdGljIGZvcm1Bc3NvY2lhdGVkID0gX2Zvcm1Bc3NvY2lhdGVkXG5cbiAgICAgICAgY29uc3RydWN0b3IoKSB7XG4gICAgICAgICAgICBzdXBlcigpXG4gICAgICAgICAgICB0aGlzLnRlbXBsYXRlXyA9IHRlbXBsYXRlXG4gICAgICAgICAgICB0aGlzLmNvbnRleHRfID0gT2JqZWN0LmFzc2lnbih7XG4gICAgICAgICAgICAgICAgcm9vdF86dGhpcyxcbiAgICAgICAgICAgICAgICBidWlsZF86IHRoaXMuYnVpbGQuYmluZCh0aGlzKSxcbiAgICAgICAgICAgICAgICBmaXJlXzogdGhpcy5maXJlLmJpbmQodGhpcyksXG4gICAgICAgICAgICB9LCBjb250ZXh0KVxuXG4gICAgICAgICAgICB0aGlzLndpcmVzQ29uZmlnID0gX3dpcmVzXG4gICAgICAgICAgICB0aGlzLmF0dGFjaFNoYWRvdyh7IG1vZGU6J29wZW4nIH0pXG4gICAgICAgICAgICB0aGlzLmJ1aWxkKClcbiAgICAgICAgfVxuXG4gICAgICAgIGJ1aWxkKFxuICAgICAgICAgICAgdXBkYXRlQ29udGV4dD17fSxcbiAgICAgICAgKSB7XG4gICAgICAgICAgICBpZiAodGhpcy53aXJlc18pIHtcbiAgICAgICAgICAgICAgICB0aGlzLndpcmVzXy5kZWxldGUoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLmNvbnRleHRfLCB1cGRhdGVDb250ZXh0KVxuXG4gICAgICAgICAgICBsZXQgciA9IHRoaXMuc2hhZG93Um9vdFxuICAgICAgICAgICAgd2hpbGUoci5maXJzdENoaWxkKSB7XG4gICAgICAgICAgICAgICAgci5yZW1vdmVDaGlsZChyLmZpcnN0Q2hpbGQpXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGVtcGxhdGUnKVxuICAgICAgICAgICAgdC5pbm5lckhUTUwgPSBbXG4gICAgICAgICAgICAgICAgX2hlYWRlcixcbiAgICAgICAgICAgICAgICB0ZW1wbGF0ZS5idWlsZCh0aGlzLmNvbnRleHRfKSxcbiAgICAgICAgICAgICAgICBfZm9vdGVyXG4gICAgICAgICAgICBdLmZpbHRlcihCb29sZWFuKS5qb2luKCcnKVxuICAgICAgICAgICAgci5hcHBlbmRDaGlsZCh0LmNvbnRlbnQuY2xvbmVOb2RlKHRydWUpKVxuICAgICAgICAgICAgdCA9IG51bGxcblxuICAgICAgICAgICAgdGhpcy53aXJlc18gPSB3aXJlKHIsIHRoaXMud2lyZXNDb25maWcsIHtcbiAgICAgICAgICAgICAgICB0aGlzT2JqOiB0aGlzLmNvbnRleHRfLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIHRoaXMudGhpcyA9IHRoaXMud2lyZXNfLnRoaXNcbiAgICAgICAgfVxuXG4gICAgICAgIGZpcmUoZXYpIHtcbiAgICAgICAgICAgIHRoaXMud2lyZXNfLmZpcmUoZXYpXG4gICAgICAgICAgICB0aGlzLmRpc3BhdGNoRXZlbnQoZXYpXG4gICAgICAgIH1cblxuICAgICAgICBjb25uZWN0ZWRDYWxsYmFjaygpIHtcbiAgICAgICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgICAgIGxldCBldiA9IG5ldyBDdXN0b21FdmVudCgnY29ubmVjdGVkJywgeyBkZXRhaWw6bnVsbCB9KVxuICAgICAgICAgICAgbWUuZmlyZShldilcbiAgICAgICAgfVxuXG4gICAgICAgIGRpc2Nvbm5lY3RlZENhbGxiYWNrKCkge1xuICAgICAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICAgICAgbGV0IGV2ID0gbmV3IEN1c3RvbUV2ZW50KCdkaXNjb25uZWN0ZWQnLCB7IGRldGFpbDpudWxsIH0pXG4gICAgICAgICAgICBtZS5maXJlKGV2KVxuICAgICAgICB9XG5cbiAgICAgICAgYWRvcHRlZENhbGxiYWNrKCkge1xuICAgICAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICAgICAgbGV0IGV2ID0gbmV3IEN1c3RvbUV2ZW50KCdhZG9wdGVkJywgeyBkZXRhaWw6bnVsbCB9KVxuICAgICAgICAgICAgbWUuZmlyZShldilcbiAgICAgICAgfVxuXG4gICAgICAgIHN0YXRpYyBnZXQgb2JzZXJ2ZWRBdHRyaWJ1dGVzKCkge1xuICAgICAgICAgICAgcmV0dXJuIE9iamVjdC5rZXlzKF9hdHRyaWJ1dGVzKVxuICAgICAgICB9XG5cbiAgICAgICAgYXR0cmlidXRlQ2hhbmdlZENhbGxiYWNrKG5hbWUsIG9sZFZhbHVlLCB2YWx1ZSkge1xuICAgICAgICAgICAgbGV0IGYgPSBfYXR0cmlidXRlc1tuYW1lXVxuICAgICAgICAgICAgaWYgKGYgJiYgdHlwZW9mIGYgPT09J2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGYuY2FsbCh0aGlzLmNvbnRleHRfLCB2YWx1ZSwgb2xkVmFsdWUpXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgICAgIGxldCBldiA9IG5ldyBDdXN0b21FdmVudCgnYXR0cmlidXRlX2NoYW5nZWQnLCB7XG4gICAgICAgICAgICAgICAgZGV0YWlsOntuYW1lLCB2YWx1ZSwgb2xkVmFsdWUsfVxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIG1lLmZpcmUoZXYpXG4gICAgICAgIH1cbiAgICB9XG59XG4iLCJpbXBvcnQgeyB0bXBsLCB3aXJlLCB9IGZyb20gJy4vZGVwcy5qcydcblxuZXhwb3J0IGxldCB3aXJlRWxlbWVudCA9IChcbiAgICByb290RWwsXG4gICAgdGVtcGxhdGUsXG4gICAgY2ZnLFxuXG4gICAgLy8gbmVlZGVkIGNsYXNzZXMgZm9yIHRlc3RpbmdcbiAgICB7XG4gICAgICAgIGRvY3VtZW50ID0gZ2xvYmFsVGhpcy5kb2N1bWVudCxcbiAgICB9ID0ge30sXG4pID0+IHtcbiAgICByZXR1cm4gbmV3IFdpcmVkRWxlbWVudChcbiAgICAgICAgcm9vdEVsLCB0ZW1wbGF0ZSwgY2ZnLCB7IGRvY3VtZW50IH1cbiAgICApXG5cbn1cblxubGV0IFdpcmVkRWxlbWVudCA9IGNsYXNzIHtcbiAgICBjb25zdHJ1Y3RvcihcbiAgICAgICAgcm9vdEVsLFxuICAgICAgICB0ZW1wbGF0ZSxcbiAgICAgICAge1xuICAgICAgICAgICAgX3dpcmVzID0ge30sXG4gICAgICAgICAgICAuLi5jb250ZXh0XG4gICAgICAgIH0gPSB7fSxcbiAgICAgICAge1xuICAgICAgICAgICAgZG9jdW1lbnQgPSBnbG9iYWxUaGlzLmRvY3VtZW50LFxuICAgICAgICB9XG4gICAgKSB7XG4gICAgICAgIHRoaXMucm9vdCA9IHJvb3RFbFxuICAgICAgICB0aGlzLnRlbXBsYXRlXyA9IHRlbXBsYXRlXG4gICAgICAgIHRoaXMuY29udGV4dF8gPSBPYmplY3QuYXNzaWduKHtcbiAgICAgICAgICAgIHJvb3RfOnRoaXMsXG4gICAgICAgICAgICBidWlsZF86IHRoaXMuYnVpbGQuYmluZCh0aGlzKSxcbiAgICAgICAgICAgIGZpcmVfOiB0aGlzLmZpcmUuYmluZCh0aGlzKSxcbiAgICAgICAgfSwgY29udGV4dClcblxuICAgICAgICB0aGlzLndpcmVzQ29uZmlnID0gX3dpcmVzXG4gICAgICAgIHRoaXMuZG9jdW1lbnQgPSBkb2N1bWVudFxuICAgICAgICB0aGlzLmJ1aWxkKClcbiAgICB9XG5cbiAgICBidWlsZChcbiAgICAgICAgdXBkYXRlQ29udGV4dD17fSxcbiAgICApIHtcbiAgICAgICAgaWYgKHRoaXMud2lyZXNfKSB7XG4gICAgICAgICAgICB0aGlzLndpcmVzXy5kZWxldGUoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIE9iamVjdC5hc3NpZ24odGhpcy5jb250ZXh0XywgdXBkYXRlQ29udGV4dClcblxuICAgICAgICBsZXQgciA9IHRoaXMucm9vdFxuICAgICAgICB3aGlsZShyLmZpcnN0Q2hpbGQpIHtcbiAgICAgICAgICAgIHIucmVtb3ZlQ2hpbGQoci5maXJzdENoaWxkKVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHQgPSB0aGlzLmRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RlbXBsYXRlJylcbiAgICAgICAgdC5pbm5lckhUTUwgPSB0aGlzLnRlbXBsYXRlXy5idWlsZCh0aGlzLmNvbnRleHRfKSxcbiAgICAgICAgci5hcHBlbmRDaGlsZCh0LmNvbnRlbnQuY2xvbmVOb2RlKHRydWUpKVxuICAgICAgICB0ID0gbnVsbFxuXG4gICAgICAgIHRoaXMud2lyZXNfID0gd2lyZShyLCB0aGlzLndpcmVzQ29uZmlnLCB7XG4gICAgICAgICAgICB0aGlzT2JqOiB0aGlzLmNvbnRleHRfLFxuICAgICAgICB9KVxuICAgICAgICB0aGlzLnRoaXMgPSB0aGlzLndpcmVzXy50aGlzXG4gICAgfVxuXG4gICAgZmlyZShldikge1xuICAgICAgICB0aGlzLndpcmVzXy5maXJlKGV2LCB7aXNTa2lwUm9vdEVsOnRydWV9KVxuICAgICAgICB0aGlzLnJvb3QuZGlzcGF0Y2hFdmVudChldilcbiAgICB9XG5cbn0iLCJsZXQgYXJyYXlGcm9tID0gKGFycikgPT4gQXJyYXkuaXNBcnJheShhcnIpID8gYXJyIDogW2Fycl1cclxuXHJcbi8vIHB1Ymxpc2gtc3Vic2NyaWJlIHRvIGNoYW5uZWxzXHJcbi8vXHJcbmV4cG9ydCBjbGFzcyBQdWJTdWIge1xyXG4gICAgY29uc3RydWN0b3IgKHtcclxuICAgICAgICBicm9hZGNhc3RDaGFubmVsSWRcclxuICAgIH0pIHtcclxuICAgICAgICB2YXIgbWUgPSB0aGlzXHJcbiAgICAgICAgbWUuX2lkID0gMFxyXG4gICAgICAgIG1lLmNoYW5uZWxzID0ge30gLy8gbG9jYWwgY2hhbm5lbHNcclxuXHJcbiAgICAgICAgLy8gYWxzbyBsaXN0ZW5zIHRvIGJyb2FkYWNhc3QgY2hhbm5lbFxyXG4gICAgICAgIC8vXHJcbiAgICAgICAgaWYgKGJyb2FkY2FzdENoYW5uZWxJZCkge1xyXG4gICAgICAgICAgICBsZXQgYmMgPSBuZXcgQnJvYWRjYXN0Q2hhbm5lbChicm9hZGNhc3RDaGFubmVsSWQpXHJcblxyXG4gICAgICAgICAgICBiYy5vbm1lc3NhZ2UgPSAoZXYpID0+IHtcclxuICAgICAgICAgICAgICAgIGxldCB7IGNoYW5uZWwsIGFyZ3MgfSA9IGV2LmRhdGFcclxuICAgICAgICAgICAgICAgIG1lLnB1Ymxpc2hfLmFwcGx5KG1lLCBbY2hhbm5lbF0uY29uY2F0KGFyZ3MpKVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBtZS5icm9hZGNhc3RDaGFubmVsID0gYmNcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gY2xlYXJzIGFsbCBjaGFubmVsXHJcbiAgICByZXNldCgpIHtcclxuICAgICAgICB0aGlzLl9pZCA9IDBcclxuICAgICAgICB0aGlzLmNoYW5uZWxzID0ge31cclxuICAgIH1cclxuXHJcbiAgICAvLyBjcmVhdGVzIGNoYW5uZWwudW5pcXVlX2lkXHJcbiAgICAvL1xyXG4gICAgY2hhbm5lbElkKGlkKSB7XHJcbiAgICAgICAgbGV0IFtjaCwgLi4ubnNdID0gKGlkIHx8ICcnKS5zcGxpdCgnLicpXHJcbiAgICAgICAgcmV0dXJuIFtcclxuICAgICAgICAgICAgY2gsIC8vIGNoYW5uZWwtbmFtZVxyXG4gICAgICAgICAgICBucy5qb2luKCcuJykgfHwgYF8keysrdGhpcy5faWR9YCAvLyBpZCB0byBjaGFubmVsXHJcbiAgICAgICAgXVxyXG4gICAgfVxyXG5cclxuICAgIC8vIGNoYW5uZWxzW2NoYW5uZWxdID0geyBpZDogZm4gfVxyXG4gICAgLy9cclxuICAgIHN1YnNjcmliZShpZCwgZm4sIG92ZXJyaWRlPWZhbHNlKSB7XHJcbiAgICAgICAgbGV0IFtjaCwgbl0gPSB0aGlzLmNoYW5uZWxJZChpZClcclxuICAgICAgICBpZiAoIWNoKSByZXR1cm5cclxuXHJcbiAgICAgICAgbGV0IGNoYW5uZWxzID0gdGhpcy5jaGFubmVsc1xyXG4gICAgICAgIGlmICghY2hhbm5lbHNbY2hdKSBjaGFubmVsc1tjaF0gPSB7fVxyXG4gICAgICAgIGxldCBzdWJzID0gY2hhbm5lbHNbY2hdXHJcblxyXG4gICAgICAgIGlmIChzdWJzW25dICYmICFvdmVycmlkZSkge1xyXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYHN1YnNjcmliZTogJHtpZH0gYWxyZWFkeSBleGlzdHNgKVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgc3Vic1tuXSA9IGZuXHJcbiAgICAgICAgcmV0dXJuIFtjaCwgbl0uam9pbignLicpXHJcbiAgICB9XHJcblxyXG4gICAgLy8gZGVsZXRlcyBmcm9tIGNoYW5uZWxcclxuICAgIC8vXHJcbiAgICB1bnN1YnNjcmliZSgpIHtcclxuICAgICAgICBsZXQgbWUgPSB0aGlzXHJcbiAgICAgICAgQXJyYXkuZnJvbShhcmd1bWVudHMpLmZsYXQoKS5mb3JFYWNoKChpZCkgPT4ge1xyXG4gICAgICAgICAgICBsZXQgW2NoLCBuXSA9IG1lLmNoYW5uZWxJZChpZClcclxuICAgICAgICAgICAgaWYgKCFjaCkgcmV0dXJuXHJcblxyXG4gICAgICAgICAgICBsZXQgc3VicyA9IG1lLmNoYW5uZWxzW2NoXVxyXG4gICAgICAgICAgICBpZiAoIXN1YnMpIHJldHVyblxyXG5cclxuICAgICAgICAgICAgZGVsZXRlIHN1YnNbbl1cclxuICAgICAgICB9KVxyXG4gICAgfVxyXG5cclxuICAgIC8vIHB1Ymxpc2ggdG8gbG9jYWwgcG9vbFxyXG4gICAgLy9cclxuICAgIHB1Ymxpc2hfKGNoLCAuLi5hcmdzKSB7XHJcbiAgICAgICAgbGV0IHN1YnMgPSB0aGlzLmNoYW5uZWxzW2NoXVxyXG4gICAgICAgIGlmICghc3VicykgcmV0dXJuXHJcblxyXG4gICAgICAgIE9iamVjdC52YWx1ZXMoc3VicylcclxuICAgICAgICAuZm9yRWFjaChmbiA9PiB7XHJcbiAgICAgICAgICAgIGZuLmFwcGx5KG51bGwsIGFyZ3MpXHJcbiAgICAgICAgfSlcclxuICAgIH1cclxuXHJcbiAgICAvLyBwdWJsaXNoIHRvIGxvY2FsIGFuZCBicm9hZGNhc3QgY2hhbm5lbFxyXG4gICAgLy8gY2hhbm5lbCBlbmRzIHdpdGggXCIhXCIgYnJvYWRjYXN0IHRvIGFsbCBsaXN0ZW5lcnNcclxuICAgIC8vXHJcbiAgICBwdWJsaXNoKGNoYW5uZWwsIC4uLmFyZ3MpIHtcclxuICAgICAgICBsZXQgYnJvYWRjYXN0ID0gY2hhbm5lbC5zbGljZSgtMSk9PT0nISdcclxuICAgICAgICBjaGFubmVsID0gYnJvYWRjYXN0XHJcbiAgICAgICAgICAgID8gY2hhbm5lbC5zbGljZSgwLCAtMSlcclxuICAgICAgICAgICAgOiBjaGFubmVsXHJcblxyXG4gICAgICAgIGlmIChicm9hZGNhc3QgJiYgdGhpcy5icm9hZGNhc3RDaGFubmVsICkge1xyXG4gICAgICAgICAgICB0aGlzLmJyb2FkY2FzdENoYW5uZWwucG9zdE1lc3NhZ2Uoe1xyXG4gICAgICAgICAgICAgICAgY2hhbm5lbCxcclxuICAgICAgICAgICAgICAgIGFyZ3NcclxuICAgICAgICAgICAgfSlcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRoaXMucHVibGlzaF8uYXBwbHkodGhpcywgW2NoYW5uZWxdLmNvbmNhdChhcmdzKSlcclxuICAgIH1cclxuXHJcbiAgICAvLyBleGVjdXRlIHRvIGxvY2FsIGNoYW5uZWxzIG9ubHlcclxuICAgIC8vXHJcbiAgICBhc3luYyBleGVjKGNoLCAuLi5hcmdzKSB7XHJcbiAgICAgICAgbGV0IHN1YnMgPSB0aGlzLmNoYW5uZWxzW2NoXVxyXG4gICAgICAgIGlmICghc3VicykgcmV0dXJuXHJcblxyXG4gICAgICAgIGxldCBmbnMgPSBPYmplY3QudmFsdWVzKHN1YnMpXHJcbiAgICAgICAgICAgIC5tYXAoZm4gPT4gZm4uYXBwbHkobnVsbCwgYXJncykpXHJcbiAgICAgICAgbGV0IGFyciA9IGF3YWl0IFByb21pc2UuYWxsKGZucylcclxuXHJcbiAgICAgICAgcmV0dXJuIE9iamVjdC5rZXlzKHN1YnMpXHJcbiAgICAgICAgICAgIC5yZWR1Y2UoICh4LCBpZCwgaSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgeFtpZF0gPSBhcnJbaV1cclxuICAgICAgICAgICAgICAgIHJldHVybiB4XHJcbiAgICAgICAgICAgIH0sIHt9KVxyXG4gICAgfVxyXG59XHJcblxyXG4vLyBmb3IgYSBnbG9iYWwgcHVic3ViXHJcbi8vXHJcbmNvbnN0IFdFQl9QVUJTVUJfQlJPQURDQVNUX0NIQU5ORUxfSUQgPVxyXG4gICAgZ2xvYmFsVGhpcy5XRUJfUFVCU1VCX0JST0FEQ0FTVF9DSEFOTkVMX0lEXHJcbiAgICB8fCAnd2ViLXB1YnN1Yi1icm9hZGNhc3QtY2hhbm5lbC1pZCdcclxuZXhwb3J0IGxldCBwdWJzdWIgPSBuZXcgUHViU3ViKHtcclxuICAgIGJyb2FkY2FzdENoYW5uZWxJZDogV0VCX1BVQlNVQl9CUk9BRENBU1RfQ0hBTk5FTF9JRFxyXG59KVxyXG5leHBvcnQgbGV0IHB1Ymxpc2ggPSBwdWJzdWIucHVibGlzaC5iaW5kKHB1YnN1YilcclxuZXhwb3J0IGxldCBzdWJzY3JpYmUgPSBwdWJzdWIuc3Vic2NyaWJlLmJpbmQocHVic3ViKVxyXG5leHBvcnQgbGV0IHVuc3Vic2NyaWJlID0gcHVic3ViLnVuc3Vic2NyaWJlLmJpbmQocHVic3ViKVxyXG5leHBvcnQgbGV0IGV4ZWMgPSBwdWJzdWIuZXhlYy5iaW5kKHB1YnN1YilcclxuIiwiZXhwb3J0IGNvbnN0IGlzRW1wdHkgPSAoYSkgPT4gKGE9PW51bGwpIHx8IChhPT09JycpIHx8IChBcnJheS5pc0FycmF5KGEpICYmIGEubGVuZ3RoPT09MClcclxuXHJcbmV4cG9ydCBjb25zdCBpc1N0cmluZyA9IChhKSA9PiAodHlwZW9mIGEgPT09ICdzdHJpbmcnKVxyXG5cclxuZXhwb3J0IGNvbnN0IGlzQm9vbGVhbiA9IChhKSA9PiAodHlwZW9mIGEgPT09ICdib29sZWFuJylcclxuXHJcbmV4cG9ydCBjb25zdCBpc0Z1bmN0aW9uID0gKGEpID0+ICh0eXBlb2YgYSA9PT0gJ2Z1bmN0aW9uJylcclxuXHJcbmV4cG9ydCBjb25zdCBpc09iamVjdCA9IChhKSA9PiAoYSAhPT0gbnVsbCAmJiBhIGluc3RhbmNlb2YgT2JqZWN0ICYmIGEuY29uc3RydWN0b3IgPT09IE9iamVjdClcclxuIiwiaW1wb3J0IHsgaXNFbXB0eSB9IGZyb20gXCIuL2lzLmpzXCJcclxuXHJcbmV4cG9ydCBsZXQgY2xlYW4gPSAob2JqKSA9PiB7XHJcbiAgICBsZXQgdiA9IHt9XHJcbiAgICBmb3IgKGxldCBrIGluIG9iaikge1xyXG4gICAgICAgIGxldCBhID0gb2JqW2tdXHJcbiAgICAgICAgaWYgKGlzRW1wdHkoYSkpIGNvbnRpbnVlXHJcbiAgICAgICAgdltrXSA9IGFcclxuICAgIH1cclxuICAgIHJldHVybiB2XHJcbn1cclxuXHJcbmV4cG9ydCBsZXQgc2V0ID0gKHJvb3QsIHBhdGgsIHZhbHVlKSA9PiB7XHJcblxyXG4gICAgbGV0IGtleXMgPSBwYXRoLnNwbGl0KCcuJylcclxuICAgIGxldCBsYXN0S2V5ID0ga2V5cy5wb3AoKVxyXG5cclxuICAgIHZhciByID0gcm9vdCB8fCB7fVxyXG4gICAga2V5cy5mb3JFYWNoKGsgPT4ge1xyXG4gICAgICAgIGlmICghci5oYXNPd25Qcm9wZXJ0eShrKSkgcltrXSA9IHt9XHJcbiAgICAgICAgciA9IHJba11cclxuICAgIH0pXHJcblxyXG4gICAgcltsYXN0S2V5XSA9IHZhbHVlXHJcblxyXG4gICAgcmV0dXJuIHJvb3RcclxufVxyXG5cclxuZXhwb3J0IGxldCBnZXQgPSAocm9vdCwgcGF0aCwgZGVmYXVsdFZhbHVlKSA9PiB7XHJcbiAgICBsZXQga2V5cyA9IHBhdGguc3BsaXQoJy4nKVxyXG4gICAgbGV0IHIgPSByb290IHx8IHt9XHJcbiAgICBmb3IgKGxldCBrIG9mIGtleXMpIHtcclxuICAgICAgICBpZiAoIXIuaGFzT3duUHJvcGVydHkoaykpIHJldHVybiBkZWZhdWx0VmFsdWVcclxuICAgICAgICByID0gcltrXVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJcclxufVxyXG5cclxuZXhwb3J0IGxldCB0cmltID0gKHJvb3QsIHBhdGgpID0+IHtcclxuICAgIGxldCBrZXlzID0gcGF0aC5zcGxpdCgnLicpXHJcbiAgICBsZXQgbGFzdEtleSA9IGtleXMucG9wKClcclxuXHJcbiAgICB2YXIgciA9IHJvb3QgfHwge31cclxuICAgIGZvciAobGV0IGsgb2Yga2V5cykge1xyXG4gICAgICAgIGlmICghci5oYXNPd25Qcm9wZXJ0eShrKSkgcmV0dXJuIGZhbHNlXHJcbiAgICAgICAgciA9IHJba11cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gZGVsZXRlIHJbbGFzdEtleV1cclxufVxyXG5cclxuZXhwb3J0IGxldCBwYXJzZSA9IChzdHIsIGRlZmF1bHRWYWx1ZSkgPT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICByZXR1cm4gSlNPTi5wYXJzZShzdHIpXHJcbiAgICB9IGNhdGNoKHgpIHtcclxuICAgICAgICByZXR1cm4gZGVmYXVsdFZhbHVlXHJcbiAgICB9XHJcbn0iLCJleHBvcnQgY29uc3QgZnJvbSA9ICh2YWwpID0+ICh2YWwgPT09IHVuZGVmaW5lZCB8fCB2YWw9PT1udWxsKSA/IFtdXG5cdDogQXJyYXkuaXNBcnJheSh2YWwpID8gdmFsXG5cdDogW3ZhbF1cbiIsImltcG9ydCB7IGlzRnVuY3Rpb24gfSBmcm9tIFwiLi9pcy5qc1wiXG5leHBvcnQgbGV0IGZyb20gPSAoYSkgPT4gaXNGdW5jdGlvbihhKSA/IGEgOiAoICgpID0+IGEpIiwiaW1wb3J0ICogYXMgT2JqIGZyb20gJy4vb2JqLmpzJ1xyXG5cclxuZXhwb3J0IHsgT2JqIH1cclxuXHJcbmV4cG9ydCAqIGFzIElzIGZyb20gJy4vaXMuanMnXHJcbmV4cG9ydCAqIGFzIEFyciBmcm9tICcuL2Fyci5qcydcclxuZXhwb3J0ICogYXMgRm4gZnJvbSAnLi9mbi5qcydcclxuXHJcbmV4cG9ydCBjbGFzcyBTdG9yZSB7XHJcbiAgICBjb25zdHJ1Y3RvcihcclxuICAgICAgICBpZCxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIGluaXRpYWwgPSB7fSxcclxuICAgICAgICAgICAgc3RvcmUgPSBnbG9iYWxUaGlzLnNlc3Npb25TdG9yYWdlLFxyXG4gICAgICAgIH0gPSB7fVxyXG4gICAgKSB7XHJcbiAgICAgICAgaWYgKCFpZCkgdGhyb3cgbmV3IEVycm9yKCdzdG9yZSBpZCByZXF1aXJlZCcpXHJcbiAgICAgICAgdGhpcy5pZCA9IGlkXHJcbiAgICAgICAgdGhpcy52YWx1ZSA9IGluaXRpYWxcclxuICAgICAgICB0aGlzLnN0b3JlID0gc3RvcmVcclxuICAgIH1cclxuXHJcbiAgICBzZXQocGF0aCwgdmFsdWVzKSB7XHJcbiAgICAgICAgdGhpcy52YWx1ZSA9IE9iai5zZXQodGhpcy52YWx1ZSB8fCB7fSwgcGF0aCwgdmFsdWVzKVxyXG4gICAgICAgIHRoaXMuc2F2ZSgpXHJcbiAgICAgICAgcmV0dXJuIHRoaXNcclxuICAgIH1cclxuXHJcbiAgICBnZXQocGF0aCwgZGVmYXVsdFZhbHVlKSB7XHJcbiAgICAgICAgcmV0dXJuICh0aGlzLnZhbHVlICYmIHBhdGgpXHJcbiAgICAgICAgICAgID8gT2JqLmdldCh0aGlzLnZhbHVlLCBwYXRoLCBkZWZhdWx0VmFsdWUpXHJcbiAgICAgICAgICAgIDogdGhpcy52YWx1ZVxyXG4gICAgfVxyXG5cclxuICAgIHRyaW0ocGF0aCkge1xyXG4gICAgICAgIGlmIChwYXRoKSB7XHJcbiAgICAgICAgICAgIE9iai50cmltKHRoaXMudmFsdWUsIHBhdGgpXHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy52YWx1ZSA9IHt9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0aGlzXHJcbiAgICB9XHJcblxyXG4gICAgLy8gbG9jYWwgc3RvcmFnZVxyXG4gICAgLy9cclxuICAgIHNhdmUoKSB7XHJcbiAgICAgICAgdGhpcy5zdG9yZS5zZXRJdGVtKHRoaXMuaWQsIEpTT04uc3RyaW5naWZ5KHRoaXMudmFsdWUpKVxyXG4gICAgICAgIHJldHVybiB0aGlzXHJcbiAgICB9XHJcblxyXG4gICAgbG9hZCgpIHtcclxuICAgICAgICBsZXQgcyA9IHRoaXMuc3RvcmUuZ2V0SXRlbSh0aGlzLmlkKVxyXG4gICAgICAgIHRoaXMudmFsdWUgPSBPYmoucGFyc2UocykgfHwge31cclxuICAgICAgICByZXR1cm4gdGhpc1xyXG4gICAgfVxyXG5cclxuICAgIHJlc2V0KCkge1xyXG4gICAgICAgIHRoaXMudmFsdWUgPSB7fVxyXG4gICAgICAgIHRoaXMuc3RvcmUucmVtb3ZlSXRlbSh0aGlzLmlkKVxyXG4gICAgICAgIHJldHVybiB0aGlzXHJcbiAgICB9XHJcbn1cclxuXHJcbi8vIHZhciBzdG9yZSA9IG5ldyBTdG9yZSgnd2ViJylcclxuLy8gc3RvcmUubG9hZCgpXHJcbi8vIGdsb2JhbFRoaXMuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JldW5sb2FkJywgKCkgPT4gc3RvcmUuc2F2ZSgpKSIsIi8vIHdyYXBzIGZ1bmN0aW9uL29iamVjdC9zdHJpbmcvd29ya2VyXG4vL1xuZXhwb3J0IGxldCB3cmFwID0gKHcpID0+IHtcbiAgICBpZiAodyBpbnN0YW5jZW9mIFdvcmtlcikge1xuICAgICAgICByZXR1cm4gd3JhcF93b3JrZXIodylcbiAgICB9XG5cbiAgICBsZXQgc3JjXG4gICAgaWYgKHR5cGVvZih3KT09PSdmdW5jdGlvbicpIHtcbiAgICAgICAgc3JjID0gYCgke3Byb3h5fSkoJHt3fSlgXG4gICAgfVxuICAgIGVsc2UgaWYgKHcgaW5zdGFuY2VvZiBPYmplY3QgJiYgdy5jb25zdHJ1Y3Rvcj09PU9iamVjdCkge1xuICAgICAgICBzcmMgPSBgKCR7cHJveHl9KSgke3RvU3JjKHcpfSlgXG4gICAgfVxuICAgIGVsc2UgaWYgKHR5cGVvZih3KT09PSdzdHJpbmcnKSB7XG4gICAgICAgIHNyYyA9IHdcbiAgICB9XG4gICAgaWYgKCFzcmMpIHRocm93IG5ldyBFcnJvcigndW5zdXBwb3J0ZWQgdHlwZScpXG5cbiAgICBsZXQgYiA9IG5ldyBCbG9iKCBbc3JjXSxcbiAgICAgICAgeyB0eXBlOiAndGV4dC9qYXZhc2NyaXB0JyB9KVxuICAgIGxldCB1ID0gVVJMLmNyZWF0ZU9iamVjdFVSTChiKVxuICAgIGxldCBhID0gbmV3IFdvcmtlcih1LFxuICAgICAgICBcIkRlbm9cIiBpbiBnbG9iYWxUaGlzXG4gICAgICAgID8ge3R5cGU6J21vZHVsZSd9XG4gICAgICAgIDoge30pXG5cbiAgICByZXR1cm4gd3JhcF93b3JrZXIoYSlcbn1cblxuLy8gb2JqZWN0IC0+IHNvdXJjZS1zdHJpbmdcbi8vXG5sZXQgdG9TcmMgPSAob2JqKSA9PiB7XG4gICAgcmV0dXJuIGB7ICR7XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKG9iailcbiAgICAgICAgLm1hcCggKFtrZXksIHZhbF0pID0+IHtcbiAgICAgICAgICAgIHJldHVybiBgJHtrZXl9OiR7XG4gICAgICAgICAgICAgICAgdHlwZW9mKHZhbCk9PT0nZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgPyB2YWwrJydcbiAgICAgICAgICAgICAgICA6IEpTT04uc3RyaW5naWZ5KHZhbClcbiAgICAgICAgICAgIH1gXG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCcsJylcbiAgICB9IH1gXG59XG5cbi8vIHdyYXBzIGEgd29ya2VyXG4vL1xuZXhwb3J0IGxldCB3cmFwX3dvcmtlciA9ICh3KSA9PiB7XG4gICAgbGV0IF9pZCA9IDBcbiAgICBsZXQgX2NiID0ge31cblxuICAgIGxldCBmbiA9ICguLi5hcmdzKSA9PiBuZXcgUHJvbWlzZSgob2ssIGVycikgPT4ge1xuICAgICAgICBsZXQgaWQgPSArK19pZFxuICAgICAgICB3LnBvc3RNZXNzYWdlKHtpZCwgYXJnc30pXG4gICAgICAgIF9jYltpZF0gPSB7b2ssIGVycn1cbiAgICB9KVxuXG4gICAgdy5vbm1lc3NhZ2UgPSAoZSkgPT4ge1xuICAgICAgICBpZiAoIWUpIHJldHVyblxuICAgICAgICBsZXQgeyBpZCwgZGF0YSwgZXJyb3IgfSA9IGUuZGF0YSB8fCB7fVxuICAgICAgICBpZiAoIWlkKSByZXR1cm5cblxuICAgICAgICBsZXQgY2IgPSBfY2JbaWRdXG4gICAgICAgIGlmICghY2IpIHJldHVyblxuICAgICAgICBkZWxldGUgX2NiW2lkXVxuXG4gICAgICAgIGxldCB7IG9rLCBlcnIgfSA9IGNiXG4gICAgICAgIHJldHVybiBlcnJvclxuICAgICAgICAgICAgPyBlcnIoZXJyb3IpXG4gICAgICAgICAgICA6IG9rKGRhdGEpXG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBQcm94eShmbiwge1xuICAgICAgICBnZXQoXywgcHJvcCkge1xuICAgICAgICAgICAgaWYgKHByb3AgPT09ICdfX3dvcmtlcicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gd1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gKC4uLmFyZ3MpID0+IG5ldyBQcm9taXNlKChvaywgZXJyKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGlkID0gKytfaWRcbiAgICAgICAgICAgICAgICB3LnBvc3RNZXNzYWdlKHtpZCwgZm46cHJvcCwgYXJnc30pXG4gICAgICAgICAgICAgICAgX2NiW2lkXSA9IHtvaywgZXJyfVxuICAgICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgIH0pXG59XG5cblxuLy8gcHJveHkgd29ya2VyIGZ1bmN0aW9uL29iamVjdFxuLy9cbmV4cG9ydCBsZXQgcHJveHkgPSAoYXJnLCBzY29wZT1udWxsKSAgPT4ge1xuICAgIGxldCBGbiA9IHt9XG4gICAgaWYgKCh0eXBlb2YgYXJnID09PSAnZnVuY3Rpb24nKSkge1xuICAgICAgICBGbi5fID0gYXJnXG4gICAgfVxuICAgIGVsc2UgaWYgKFxuICAgICAgICBhcmcgIT09IG51bGxcbiAgICAgICAgJiYgYXJnIGluc3RhbmNlb2YgT2JqZWN0XG4gICAgICAgICYmIGFyZy5jb25zdHJ1Y3RvciA9PT0gT2JqZWN0XG4gICAgKSB7XG4gICAgICAgIEZuID0gYXJnXG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3BsZWFzZSBwYXNzIGZ1bmN0aW9uL29iamVjdCcpXG4gICAgfVxuXG4gICAgZ2xvYmFsVGhpcy5vbm1lc3NhZ2UgPSBmdW5jdGlvbihlKSB7XG4gICAgICAgIGlmICghZSkgcmV0dXJuXG4gICAgICAgIGxldCB7IGlkLCBmbj0nXycsIGFyZ3MgfSA9IGUuZGF0YSB8fCB7fVxuXG4gICAgICAgIHsoYXN5bmMgKCk9PiB7XG4gICAgICAgICAgICB2YXIgcCA9IHsgaWQgfVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpZiAoIUZuLmhhc093blByb3BlcnR5KGZuKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3VuZGVmaW5lZCBwcm9wZXJ0eScpXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGYgPSBGbltmbl1cbiAgICAgICAgICAgICAgICBsZXQgaXNGbiA9IHR5cGVvZiBmID09PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgcC5kYXRhID0gaXNGblxuICAgICAgICAgICAgICAgICAgICA/IGF3YWl0IChmLmFwcGx5KHNjb3BlIHx8IEZuLCBhcmdzKSlcbiAgICAgICAgICAgICAgICAgICAgOiBmXG5cbiAgICAgICAgICAgICAgICBpZiAoIWlzRm4gJiYgYXJncy5sZW5ndGg+MCkge1xuICAgICAgICAgICAgICAgICAgICBGbltmbl0gPSBhcmdzWzBdXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB9IGNhdGNoKGUpIHtcbiAgICAgICAgICAgICAgICBwLmVycm9yID0gZVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZ2xvYmFsVGhpcy5wb3N0TWVzc2FnZShwKVxuICAgICAgICB9KSgpfVxuICAgIH1cbn1cbiIsIi8vIGRlbm8gY2FjaGUgLXIgbW9kLmpzXG4vLyBkZW5vIHJ1biAtQSBidWlsZC5qc1xuXG4vLyB3cmFwcyBmZXRjaFxuLy9cbmV4cG9ydCB7XG4gICAgYWpheCxcbiAgICBhamF4RGVmYXVsdHMsXG4gICAgYWpheEZuLFxufSBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9hamF4LmpzL21haW4vbW9kLmpzJ1xuXG5cbi8vIGZvciBjcmVhdGluZyB3ZWItY29tcG9uZW50XG4vL1xuZXhwb3J0IHtcbiAgICBjdXN0b21FbGVtZW50LFxuICAgIGN1c3RvbUVsZW1lbnREZWZhdWx0cyxcbiAgICB0bXBsLFxuICAgIHdpcmVFbGVtZW50LFxufSBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9jdXN0b20tZWxlbWVudC5qcy9tYWluL21vZC5qcydcblxuZXhwb3J0IHtcbiAgICB3aXJlLFxufSBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS93aXJlLmpzL21haW4vbW9kLmpzJ1xuXG5cbi8vIHB1Ymxpc2gtc3Vic2NyaWJlIHVzaW5nIGJyb2FkY2FzdCBjaGFubmVsXG4vL1xuZXhwb3J0IHtcbiAgICBQdWJTdWIsXG59IGZyb20gJ2h0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3B1YnN1Yi5qcy9tYWluL21vZC5qcydcblxuXG4vLyBjYWNoZSB0byBsb2NhbC1zdG9yYWdlXG4vL1xuZXhwb3J0IHtcbiAgICBTdG9yZSxcbiAgICAvLyB1dGlsaXR5IGZ1bmN0aW9uc1xuICAgIEFycixcbiAgICBJcyxcbiAgICBPYmosXG4gICAgRm4sXG59IGZyb20gJ2h0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3N0b3JlLmpzL21haW4vbW9kLmpzJ1xuXG5cbi8vIFdhYWYud3JhcCBvYmplY3Qvc3RyaW5nL2Z1bmN0aW9uL3dvcmtlciBhcyB3ZWItd29ya2VyXG4vLyBXYWFmLnByb3h5IGZvciBwcm94eSB0byBjb21tdW5pY2F0ZSB3aXRoIHdyYXBwZWQgd2ViLXdvcmtlclxuLy9cbmV4cG9ydCAqIGFzIFdhYWZcbiAgICBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS93YWFmLmpzL21haW4vbW9kLmpzJ1xuXG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsSUFBSSxjQUFjLENBQUMsTUFBTSxPQUFTO0lBQzlCLE9BQU87UUFDSCxLQUFLO1lBQU8sT0FBTztRQUNuQixLQUFLO1lBQVEsT0FBTyxPQUFPLEtBQUssUUFBUSxLQUFLLElBQUk7UUFDakQsS0FBSztZQUFRLE9BQU8sS0FBSyxTQUFTLENBQUM7SUFDdkM7SUFFQSxNQUFNLElBQUksTUFBTSw2QkFBNEI7QUFDaEQ7QUFFQSxJQUFJLGtCQUFrQixDQUFDLEtBQUssT0FBUztJQUNqQyxPQUFPO1FBQ0gsS0FBSztZQUFlLE9BQU8sSUFBSSxXQUFXO1FBQzFDLEtBQUs7WUFBUSxPQUFPLElBQUksSUFBSTtRQUM1QixLQUFLO1lBQVksT0FBTyxJQUFJLFFBQVE7UUFDcEMsS0FBSztZQUFRLE9BQU8sSUFBSSxJQUFJO1FBQzVCLEtBQUs7WUFBUSxPQUFPLElBQUksSUFBSTtJQUNoQztJQUVBLE1BQU0sSUFBSSxNQUFNLHlCQUF3QjtBQUM1QztBQUVPLElBQUksZUFBZTtJQUN0QixVQUFTO0lBQ1QsU0FBUztJQUVULFFBQVE7SUFDUixTQUFTO1FBQ0wsZ0JBQWdCO0lBQ3BCO0lBRUEsYUFBYTtJQUNiLGNBQWM7QUFDbEI7QUFHTyxTQUFTLEtBQU0sRUFDbEIsSUFBRyxFQUNILEtBQUksRUFDSixLQUFJLEVBR0osT0FBUSxDQUFDLElBQU0sRUFBQyxFQUNoQixRQUFTLENBQUMsSUFBTSxFQUFDLEVBRWpCLFVBQVcsYUFBYSxRQUFRLENBQUEsRUFDaEMsUUFBUyxhQUFhLE1BQU0sQ0FBQSxFQUM1QixTQUFVLGFBQWEsT0FBTyxDQUFBLEVBQzlCLFNBQVUsYUFBYSxPQUFPLENBQUEsRUFDOUIsYUFBYyxhQUFhLFdBQVcsQ0FBQSxFQUN0QyxjQUFlLGFBQWEsWUFBWSxDQUFBLEVBQzNDLEdBQUcsQ0FBQyxDQUFD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
