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
let from = (val)=>val === undefined || val === null ? [] : Array.isArray(val) ? val : [
        val
    ];
const mod1 = {
    from: from
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
let merge = (obj, ...bs)=>{
    Array.from(bs).filter(Boolean).forEach((b)=>{
        for (let [k, v] of Object.entries(b)){
            let a = obj[k];
            if (isObject1(a) && isObject1(v)) {
                obj[k] = {
                    ...a,
                    ...v
                };
            } else if (Array.isArray(a)) {
                obj[k] = [
                    ...a,
                    ...from(v)
                ];
            } else {
                obj[k] = v;
            }
        }
    });
    return obj;
};
const mod2 = {
    clean: clean,
    set: set,
    get: get,
    trim: trim,
    parse: parse,
    merge: merge
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
        this.value = mod2.set(this.value || {}, path, values);
        this.save();
        return this;
    }
    get(path, defaultValue) {
        return this.value && path ? mod2.get(this.value, path, defaultValue) : this.value;
    }
    trim(path) {
        if (path) {
            mod2.trim(this.value, path);
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
        this.value = mod2.parse(s) || {};
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
export { Store as Store, mod1 as Arr, mod as Is, mod2 as Obj, mod3 as Fn };
export { mod4 as Waaf };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L2FqYXguanMvbWFpbi9zcmMvaW5kZXguanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9tZW1vLWZ1bmN0aW9uLmpzL21haW4vc3JjL21lbW8uanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS90bXBsLmpzL21haW4vc3JjL3RtcGwuanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS93aXJlLmpzL21haW4vc3JjL3dpcmUuanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9jdXN0b20tZWxlbWVudC5qcy9tYWluL3NyYy9jdXN0b20tZWxlbWVudC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L2N1c3RvbS1lbGVtZW50LmpzL21haW4vc3JjL3dpcmUtZWxlbWVudC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3B1YnN1Yi5qcy9tYWluL3NyYy9pbmRleC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3N0b3JlLmpzL21haW4vc3JjL2lzLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvYXJyLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvb2JqLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvZm4uanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9zdG9yZS5qcy9tYWluL3NyYy9pbmRleC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3dhYWYuanMvbWFpbi9zcmMvaW5kZXguanMiLCJmaWxlOi8vL1VzZXJzL2hhbi9zcmMva29kZW1hNS93ZWIuanMvbW9kLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIlxyXG5sZXQgcHJvY2Vzc0JvZHkgPSAoZGF0YSwgdHlwZSkgPT4ge1xyXG4gICAgc3dpdGNoKHR5cGUpIHtcclxuICAgICAgICBjYXNlIFwiYW55XCI6IHJldHVybiBkYXRhXHJcbiAgICAgICAgY2FzZSBcInRleHRcIjogcmV0dXJuIGRhdGEgPyBkYXRhLnRvU3RyaW5nKCkgOiBkYXRhXHJcbiAgICAgICAgY2FzZSBcImpzb25cIjogcmV0dXJuIEpTT04uc3RyaW5naWZ5KGRhdGEpXHJcbiAgICB9XHJcblxyXG4gICAgdGhyb3cgbmV3IEVycm9yKCd1bmtub3duIHJlcXVlc3QgZGF0YSB0eXBlJylcclxufVxyXG5cclxubGV0IHByb2Nlc3NSZXNwb25zZSA9IChyZXMsIHR5cGUpID0+IHtcclxuICAgIHN3aXRjaCh0eXBlKSB7XHJcbiAgICAgICAgY2FzZSAnYXJyYXlCdWZmZXInOiByZXR1cm4gcmVzLmFycmF5QnVmZmVyKClcclxuICAgICAgICBjYXNlICdibG9iJzogcmV0dXJuIHJlcy5ibG9iKClcclxuICAgICAgICBjYXNlICdmb3JtRGF0YSc6IHJldHVybiByZXMuZm9ybURhdGEoKVxyXG4gICAgICAgIGNhc2UgJ2pzb24nOiByZXR1cm4gcmVzLmpzb24oKVxyXG4gICAgICAgIGNhc2UgJ3RleHQnOiByZXR1cm4gcmVzLnRleHQoKVxyXG4gICAgfVxyXG5cclxuICAgIHRocm93IG5ldyBFcnJvcigndW5rbm93biByZXNwb25zZSB0eXBlJylcclxufVxyXG5cclxuZXhwb3J0IGxldCBhamF4RGVmYXVsdHMgPSB7XHJcbiAgICBiYXNlSHJlZjonJyxcclxuICAgIHRpbWVvdXQ6IDAsXHJcblxyXG4gICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xyXG4gICAgfSxcclxuXHJcbiAgICByZXF1ZXN0VHlwZTogJ2pzb24nLCAvLyBqc29uLCB0ZXh0LCBhbnlcclxuICAgIHJlc3BvbnNlVHlwZTogJ2pzb24nLCAvLyBhcnJheUJ1ZmZlciwgYmxvYiwgZm9ybURhdGEsIGpzb24sIHRleHQsXHJcbn1cclxuXHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYWpheCAoe1xyXG4gICAgdXJsLFxyXG4gICAgZGF0YSxcclxuICAgIGJvZHksIC8vIGZvciBGb3JtRGF0YSwgVVJMU2VhcmNoUGFyYW1zLCBzdHJpbmcsIGV0Y1xyXG5cclxuICAgIC8vIHRyYW5zZm9ybWVyL3ZhbGlkYXRvclxyXG4gICAgaW5wdXQgPSAoYSkgPT4gYSxcclxuICAgIG91dHB1dCA9IChhKSA9PiBhLFxyXG5cclxuICAgIGJhc2VIcmVmID0gYWpheERlZmF1bHRzLmJhc2VIcmVmLFxyXG4gICAgbWV0aG9kID0gYWpheERlZmF1bHRzLm1ldGhvZCxcclxuICAgIGhlYWRlcnMgPSBhamF4RGVmYXVsdHMuaGVhZGVycyxcclxuICAgIHRpbWVvdXQgPSBhamF4RGVmYXVsdHMudGltZW91dCxcclxuICAgIHJlcXVlc3RUeXBlID0gYWpheERlZmF1bHRzLnJlcXVlc3RUeXBlLFxyXG4gICAgcmVzcG9uc2VUeXBlID0gYWpheERlZmF1bHRzLnJlc3BvbnNlVHlwZSxcclxufSA9IHt9KSB7XHJcblxyXG4gICAgaWYgKCF1cmwpIHRocm93IG5ldyBFcnJvcigndXJsIHJlcXVpcmVkJylcclxuXHJcbiAgICB1cmwgPSB1cmwuaW5kZXhPZignaHR0cCcpIDwgMCAmJiBiYXNlSHJlZlxyXG4gICAgICAgID8gYmFzZUhyZWYgKyB1cmxcclxuICAgICAgICA6IHVybFxyXG5cclxuICAgIGRhdGEgPSBpbnB1dChkYXRhKVxyXG5cclxuICAgIGxldCBvcHQgPSB7XHJcbiAgICAgICAgbWV0aG9kLFxyXG4gICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgICAgLi4uKGhlYWRlcnMpXHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGxldCBoYXNCb2R5ID0gIShtZXRob2Q9PT0nR0VUJyB8fCBtZXRob2Q9PT0nSEVBRCcpXHJcbiAgICBpZiAoaGFzQm9keSkge1xyXG4gICAgICAgIG9wdC5ib2R5ID0gYm9keSB8fCBwcm9jZXNzQm9keShkYXRhLCByZXF1ZXN0VHlwZSlcclxuICAgIH1cclxuXHJcbiAgICBsZXQgQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKClcclxuICAgIG9wdC5zaWduYWwgPSBBYm9ydC5zaWduYWxcclxuXHJcbiAgICBsZXQgcCA9IG5ldyBQcm9taXNlKGFzeW5jIChvaywgZXJyKSA9PiB7XHJcbiAgICAgICAgbGV0IHRJZFxyXG4gICAgICAgIGlmICh0aW1lb3V0KSB7XHJcbiAgICAgICAgICAgIHRJZCA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgQWJvcnQuYWJvcnQoKVxyXG4gICAgICAgICAgICB9LCB0aW1lb3V0KVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgb3B0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4ge1xyXG4gICAgICAgICAgICBlcnIobmV3IEVycm9yKCdhYm9ydGVkJykpXHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBsZXQgcmVzID0gYXdhaXQgZmV0Y2godXJsLCBvcHQpXHJcblxyXG4gICAgICAgICAgICBpZiAodElkKSBjbGVhclRpbWVvdXQodElkKVxyXG5cclxuICAgICAgICAgICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcy5ib2R5LmNhbmNlbCgpXHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgW3Jlcy5zdGF0dXNdOiByZXMuc3RhdHVzVGV4dFxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBsZXQgYm9keSA9IGF3YWl0IHByb2Nlc3NSZXNwb25zZShyZXMsIHJlc3BvbnNlVHlwZSlcclxuXHJcbiAgICAgICAgICAgIG9rKGF3YWl0IG91dHB1dChib2R5KSlcclxuICAgICAgICB9XHJcbiAgICAgICAgY2F0Y2goZSkge1xyXG4gICAgICAgICAgICBlcnIoZSlcclxuICAgICAgICB9XHJcbiAgICB9KVxyXG5cclxuICAgIHAuYWJvcnQgPSAoKSA9PiBBYm9ydC5hYm9ydCgpXHJcblxyXG4gICAgcmV0dXJuIHBcclxufVxyXG5cclxuLy8gd3JhcHMgYWpheC1jYWxsIGFzIGEgZnVuY3Rpb25cclxuLy9cclxuY29uc3QgaXNPYmplY3QgPSAoYSkgPT4gKGEgIT09IG51bGwgJiYgYSBpbnN0YW5jZW9mIE9iamVjdCAmJiBhLmNvbnN0cnVjdG9yID09PSBPYmplY3QpXHJcblxyXG5leHBvcnQgY29uc3QgYWpheEZuID0gKGNmZykgPT4gYXN5bmMgKGRhdGEpID0+IHtcclxuICAgIGxldCBhID0gYXdhaXQgYWpheCh7XHJcbiAgICAgICAgLi4uKGNmZyksXHJcbiAgICAgICAgZGF0YToge1xyXG4gICAgICAgICAgICAuLi4oY2ZnLmRhdGEgfHwge30pLFxyXG4gICAgICAgICAgICAuLi4oZGF0YSlcclxuICAgICAgICB9XHJcbiAgICB9KVxyXG5cclxuICAgIC8vIHByb2Nlc3MgZGF0YS9lcnJvcnMsXHJcbiAgICAvLyBib3Jyb3dlZCBmcm9tIGdyYXBoUUxcclxuICAgIC8vXHJcbiAgICBpZiAoaXNPYmplY3QoYSkpIHtcclxuICAgICAgICBsZXQgeyBkYXRhOmQsIGVycm9ycyB9ID0gYVxyXG4gICAgICAgIGlmIChCb29sZWFuKGQpIF4gQm9vbGVhbihlcnJvcnMpKSB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcnMpIHRocm93IGVycm9yc1xyXG4gICAgICAgICAgICByZXR1cm4gZFxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gYVxyXG59XHJcbiIsIlxuLy8gcmVmOiBodHRwczovL3N0YWNrb3ZlcmZsb3cuY29tL3F1ZXN0aW9ucy8xMDA3OTgxL2hvdy10by1nZXQtZnVuY3Rpb24tcGFyYW1ldGVyLW5hbWVzLXZhbHVlcy1keW5hbWljYWxseVxuLy9cbmxldCBTVFJJUF9DT01NRU5UUyA9IC8oXFwvXFwvLiokKXwoXFwvXFwqW1xcc1xcU10qP1xcKlxcLyl8KFxccyo9W14sXFwpXSooKCcoPzpcXFxcJ3xbXidcXHJcXG5dKSonKXwoXCIoPzpcXFxcXCJ8W15cIlxcclxcbl0pKlwiKSl8KFxccyo9W14sXFwpXSopKS9tZztcbmxldCBBUkdVTUVOVF9OQU1FUyA9IC8oW15cXHMsXSspL2c7XG5mdW5jdGlvbiBnZXRBcmdOYW1lcyhmdW5jKSB7XG4gICAgaWYgKHR5cGVvZihmdW5jKSE9PVwiZnVuY3Rpb25cIikgcmV0dXJuIFtdXG5cbiAgICBsZXQgZm5TdHIgPSBmdW5jXG4gICAgICAgIC50b1N0cmluZygpXG4gICAgICAgIC5yZXBsYWNlKFNUUklQX0NPTU1FTlRTLCAnJylcbiAgICBsZXQgYXJyID0gZm5TdHJcbiAgICAgICAgLnNsaWNlKGZuU3RyLmluZGV4T2YoJygnKSsxLCBmblN0ci5pbmRleE9mKCcpJykpXG4gICAgICAgIC5tYXRjaChBUkdVTUVOVF9OQU1FUyk7XG4gICAgcmV0dXJuIGFyciA/PyBbXVxufVxuXG4vLyBxdWVyeSBvYmplY3QgZm9yIHBhdGhcbi8vXG5sZXQgcXVlcnlBcmcgPSAob2JqLCBwYXRoKSA9PiB7XG4gICAgaWYgKCFvYmogfHwgdHlwZW9mIG9iaiAhPT0gJ29iamVjdCcpIHJldHVyblxuXG4gICAgbGV0IG4gPSBwYXRoLmxlbmd0aFxuICAgIGlmIChuPT09MCkgcmV0dXJuXG5cbiAgICB2YXIgY3VyID0gb2JqXG4gICAgdmFyIHZhbCA9IHVuZGVmaW5lZFxuICAgIGZvciAobGV0IG4gb2YgcGF0aCkge1xuICAgICAgICBpZiAoIWN1ci5oYXNPd25Qcm9wZXJ0eShuKSkge1xuICAgICAgICAgICAgdmFsID0gdW5kZWZpbmVkXG4gICAgICAgICAgICBicmVha1xuICAgICAgICB9XG4gICAgICAgIHZhbCA9IGN1ciA9IGN1cltuXVxuICAgIH1cbiAgICByZXR1cm4gdmFsXG59XG5cbi8vIHF1ZXJ5IGZvciBlYWNoIG5hbWVzXG4vL1xubGV0IHF1ZXJ5QXJncyA9IChcbiAgICBjdHgsXG4gICAgbmFtZXMsXG4gICAgZGVsaW1pdGVyPSckJywgLy8gdmFsaWQgdmFyLW5hbWVzIGlzIFthLXpBLVowLTlfJF1cbikgPT4ge1xuICAgIHJldHVybiBBcnJheVxuICAgICAgICAuZnJvbShuYW1lcylcbiAgICAgICAgLm1hcChuID0+IG4uc3BsaXQoZGVsaW1pdGVyKS5maWx0ZXIoQm9vbGVhbikpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgLm1hcChucyA9PiBxdWVyeUFyZyhjdHgsIG5zKSlcbn1cblxuXG4vLyBjaGVjayBpZiBzYW1lXG4vL1xubGV0IGVxdWFsQXJncyA9IChhcmdzMSwgYXJnczIpID0+IHtcblxuICAgIGlmIChhcmdzMS5sZW5ndGghPT1hcmdzMi5sZW5ndGgpIHJldHVybiBmYWxzZVxuXG4gICAgcmV0dXJuIGFyZ3MxLmV2ZXJ5KChhLCBpKSA9PiB7XG4gICAgICAgIGxldCBiID0gYXJnczJbaV1cbiAgICAgICAgcmV0dXJuIHR5cGVvZihhKSA9PSAnb2JqZWN0J1xuICAgICAgICAgICAgPyBhID09IGIgLy8gY2hlY2sgcG9pbnRlciBvbmx5XG4gICAgICAgICAgICA6IGEgPT09IGJcbiAgICB9KVxufVxuXG5cbi8vIGNhY2hlcyBsYXN0IG91dHB1dFxuLy9cbmV4cG9ydCBjbGFzcyBNZW1vRnVuY3Rpb24ge1xuXG4gICAgY29uc3RydWN0b3IoZnVuYykge1xuICAgICAgICB0aGlzLmZ1bmMgPSBmdW5jXG4gICAgICAgIHRoaXMuYXJnTmFtZXMgPSBnZXRBcmdOYW1lcyhmdW5jKVxuICAgIH1cblxuICAgIGNhbGwodGhpc0FyZykge1xuXG4gICAgICAgIGlmICh0aGlzLmFyZ05hbWVzLmxlbmd0aD09PTApIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZ1bmMuY2FsbCh0aGlzQXJnKVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGFyZ3VtZW50cy5sZW5ndGg9PT0wKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jdXJPdXRwdXRcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLmFwcGx5KFxuICAgICAgICAgICAgdGhpc0FyZyxcbiAgICAgICAgICAgIHF1ZXJ5QXJncyh0aGlzQXJnLCB0aGlzLmFyZ05hbWVzKSlcbiAgICB9XG5cbiAgICBhcHBseSh0aGlzQXJnLCBhcmdzKSB7XG5cbiAgICAgICAgbGV0IGYgPSAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMClcbiAgICAgICAgICAgIHx8IChcbiAgICAgICAgICAgICAgICB0aGlzLmN1ckFyZ3NcbiAgICAgICAgICAgICAgICAmJiBlcXVhbEFyZ3MoYXJncywgdGhpcy5jdXJBcmdzKVxuICAgICAgICAgICAgKVxuICAgICAgICBpZiAoZikgcmV0dXJuIHRoaXMuY3VyT3V0cHV0XG5cblxuICAgICAgICB0aGlzLmN1ckFyZ3MgPSBhcmdzXG4gICAgICAgIHRoaXMuY3VyT3V0cHV0ID0gdGhpcy5mdW5jLmFwcGx5KHRoaXNBcmcsIGFyZ3MpXG4gICAgICAgIHJldHVybiB0aGlzLmN1ck91dHB1dFxuICAgIH1cbn0iLCJpbXBvcnQgeyBNZW1vRnVuY3Rpb24gfSBmcm9tICcuL2RlcHMuanMnXG5cbi8vIHJlZnJlc2hhYmxlIHN0cmluZyB0ZW1wbGF0ZSB3aXRoIG1lbW9pemVkIGZ1bmN0aW9uc1xuLy9cbmxldCBUbXBsID0gY2xhc3Mge1xuICAgIGNvbnN0cnVjdG9yKHN0cmluZ3MsIGZ1bmNzKSB7XG4gICAgICAgIHRoaXMuc3RyaW5ncyA9IHN0cmluZ3NcbiAgICAgICAgdGhpcy5mdW5jdGlvbnMgPSBmdW5jc1xuICAgICAgICAgICAgLm1hcChmID0+IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHlwZW9mKGYpID09PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgICAgID8gbmV3IE1lbW9GdW5jdGlvbihmKVxuICAgICAgICAgICAgICAgICAgICA6ICgoKSA9PiBmKVxuICAgICAgICAgICAgfSlcbiAgICB9XG5cblxuICAgIGJ1aWxkKGNvbnRleHQpIHtcbiAgICAgICAgbGV0IG4gPSBhcmd1bWVudHMubGVuZ3RoXG4gICAgICAgIHJldHVybiB0aGlzLnN0cmluZ3NcbiAgICAgICAgICAgIC5tYXAoKHN0ciwgaW5keCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBmID0gdGhpcy5mdW5jdGlvbnNbaW5keF1cbiAgICAgICAgICAgICAgICBsZXQgdCA9IGYgPyAobj09PTAgPyBmLmNhbGwoKTogZi5jYWxsKGNvbnRleHQpKSA6ICcnXG4gICAgICAgICAgICAgICAgaWYgKHQgJiYgdCBpbnN0YW5jZW9mIFRtcGwpIHtcbiAgICAgICAgICAgICAgICAgICAgdCA9IGNvbnRleHQgPyB0LmJ1aWxkKGNvbnRleHQpIDogdC5idWlsZCgpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgICAgIHN0cixcbiAgICAgICAgICAgICAgICAgICAgdCxcbiAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmZsYXQoKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICAgICAgLmpvaW4oJycpXG4gICAgfVxufVxuXG5leHBvcnQgbGV0IHRtcGwgPSAoc3RyaW5ncywgLi4uZnVuY3MpID0+IHtcbiAgICByZXR1cm4gbmV3IFRtcGwoc3RyaW5ncywgZnVuY3MpXG59XG4iLCIvLyB3aXJlIGVsZW1lbnRzIHdpdGggZXZlbnRzXG4vL1xuZXhwb3J0IGxldCB3aXJlID0gKHJvb3QsIGNmZywgYXJnKSA9PiBuZXcgQ2lyY3VpdChyb290LCBjZmcsIGFyZylcblxuZXhwb3J0IGxldCBDaXJjdWl0ID0gY2xhc3Mge1xuXG4gICAgY29uc3RydWN0b3IoXG4gICAgICAgIHJvb3RFbCxcbiAgICAgICAgZXZlbnRDb25maWdzLFxuICAgICAgICB7XG4gICAgICAgICAgICB0aGlzT2JqID0ge30sXG4gICAgICAgICAgICBxdWVyeUZuTmFtZSA9ICdxdWVyeVNlbGVjdG9yQWxsJyxcbiAgICAgICAgICAgIGxpc3RlbkZuTmFtZSA9ICdhZGRFdmVudExpc3RlbmVyJyxcbiAgICAgICAgICAgIHVubGlzdGVuRm5OYW1lPSAncmVtb3ZlRXZlbnRMaXN0ZW5lcicsXG4gICAgICAgICAgICBub3RpZnlGbk5hbWU9J2Rpc3BhdGNoRXZlbnQnLFxuICAgICAgICAgICAgdmFsaWRhdG9yID0gKGUpID0+IGUucGFyZW50Tm9kZSxcbiAgICAgICAgfSA9IHt9XG4gICAgKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbWUucm9vdEVsID0gcm9vdEVsXG4gICAgICAgIG1lLm5vZGVzID0ge31cbiAgICAgICAgbWUud2lyZXMgPSBuZXcgV2Vha01hcCgpXG4gICAgICAgIG1lLmZ1bmNzID0ge1xuICAgICAgICAgICAgcXVlcnlGbk5hbWUsXG4gICAgICAgICAgICBsaXN0ZW5Gbk5hbWUsXG4gICAgICAgICAgICB1bmxpc3RlbkZuTmFtZSxcbiAgICAgICAgICAgIG5vdGlmeUZuTmFtZSxcbiAgICAgICAgICAgIHZhbGlkYXRvcixcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGV2ZW50J3MgbGlzdGVuZXJzIHNjb3BlXG4gICAgICAgIC8vXG4gICAgICAgIG1lLnRoaXMgPSBuZXcgUHJveHkodGhpc09iaiwge1xuICAgICAgICAgICAgZ2V0KF8sIG5hbWUpIHtcbiAgICAgICAgICAgICAgICBpZiAobmFtZSA9PT0gJ3RvcF8nICYmICEoJ3RvcF8nIGluIHRoaXNPYmopKSByZXR1cm4gbWVcbiAgICAgICAgICAgICAgICBpZiAobmFtZSA9PT0gJ2ZpcmVfJyAmJiAhKCdmaXJlXycgaW4gdGhpc09iaikpIHJldHVybiBtZS5maXJlLmJpbmQobWUpXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gbWUubm9kZXMgJiYgbWUubm9kZXNbbmFtZV1cbiAgICAgICAgICAgICAgICAgICAgfHwgUmVmbGVjdC5nZXQoLi4uYXJndW1lbnRzKVxuICAgICAgICAgICAgfSxcblxuICAgICAgICAgICAgZGVsZXRlUHJvcGVydHkoXywgbmFtZSkge1xuICAgICAgICAgICAgICAgIGlmICghbWUubm9kZXMgfHwgIW1lLm5vZGVzW25hbWVdKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBSZWZsZWN0LmRlbGV0ZVByb3BlcnR5KC4uLmFyZ3VtZW50cylcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbGV0IGVsID0gbWUubm9kZXNbbmFtZV1cbiAgICAgICAgICAgICAgICBtZS5kZXdpcmUoZWwpXG4gICAgICAgICAgICAgICAgZGVsZXRlIG1lLm5vZGVzW25hbWVdXG4gICAgICAgICAgICB9LFxuICAgICAgICB9KVxuXG4gICAgICAgIC8vIGluaXRpYWxpemUgZXZlbnQtY29uZmlnc1xuICAgICAgICAvL1xuICAgICAgICBPYmplY3QuZW50cmllcyhldmVudENvbmZpZ3MpLmZvckVhY2goKFtxcnksIGV2ZW50Q29uZmlnXSkgPT4ge1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mIGV2ZW50Q29uZmlnID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGV2ZW50Q29uZmlnRm4gPSBldmVudENvbmZpZ1xuXG4gICAgICAgICAgICAgICAgbWUuI2dldEVsZW1zKHFyeSkuZm9yRWFjaCggKGVsLCBpLCBhcnIpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGEgPSBldmVudENvbmZpZ0ZuLmNhbGwobWUudGhpcywgZWwsIGksIGFycilcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgY2ZnLCBub2RlSWQgfSA9IG1lLiNnZXRDZmcoYSlcblxuICAgICAgICAgICAgICAgICAgICBtZS53aXJlKGVsLCBjZmcsIG5vZGVJZClcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBjZmcsIG5vZGVJZCB9ID0gbWUuI2dldENmZyhldmVudENvbmZpZylcblxuICAgICAgICAgICAgICAgIG1lLiNnZXRFbGVtcyhxcnkpLmZvckVhY2goIChlbCwgaSwgYXJyKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIG1lLndpcmUoZWwsIGNmZywgbm9kZUlkKVxuICAgICAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICB9XG5cbiAgICAjZ2V0RWxlbXMocXJ5KSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbGV0IHF1ZXJ5Rm5OYW1lID0gbWUuZnVuY3MucXVlcnlGbk5hbWVcbiAgICAgICAgbGV0IGlzUm9vdCA9IHFyeT09PScuJ1xuICAgICAgICByZXR1cm4gaXNSb290XG4gICAgICAgICAgICA/IFttZS5yb290RWxdXG4gICAgICAgICAgICA6IFsuLi4obWUucm9vdEVsW3F1ZXJ5Rm5OYW1lXShxcnkpKV1cbiAgICB9XG5cbiAgICAjZ2V0Q2ZnKGV2ZW50Q29uZmlnKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbGV0IG1ldGEgPSB7fVxuICAgICAgICBsZXQgY2ZnID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgICAgT2JqZWN0XG4gICAgICAgICAgICAuZW50cmllcyhldmVudENvbmZpZylcbiAgICAgICAgICAgIC5maWx0ZXIoIChbbmFtZSwgdmFsXSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpc0NvbmZpZyA9IG5hbWVbMF09PT0nXydcbiAgICAgICAgICAgICAgICBpZiAoaXNDb25maWcpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGsgPSBuYW1lLnNsaWNlKDEpXG4gICAgICAgICAgICAgICAgICAgIG1ldGFba10gPSB2YWxcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICB9KVxuICAgICAgICApXG5cbiAgICAgICAgbGV0IG5vZGVJZCA9IG1ldGEuaWRcbiAgICAgICAgbGV0IGlzQ29uZmxpY3QgPSBtZS50aGlzW25vZGVJZF1cbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZS50aGlzW25vZGVJZF0gPT09ICdmdW5jdGlvbidcbiAgICAgICAgaWYgKGlzQ29uZmxpY3QpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgY29uZmxpY3Rpbmcgbm9kZXMgXCIke25vZGVJZH1cImApXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY2ZnLFxuICAgICAgICAgICAgbm9kZUlkLFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gY291bnRlciBmb3IgdW5uYW1lZCBub2RlSWRcbiAgICAvL1xuICAgIHN0YXRpYyBfaWQgPSAwXG5cbiAgICAvLyBhdHRhY2ggZXZlbnRzIHRvIGVsZW1lbnRcbiAgICAvL1xuICAgIHdpcmUoZWwsIGV2ZW50cywgbm9kZUlkKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcblxuICAgICAgICBpZiAoIW1lLndpcmVzLmhhcyhlbCkpIHtcbiAgICAgICAgICAgIG1lLndpcmVzLnNldChlbCwgW10pXG4gICAgICAgICAgICBsZXQgaWQgPSBub2RlSWQgfHwgYG5vZGUtJHsrK0NpcmN1aXQuX2lkfWBcbiAgICAgICAgICAgIG1lLm5vZGVzW2lkXSA9IGVsXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGlzdGVuID0gbWUuZnVuY3MubGlzdGVuRm5OYW1lXG4gICAgICAgIE9iamVjdFxuICAgICAgICAuZW50cmllcyhldmVudHMpXG4gICAgICAgIC5mb3JFYWNoKChbdHlwZSwgbGlzdGVuZXJdKSA9PiB7XG4gICAgICAgICAgICBsZXQgZm4gPSBsaXN0ZW5lci5iaW5kKG1lLnRoaXMpXG4gICAgICAgICAgICBlbFtsaXN0ZW5dKHR5cGUsIGZuKVxuXG4gICAgICAgICAgICBtZS53aXJlc1xuICAgICAgICAgICAgICAgIC5nZXQoZWwpXG4gICAgICAgICAgICAgICAgLnB1c2goW3R5cGUsIGZuXSlcbiAgICAgICAgfSlcbiAgICB9XG5cblxuICAgIC8vIHJlbW92ZSBldmVudHMgZnJvbSBhbiBlbGVtZW50XG4gICAgLy9cbiAgICBkZXdpcmUoZWwpIHtcbiAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICBsZXQgd20gPSBtZS53aXJlc1xuICAgICAgICBpZiAoIXdtLmhhcyhlbCkpIHJldHVybiBmYWxzZVxuXG4gICAgICAgIGxldCB1bmxpc3RlbiA9IG1lLmZ1bmNzLnVubGlzdGVuRm5OYW1lXG4gICAgICAgIHdtLmdldChlbCkuZm9yRWFjaCggKFt0eXBlLCBmbl0pID0+IHtcbiAgICAgICAgICAgIGVsW3VubGlzdGVuXSh0eXBlLCBmbilcbiAgICAgICAgfSlcbiAgICB9XG5cbiAgICAvLyBkZWxldGUgZXZlbnRzIGZyb20gYWxsIGVsZW1lbnRzXG4gICAgLy9cbiAgICBkZWxldGUoKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgT2JqZWN0LnZhbHVlcyhtZS5ub2RlcykuZm9yRWFjaChlbCA9PiBtZS5kZXdpcmUoZWwpKVxuICAgICAgICBtZS5yb290RWwgPSBudWxsXG4gICAgICAgIG1lLm5vZGVzID0gbnVsbFxuICAgICAgICBtZS53aXJlcyA9IG51bGxcbiAgICB9XG5cbiAgICAvLyByZW1vdmUgb3JwaGFuZWQgZWxlbWVudHNcbiAgICAvL1xuICAgIGNsZWFuKCkge1xuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIGxldCB2YWxpZGF0ZSA9IG1lLmZ1bmNzLnZhbGlkYXRvclxuICAgICAgICBmb3IgKGxldCBbaWQsIGVsXSBvZiBPYmplY3QuZW50cmllcyhtZS5ub2RlcykpIHtcbiAgICAgICAgICAgIGlmIChlbD09bWUucm9vdEVsIHx8IHZhbGlkYXRlKGVsKSkgY29udGludWVcblxuICAgICAgICAgICAgbWUuZGV3aXJlKGVsKVxuICAgICAgICAgICAgZGVsZXRlIG1lLm5vZGVzW2lkXVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gZ2V0IG5vZGVzIHdoaWNoIGhhcyBldmVudE5hbWVcbiAgICAvL1xuICAgIG5vZGVzVGhhdExpc3RlblRvKGV2ZW50TmFtZSx7XG4gICAgICAgIGlzU2tpcFJvb3RFbD1mYWxzZSxcbiAgICB9ID0ge30pIHtcblxuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIGxldCB3bSA9IG1lLndpcmVzXG5cbiAgICAgICAgcmV0dXJuIE9iamVjdFxuICAgICAgICAgICAgLnZhbHVlcyhtZS5ub2RlcylcbiAgICAgICAgICAgIC5maWx0ZXIoZWwgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgIXdtLmhhcyhlbClcbiAgICAgICAgICAgICAgICAgICAgfHwgaXNTa2lwUm9vdEVsICYmIGVsPT09bWUucm9vdEVsXG4gICAgICAgICAgICAgICAgKSByZXR1cm5cblxuICAgICAgICAgICAgICAgIHJldHVybiB3bS5nZXQoZWwpXG4gICAgICAgICAgICAgICAgICAgIC5maW5kKCAoW25hbWUsX10pID0+IG5hbWU9PT1ldmVudE5hbWUpXG4gICAgICAgICAgICB9KVxuICAgIH1cblxuICAgIC8vIHRyaWdnZXJzIGV2ZW50cyBvZiBzcGVjaWZpYyBuYW1lXG4gICAgLy9cbiAgICBmaXJlKGV2dCwge1xuICAgICAgICBpc1NraXBSb290RWw9ZmFsc2UsXG4gICAgfSA9IHt9KSB7XG4gICAgICAgIGlmICghZXZ0IHx8ICFldnQudHlwZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdpbnZhbGlkIGV2ZW50JylcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbGV0IGZuID0gbWUuZnVuY3Mubm90aWZ5Rm5OYW1lXG5cbiAgICAgICAgbGV0IGV2ZW50VHlwZSA9IGV2dC50eXBlXG4gICAgICAgIG1lXG4gICAgICAgIC5ub2Rlc1RoYXRMaXN0ZW5UbyhldmVudFR5cGUsIHsgaXNTa2lwUm9vdEVsIH0pXG4gICAgICAgIC5mb3JFYWNoKGVsID0+IHtcbiAgICAgICAgICAgIGlmICghZWxbZm5dKSByZXR1cm5cbiAgICAgICAgICAgIGVsW2ZuXS5jYWxsKGVsLCBldnQpXG4gICAgICAgIH0pXG4gICAgfVxufVxuIiwiZXhwb3J0IHsgdG1wbCwgfSBmcm9tICcuL2RlcHMuanMnXG5pbXBvcnQgeyB3aXJlLCB9IGZyb20gJy4vZGVwcy5qcydcblxuZXhwb3J0IGxldCBjdXN0b21FbGVtZW50RGVmYXVsdHMgPSB7XG4gICAgaGVhZGVyOiAnJyxcbiAgICBmb290ZXI6ICcnLFxufVxuXG4vLyBidWlsZHMgYSB3aXJlZCBjdXN0b20tZWxlbWVudCBmcm9tIGEgc3RyaW5nIHRlbXBsYXRlXG4vL1xuZXhwb3J0IGxldCBjdXN0b21FbGVtZW50ID0gKFxuICAgIHRlbXBsYXRlLFxuICAgIHtcbiAgICAgICAgX2hlYWRlciA9IGN1c3RvbUVsZW1lbnREZWZhdWx0cy5oZWFkZXIsXG4gICAgICAgIF9mb290ZXIgPSBjdXN0b21FbGVtZW50RGVmYXVsdHMuZm9vdGVyLFxuICAgICAgICBfd2lyZXMgPSB7fSxcbiAgICAgICAgX2F0dHJpYnV0ZXMgPSB7fSxcbiAgICAgICAgX2Zvcm1Bc3NvY2lhdGVkID0gdHJ1ZSxcbiAgICAgICAgLi4uY29udGV4dFxuICAgIH0gPSB7fSxcblxuICAgIC8vIG5lZWRlZCBjbGFzc2VzIGZvciB0ZXN0aW5nXG4gICAge1xuICAgICAgICBIVE1MRWxlbWVudCA9IGdsb2JhbFRoaXMuSFRNTEVsZW1lbnQsXG4gICAgICAgIGRvY3VtZW50ID0gZ2xvYmFsVGhpcy5kb2N1bWVudCxcbiAgICAgICAgQ3VzdG9tRXZlbnQgPSBnbG9iYWxUaGlzLkN1c3RvbUV2ZW50LFxuICAgIH0gPSB7fSxcbikgPT4ge1xuXG4gICAgcmV0dXJuIGNsYXNzIGV4dGVuZHMgSFRNTEVsZW1lbnQge1xuICAgICAgICBzdGF0aWMgZm9ybUFzc29jaWF0ZWQgPSBfZm9ybUFzc29jaWF0ZWRcblxuICAgICAgICBjb25zdHJ1Y3RvcigpIHtcbiAgICAgICAgICAgIHN1cGVyKClcbiAgICAgICAgICAgIHRoaXMudGVtcGxhdGVfID0gdGVtcGxhdGVcbiAgICAgICAgICAgIHRoaXMuY29udGV4dF8gPSBPYmplY3QuYXNzaWduKHtcbiAgICAgICAgICAgICAgICByb290Xzp0aGlzLFxuICAgICAgICAgICAgICAgIGJ1aWxkXzogdGhpcy5idWlsZC5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgICAgIGZpcmVfOiB0aGlzLmZpcmUuYmluZCh0aGlzKSxcbiAgICAgICAgICAgIH0sIGNvbnRleHQpXG5cbiAgICAgICAgICAgIHRoaXMud2lyZXNDb25maWcgPSBfd2lyZXNcbiAgICAgICAgICAgIHRoaXMuYXR0YWNoU2hhZG93KHsgbW9kZTonb3BlbicgfSlcbiAgICAgICAgICAgIHRoaXMuYnVpbGQoKVxuICAgICAgICB9XG5cbiAgICAgICAgYnVpbGQoXG4gICAgICAgICAgICB1cGRhdGVDb250ZXh0PXt9LFxuICAgICAgICApIHtcbiAgICAgICAgICAgIGlmICh0aGlzLndpcmVzXykge1xuICAgICAgICAgICAgICAgIHRoaXMud2lyZXNfLmRlbGV0ZSgpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMuY29udGV4dF8sIHVwZGF0ZUNvbnRleHQpXG5cbiAgICAgICAgICAgIGxldCByID0gdGhpcy5zaGFkb3dSb290XG4gICAgICAgICAgICB3aGlsZShyLmZpcnN0Q2hpbGQpIHtcbiAgICAgICAgICAgICAgICByLnJlbW92ZUNoaWxkKHIuZmlyc3RDaGlsZClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0ZW1wbGF0ZScpXG4gICAgICAgICAgICB0LmlubmVySFRNTCA9IFtcbiAgICAgICAgICAgICAgICBfaGVhZGVyLFxuICAgICAgICAgICAgICAgIHRlbXBsYXRlLmJ1aWxkKHRoaXMuY29udGV4dF8pLFxuICAgICAgICAgICAgICAgIF9mb290ZXJcbiAgICAgICAgICAgIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJycpXG4gICAgICAgICAgICByLmFwcGVuZENoaWxkKHQuY29udGVudC5jbG9uZU5vZGUodHJ1ZSkpXG4gICAgICAgICAgICB0ID0gbnVsbFxuXG4gICAgICAgICAgICB0aGlzLndpcmVzXyA9IHdpcmUociwgdGhpcy53aXJlc0NvbmZpZywge1xuICAgICAgICAgICAgICAgIHRoaXNPYmo6IHRoaXMuY29udGV4dF8sXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgdGhpcy50aGlzID0gdGhpcy53aXJlc18udGhpc1xuICAgICAgICB9XG5cbiAgICAgICAgZmlyZShldikge1xuICAgICAgICAgICAgdGhpcy53aXJlc18uZmlyZShldilcbiAgICAgICAgICAgIHRoaXMuZGlzcGF0Y2hFdmVudChldilcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbm5lY3RlZENhbGxiYWNrKCkge1xuICAgICAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICAgICAgbGV0IGV2ID0gbmV3IEN1c3RvbUV2ZW50KCdjb25uZWN0ZWQnLCB7IGRldGFpbDpudWxsIH0pXG4gICAgICAgICAgICBtZS5maXJlKGV2KVxuICAgICAgICB9XG5cbiAgICAgICAgZGlzY29ubmVjdGVkQ2FsbGJhY2soKSB7XG4gICAgICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgICAgICBsZXQgZXYgPSBuZXcgQ3VzdG9tRXZlbnQoJ2Rpc2Nvbm5lY3RlZCcsIHsgZGV0YWlsOm51bGwgfSlcbiAgICAgICAgICAgIG1lLmZpcmUoZXYpXG4gICAgICAgIH1cblxuICAgICAgICBhZG9wdGVkQ2FsbGJhY2soKSB7XG4gICAgICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgICAgICBsZXQgZXYgPSBuZXcgQ3VzdG9tRXZlbnQoJ2Fkb3B0ZWQnLCB7IGRldGFpbDpudWxsIH0pXG4gICAgICAgICAgICBtZS5maXJlKGV2KVxuICAgICAgICB9XG5cbiAgICAgICAgc3RhdGljIGdldCBvYnNlcnZlZEF0dHJpYnV0ZXMoKSB7XG4gICAgICAgICAgICByZXR1cm4gT2JqZWN0LmtleXMoX2F0dHJpYnV0ZXMpXG4gICAgICAgIH1cblxuICAgICAgICBhdHRyaWJ1dGVDaGFuZ2VkQ2FsbGJhY2sobmFtZSwgb2xkVmFsdWUsIHZhbHVlKSB7XG4gICAgICAgICAgICBsZXQgZiA9IF9hdHRyaWJ1dGVzW25hbWVdXG4gICAgICAgICAgICBpZiAoZiAmJiB0eXBlb2YgZiA9PT0nZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgZi5jYWxsKHRoaXMuY29udGV4dF8sIHZhbHVlLCBvbGRWYWx1ZSlcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICAgICAgbGV0IGV2ID0gbmV3IEN1c3RvbUV2ZW50KCdhdHRyaWJ1dGVfY2hhbmdlZCcsIHtcbiAgICAgICAgICAgICAgICBkZXRhaWw6e25hbWUsIHZhbHVlLCBvbGRWYWx1ZSx9XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgbWUuZmlyZShldilcbiAgICAgICAgfVxuICAgIH1cbn1cbiIsImltcG9ydCB7IHRtcGwsIHdpcmUsIH0gZnJvbSAnLi9kZXBzLmpzJ1xuXG5leHBvcnQgbGV0IHdpcmVFbGVtZW50ID0gKFxuICAgIHJvb3RFbCxcbiAgICB0ZW1wbGF0ZSxcbiAgICBjZmcsXG5cbiAgICAvLyBuZWVkZWQgY2xhc3NlcyBmb3IgdGVzdGluZ1xuICAgIHtcbiAgICAgICAgZG9jdW1lbnQgPSBnbG9iYWxUaGlzLmRvY3VtZW50LFxuICAgIH0gPSB7fSxcbikgPT4ge1xuICAgIHJldHVybiBuZXcgV2lyZWRFbGVtZW50KFxuICAgICAgICByb290RWwsIHRlbXBsYXRlLCBjZmcsIHsgZG9jdW1lbnQgfVxuICAgIClcblxufVxuXG5sZXQgV2lyZWRFbGVtZW50ID0gY2xhc3Mge1xuICAgIGNvbnN0cnVjdG9yKFxuICAgICAgICByb290RWwsXG4gICAgICAgIHRlbXBsYXRlLFxuICAgICAgICB7XG4gICAgICAgICAgICBfd2lyZXMgPSB7fSxcbiAgICAgICAgICAgIC4uLmNvbnRleHRcbiAgICAgICAgfSA9IHt9LFxuICAgICAgICB7XG4gICAgICAgICAgICBkb2N1bWVudCA9IGdsb2JhbFRoaXMuZG9jdW1lbnQsXG4gICAgICAgIH1cbiAgICApIHtcbiAgICAgICAgdGhpcy5yb290ID0gcm9vdEVsXG4gICAgICAgIHRoaXMudGVtcGxhdGVfID0gdGVtcGxhdGVcbiAgICAgICAgdGhpcy5jb250ZXh0XyA9IE9iamVjdC5hc3NpZ24oe1xuICAgICAgICAgICAgcm9vdF86dGhpcyxcbiAgICAgICAgICAgIGJ1aWxkXzogdGhpcy5idWlsZC5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgZmlyZV86IHRoaXMuZmlyZS5iaW5kKHRoaXMpLFxuICAgICAgICB9LCBjb250ZXh0KVxuXG4gICAgICAgIHRoaXMud2lyZXNDb25maWcgPSBfd2lyZXNcbiAgICAgICAgdGhpcy5kb2N1bWVudCA9IGRvY3VtZW50XG4gICAgICAgIHRoaXMuYnVpbGQoKVxuICAgIH1cblxuICAgIGJ1aWxkKFxuICAgICAgICB1cGRhdGVDb250ZXh0PXt9LFxuICAgICkge1xuICAgICAgICBpZiAodGhpcy53aXJlc18pIHtcbiAgICAgICAgICAgIHRoaXMud2lyZXNfLmRlbGV0ZSgpO1xuICAgICAgICB9XG5cbiAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLmNvbnRleHRfLCB1cGRhdGVDb250ZXh0KVxuXG4gICAgICAgIGxldCByID0gdGhpcy5yb290XG4gICAgICAgIHdoaWxlKHIuZmlyc3RDaGlsZCkge1xuICAgICAgICAgICAgci5yZW1vdmVDaGlsZChyLmZpcnN0Q2hpbGQpXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdCA9IHRoaXMuZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGVtcGxhdGUnKVxuICAgICAgICB0LmlubmVySFRNTCA9IHRoaXMudGVtcGxhdGVfLmJ1aWxkKHRoaXMuY29udGV4dF8pLFxuICAgICAgICByLmFwcGVuZENoaWxkKHQuY29udGVudC5jbG9uZU5vZGUodHJ1ZSkpXG4gICAgICAgIHQgPSBudWxsXG5cbiAgICAgICAgdGhpcy53aXJlc18gPSB3aXJlKHIsIHRoaXMud2lyZXNDb25maWcsIHtcbiAgICAgICAgICAgIHRoaXNPYmo6IHRoaXMuY29udGV4dF8sXG4gICAgICAgIH0pXG4gICAgICAgIHRoaXMudGhpcyA9IHRoaXMud2lyZXNfLnRoaXNcbiAgICB9XG5cbiAgICBmaXJlKGV2KSB7XG4gICAgICAgIHRoaXMud2lyZXNfLmZpcmUoZXYsIHtpc1NraXBSb290RWw6dHJ1ZX0pXG4gICAgICAgIHRoaXMucm9vdC5kaXNwYXRjaEV2ZW50KGV2KVxuICAgIH1cblxufSIsImxldCBhcnJheUZyb20gPSAoYXJyKSA9PiBBcnJheS5pc0FycmF5KGFycikgPyBhcnIgOiBbYXJyXVxyXG5cclxuLy8gcHVibGlzaC1zdWJzY3JpYmUgdG8gY2hhbm5lbHNcclxuLy9cclxuZXhwb3J0IGNsYXNzIFB1YlN1YiB7XHJcbiAgICBjb25zdHJ1Y3RvciAoe1xyXG4gICAgICAgIGJyb2FkY2FzdENoYW5uZWxJZFxyXG4gICAgfSkge1xyXG4gICAgICAgIHZhciBtZSA9IHRoaXNcclxuICAgICAgICBtZS5faWQgPSAwXHJcbiAgICAgICAgbWUuY2hhbm5lbHMgPSB7fSAvLyBsb2NhbCBjaGFubmVsc1xyXG5cclxuICAgICAgICAvLyBhbHNvIGxpc3RlbnMgdG8gYnJvYWRhY2FzdCBjaGFubmVsXHJcbiAgICAgICAgLy9cclxuICAgICAgICBpZiAoYnJvYWRjYXN0Q2hhbm5lbElkKSB7XHJcbiAgICAgICAgICAgIGxldCBiYyA9IG5ldyBCcm9hZGNhc3RDaGFubmVsKGJyb2FkY2FzdENoYW5uZWxJZClcclxuXHJcbiAgICAgICAgICAgIGJjLm9ubWVzc2FnZSA9IChldikgPT4ge1xyXG4gICAgICAgICAgICAgICAgbGV0IHsgY2hhbm5lbCwgYXJncyB9ID0gZXYuZGF0YVxyXG4gICAgICAgICAgICAgICAgbWUucHVibGlzaF8uYXBwbHkobWUsIFtjaGFubmVsXS5jb25jYXQoYXJncykpXHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIG1lLmJyb2FkY2FzdENoYW5uZWwgPSBiY1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBjbGVhcnMgYWxsIGNoYW5uZWxcclxuICAgIHJlc2V0KCkge1xyXG4gICAgICAgIHRoaXMuX2lkID0gMFxyXG4gICAgICAgIHRoaXMuY2hhbm5lbHMgPSB7fVxyXG4gICAgfVxyXG5cclxuICAgIC8vIGNyZWF0ZXMgY2hhbm5lbC51bmlxdWVfaWRcclxuICAgIC8vXHJcbiAgICBjaGFubmVsSWQoaWQpIHtcclxuICAgICAgICBsZXQgW2NoLCAuLi5uc10gPSAoaWQgfHwgJycpLnNwbGl0KCcuJylcclxuICAgICAgICByZXR1cm4gW1xyXG4gICAgICAgICAgICBjaCwgLy8gY2hhbm5lbC1uYW1lXHJcbiAgICAgICAgICAgIG5zLmpvaW4oJy4nKSB8fCBgXyR7Kyt0aGlzLl9pZH1gIC8vIGlkIHRvIGNoYW5uZWxcclxuICAgICAgICBdXHJcbiAgICB9XHJcblxyXG4gICAgLy8gY2hhbm5lbHNbY2hhbm5lbF0gPSB7IGlkOiBmbiB9XHJcbiAgICAvL1xyXG4gICAgc3Vic2NyaWJlKGlkLCBmbiwgb3ZlcnJpZGU9ZmFsc2UpIHtcclxuICAgICAgICBsZXQgW2NoLCBuXSA9IHRoaXMuY2hhbm5lbElkKGlkKVxyXG4gICAgICAgIGlmICghY2gpIHJldHVyblxyXG5cclxuICAgICAgICBsZXQgY2hhbm5lbHMgPSB0aGlzLmNoYW5uZWxzXHJcbiAgICAgICAgaWYgKCFjaGFubmVsc1tjaF0pIGNoYW5uZWxzW2NoXSA9IHt9XHJcbiAgICAgICAgbGV0IHN1YnMgPSBjaGFubmVsc1tjaF1cclxuXHJcbiAgICAgICAgaWYgKHN1YnNbbl0gJiYgIW92ZXJyaWRlKSB7XHJcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgc3Vic2NyaWJlOiAke2lkfSBhbHJlYWR5IGV4aXN0c2ApXHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBzdWJzW25dID0gZm5cclxuICAgICAgICByZXR1cm4gW2NoLCBuXS5qb2luKCcuJylcclxuICAgIH1cclxuXHJcbiAgICAvLyBkZWxldGVzIGZyb20gY2hhbm5lbFxyXG4gICAgLy9cclxuICAgIHVuc3Vic2NyaWJlKCkge1xyXG4gICAgICAgIGxldCBtZSA9IHRoaXNcclxuICAgICAgICBBcnJheS5mcm9tKGFyZ3VtZW50cykuZmxhdCgpLmZvckVhY2goKGlkKSA9PiB7XHJcbiAgICAgICAgICAgIGxldCBbY2gsIG5dID0gbWUuY2hhbm5lbElkKGlkKVxyXG4gICAgICAgICAgICBpZiAoIWNoKSByZXR1cm5cclxuXHJcbiAgICAgICAgICAgIGxldCBzdWJzID0gbWUuY2hhbm5lbHNbY2hdXHJcbiAgICAgICAgICAgIGlmICghc3VicykgcmV0dXJuXHJcblxyXG4gICAgICAgICAgICBkZWxldGUgc3Vic1tuXVxyXG4gICAgICAgIH0pXHJcbiAgICB9XHJcblxyXG4gICAgLy8gcHVibGlzaCB0byBsb2NhbCBwb29sXHJcbiAgICAvL1xyXG4gICAgcHVibGlzaF8oY2gsIC4uLmFyZ3MpIHtcclxuICAgICAgICBsZXQgc3VicyA9IHRoaXMuY2hhbm5lbHNbY2hdXHJcbiAgICAgICAgaWYgKCFzdWJzKSByZXR1cm5cclxuXHJcbiAgICAgICAgT2JqZWN0LnZhbHVlcyhzdWJzKVxyXG4gICAgICAgIC5mb3JFYWNoKGZuID0+IHtcclxuICAgICAgICAgICAgZm4uYXBwbHkobnVsbCwgYXJncylcclxuICAgICAgICB9KVxyXG4gICAgfVxyXG5cclxuICAgIC8vIHB1Ymxpc2ggdG8gbG9jYWwgYW5kIGJyb2FkY2FzdCBjaGFubmVsXHJcbiAgICAvLyBjaGFubmVsIGVuZHMgd2l0aCBcIiFcIiBicm9hZGNhc3QgdG8gYWxsIGxpc3RlbmVyc1xyXG4gICAgLy9cclxuICAgIHB1Ymxpc2goY2hhbm5lbCwgLi4uYXJncykge1xyXG4gICAgICAgIGxldCBicm9hZGNhc3QgPSBjaGFubmVsLnNsaWNlKC0xKT09PSchJ1xyXG4gICAgICAgIGNoYW5uZWwgPSBicm9hZGNhc3RcclxuICAgICAgICAgICAgPyBjaGFubmVsLnNsaWNlKDAsIC0xKVxyXG4gICAgICAgICAgICA6IGNoYW5uZWxcclxuXHJcbiAgICAgICAgaWYgKGJyb2FkY2FzdCAmJiB0aGlzLmJyb2FkY2FzdENoYW5uZWwgKSB7XHJcbiAgICAgICAgICAgIHRoaXMuYnJvYWRjYXN0Q2hhbm5lbC5wb3N0TWVzc2FnZSh7XHJcbiAgICAgICAgICAgICAgICBjaGFubmVsLFxyXG4gICAgICAgICAgICAgICAgYXJnc1xyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdGhpcy5wdWJsaXNoXy5hcHBseSh0aGlzLCBbY2hhbm5lbF0uY29uY2F0KGFyZ3MpKVxyXG4gICAgfVxyXG5cclxuICAgIC8vIGV4ZWN1dGUgdG8gbG9jYWwgY2hhbm5lbHMgb25seVxyXG4gICAgLy9cclxuICAgIGFzeW5jIGV4ZWMoY2gsIC4uLmFyZ3MpIHtcclxuICAgICAgICBsZXQgc3VicyA9IHRoaXMuY2hhbm5lbHNbY2hdXHJcbiAgICAgICAgaWYgKCFzdWJzKSByZXR1cm5cclxuXHJcbiAgICAgICAgbGV0IGZucyA9IE9iamVjdC52YWx1ZXMoc3VicylcclxuICAgICAgICAgICAgLm1hcChmbiA9PiBmbi5hcHBseShudWxsLCBhcmdzKSlcclxuICAgICAgICBsZXQgYXJyID0gYXdhaXQgUHJvbWlzZS5hbGwoZm5zKVxyXG5cclxuICAgICAgICByZXR1cm4gT2JqZWN0LmtleXMoc3VicylcclxuICAgICAgICAgICAgLnJlZHVjZSggKHgsIGlkLCBpKSA9PiB7XHJcbiAgICAgICAgICAgICAgICB4W2lkXSA9IGFycltpXVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHhcclxuICAgICAgICAgICAgfSwge30pXHJcbiAgICB9XHJcbn1cclxuXHJcbi8vIGZvciBhIGdsb2JhbCBwdWJzdWJcclxuLy9cclxuY29uc3QgV0VCX1BVQlNVQl9CUk9BRENBU1RfQ0hBTk5FTF9JRCA9XHJcbiAgICBnbG9iYWxUaGlzLldFQl9QVUJTVUJfQlJPQURDQVNUX0NIQU5ORUxfSURcclxuICAgIHx8ICd3ZWItcHVic3ViLWJyb2FkY2FzdC1jaGFubmVsLWlkJ1xyXG5leHBvcnQgbGV0IHB1YnN1YiA9IG5ldyBQdWJTdWIoe1xyXG4gICAgYnJvYWRjYXN0Q2hhbm5lbElkOiBXRUJfUFVCU1VCX0JST0FEQ0FTVF9DSEFOTkVMX0lEXHJcbn0pXHJcbmV4cG9ydCBsZXQgcHVibGlzaCA9IHB1YnN1Yi5wdWJsaXNoLmJpbmQocHVic3ViKVxyXG5leHBvcnQgbGV0IHN1YnNjcmliZSA9IHB1YnN1Yi5zdWJzY3JpYmUuYmluZChwdWJzdWIpXHJcbmV4cG9ydCBsZXQgdW5zdWJzY3JpYmUgPSBwdWJzdWIudW5zdWJzY3JpYmUuYmluZChwdWJzdWIpXHJcbmV4cG9ydCBsZXQgZXhlYyA9IHB1YnN1Yi5leGVjLmJpbmQocHVic3ViKVxyXG4iLCJleHBvcnQgY29uc3QgaXNFbXB0eSA9IChhKSA9PiAoYT09bnVsbCkgfHwgKGE9PT0nJykgfHwgKEFycmF5LmlzQXJyYXkoYSkgJiYgYS5sZW5ndGg9PT0wKVxyXG5cclxuZXhwb3J0IGNvbnN0IGlzU3RyaW5nID0gKGEpID0+ICh0eXBlb2YgYSA9PT0gJ3N0cmluZycpXHJcblxyXG5leHBvcnQgY29uc3QgaXNCb29sZWFuID0gKGEpID0+ICh0eXBlb2YgYSA9PT0gJ2Jvb2xlYW4nKVxyXG5cclxuZXhwb3J0IGNvbnN0IGlzRnVuY3Rpb24gPSAoYSkgPT4gKHR5cGVvZiBhID09PSAnZnVuY3Rpb24nKVxyXG5cclxuZXhwb3J0IGNvbnN0IGlzT2JqZWN0ID0gKGEpID0+IChhICE9PSBudWxsICYmIGEgaW5zdGFuY2VvZiBPYmplY3QgJiYgYS5jb25zdHJ1Y3RvciA9PT0gT2JqZWN0KVxyXG4iLCJleHBvcnQgbGV0IGZyb20gPSAodmFsKSA9PlxuXHQodmFsID09PSB1bmRlZmluZWQgfHwgdmFsPT09bnVsbCkgPyBbXSA6XG5cdEFycmF5LmlzQXJyYXkodmFsKSA/IHZhbCA6XG5cdFt2YWxdXG4iLCJpbXBvcnQgeyBpc0VtcHR5LCBpc09iamVjdCwgfSBmcm9tIFwiLi9pcy5qc1wiXHJcbmltcG9ydCAqIGFzIEFyciBmcm9tIFwiLi9hcnIuanNcIlxyXG5cclxuZXhwb3J0IGxldCBjbGVhbiA9IChvYmopID0+IHtcclxuICAgIGxldCB2ID0ge31cclxuICAgIGZvciAobGV0IGsgaW4gb2JqKSB7XHJcbiAgICAgICAgbGV0IGEgPSBvYmpba11cclxuICAgICAgICBpZiAoaXNFbXB0eShhKSkgY29udGludWVcclxuICAgICAgICB2W2tdID0gYVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHZcclxufVxyXG5cclxuZXhwb3J0IGxldCBzZXQgPSAocm9vdCwgcGF0aCwgdmFsdWUpID0+IHtcclxuXHJcbiAgICBsZXQga2V5cyA9IHBhdGguc3BsaXQoJy4nKVxyXG4gICAgbGV0IGxhc3RLZXkgPSBrZXlzLnBvcCgpXHJcblxyXG4gICAgdmFyIHIgPSByb290IHx8IHt9XHJcbiAgICBrZXlzLmZvckVhY2goayA9PiB7XHJcbiAgICAgICAgaWYgKCFyLmhhc093blByb3BlcnR5KGspKSByW2tdID0ge31cclxuICAgICAgICByID0gcltrXVxyXG4gICAgfSlcclxuXHJcbiAgICByW2xhc3RLZXldID0gdmFsdWVcclxuXHJcbiAgICByZXR1cm4gcm9vdFxyXG59XHJcblxyXG5leHBvcnQgbGV0IGdldCA9IChyb290LCBwYXRoLCBkZWZhdWx0VmFsdWUpID0+IHtcclxuICAgIGxldCBrZXlzID0gcGF0aC5zcGxpdCgnLicpXHJcbiAgICBsZXQgciA9IHJvb3QgfHwge31cclxuICAgIGZvciAobGV0IGsgb2Yga2V5cykge1xyXG4gICAgICAgIGlmICghci5oYXNPd25Qcm9wZXJ0eShrKSkgcmV0dXJuIGRlZmF1bHRWYWx1ZVxyXG4gICAgICAgIHIgPSByW2tdXHJcbiAgICB9XHJcbiAgICByZXR1cm4gclxyXG59XHJcblxyXG5leHBvcnQgbGV0IHRyaW0gPSAocm9vdCwgcGF0aCkgPT4ge1xyXG4gICAgbGV0IGtleXMgPSBwYXRoLnNwbGl0KCcuJylcclxuICAgIGxldCBsYXN0S2V5ID0ga2V5cy5wb3AoKVxyXG5cclxuICAgIHZhciByID0gcm9vdCB8fCB7fVxyXG4gICAgZm9yIChsZXQgayBvZiBrZXlzKSB7XHJcbiAgICAgICAgaWYgKCFyLmhhc093blByb3BlcnR5KGspKSByZXR1cm4gZmFsc2VcclxuICAgICAgICByID0gcltrXVxyXG4gICAgfVxyXG5cclxuICAgIHJldHVybiBkZWxldGUgcltsYXN0S2V5XVxyXG59XHJcblxyXG5leHBvcnQgbGV0IHBhcnNlID0gKHN0ciwgZGVmYXVsdFZhbHVlKSA9PiB7XHJcbiAgICB0cnkge1xyXG4gICAgICAgIHJldHVybiBKU09OLnBhcnNlKHN0cilcclxuICAgIH0gY2F0Y2goeCkge1xyXG4gICAgICAgIHJldHVybiBkZWZhdWx0VmFsdWVcclxuICAgIH1cclxufVxyXG5cclxuZXhwb3J0IGxldCBtZXJnZSA9IChvYmosLi4uYnMpID0+IHtcclxuICAgIEFycmF5LmZyb20oYnMpLmZpbHRlcihCb29sZWFuKS5mb3JFYWNoKChiKSA9PiB7XHJcblxyXG4gICAgICAgIGZvciAobGV0IFtrLHZdIG9mIE9iamVjdC5lbnRyaWVzKGIpKSB7XHJcbiAgICAgICAgICAgIGxldCBhID0gb2JqW2tdXHJcblxyXG4gICAgICAgICAgICAvLyBtZXJnZSBvYmplY3RcclxuICAgICAgICAgICAgaWYgKGlzT2JqZWN0KGEpICYmIGlzT2JqZWN0KHYpKSB7XHJcbiAgICAgICAgICAgICAgICBvYmpba10gPSB7Li4uYSwgLi4udn1cclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgLy8gbWVyZ2UgYXJyYXlcclxuICAgICAgICAgICAgZWxzZSBpZiAoQXJyYXkuaXNBcnJheShhKSkge1xyXG4gICAgICAgICAgICAgICAgb2JqW2tdID0gW1xyXG4gICAgICAgICAgICAgICAgICAgIC4uLmEsXHJcbiAgICAgICAgICAgICAgICAgICAgLi4uKEFyci5mcm9tKHYpKVxyXG4gICAgICAgICAgICAgICAgXVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyByZXBsYWNlbWVudFxyXG4gICAgICAgICAgICBlbHNlIHtcclxuICAgICAgICAgICAgICAgIG9ialtrXSA9IHZcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH0pXHJcbiAgICByZXR1cm4gb2JqXHJcbn0iLCJpbXBvcnQgeyBpc0Z1bmN0aW9uIH0gZnJvbSBcIi4vaXMuanNcIlxuZXhwb3J0IGxldCBmcm9tID0gKGEpID0+IGlzRnVuY3Rpb24oYSkgPyBhIDogKCAoKSA9PiBhKSIsImltcG9ydCAqIGFzIE9iaiBmcm9tICcuL29iai5qcydcclxuXHJcbmV4cG9ydCB7IE9iaiB9XHJcblxyXG5leHBvcnQgKiBhcyBJcyBmcm9tICcuL2lzLmpzJ1xyXG5leHBvcnQgKiBhcyBBcnIgZnJvbSAnLi9hcnIuanMnXHJcbmV4cG9ydCAqIGFzIEZuIGZyb20gJy4vZm4uanMnXHJcblxyXG5leHBvcnQgY2xhc3MgU3RvcmUge1xyXG4gICAgY29uc3RydWN0b3IoXHJcbiAgICAgICAgaWQsXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgICBpbml0aWFsID0ge30sXHJcbiAgICAgICAgICAgIHN0b3JlID0gZ2xvYmFsVGhpcy5zZXNzaW9uU3RvcmFnZSxcclxuICAgICAgICB9ID0ge31cclxuICAgICkge1xyXG4gICAgICAgIGlmICghaWQpIHRocm93IG5ldyBFcnJvcignc3RvcmUgaWQgcmVxdWlyZWQnKVxyXG4gICAgICAgIHRoaXMuaWQgPSBpZFxyXG4gICAgICAgIHRoaXMudmFsdWUgPSBpbml0aWFsXHJcbiAgICAgICAgdGhpcy5zdG9yZSA9IHN0b3JlXHJcbiAgICB9XHJcblxyXG4gICAgc2V0KHBhdGgsIHZhbHVlcykge1xyXG4gICAgICAgIHRoaXMudmFsdWUgPSBPYmouc2V0KHRoaXMudmFsdWUgfHwge30sIHBhdGgsIHZhbHVlcylcclxuICAgICAgICB0aGlzLnNhdmUoKVxyXG4gICAgICAgIHJldHVybiB0aGlzXHJcbiAgICB9XHJcblxyXG4gICAgZ2V0KHBhdGgsIGRlZmF1bHRWYWx1ZSkge1xyXG4gICAgICAgIHJldHVybiAodGhpcy52YWx1ZSAmJiBwYXRoKVxyXG4gICAgICAgICAgICA/IE9iai5nZXQodGhpcy52YWx1ZSwgcGF0aCwgZGVmYXVsdFZhbHVlKVxyXG4gICAgICAgICAgICA6IHRoaXMudmFsdWVcclxuICAgIH1cclxuXHJcbiAgICB0cmltKHBhdGgpIHtcclxuICAgICAgICBpZiAocGF0aCkge1xyXG4gICAgICAgICAgICBPYmoudHJpbSh0aGlzLnZhbHVlLCBwYXRoKVxyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIHRoaXMudmFsdWUgPSB7fVxyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdGhpc1xyXG4gICAgfVxyXG5cclxuICAgIC8vIGxvY2FsIHN0b3JhZ2VcclxuICAgIC8vXHJcbiAgICBzYXZlKCkge1xyXG4gICAgICAgIHRoaXMuc3RvcmUuc2V0SXRlbSh0aGlzLmlkLCBKU09OLnN0cmluZ2lmeSh0aGlzLnZhbHVlKSlcclxuICAgICAgICByZXR1cm4gdGhpc1xyXG4gICAgfVxyXG5cclxuICAgIGxvYWQoKSB7XHJcbiAgICAgICAgbGV0IHMgPSB0aGlzLnN0b3JlLmdldEl0ZW0odGhpcy5pZClcclxuICAgICAgICB0aGlzLnZhbHVlID0gT2JqLnBhcnNlKHMpIHx8IHt9XHJcbiAgICAgICAgcmV0dXJuIHRoaXNcclxuICAgIH1cclxuXHJcbiAgICByZXNldCgpIHtcclxuICAgICAgICB0aGlzLnZhbHVlID0ge31cclxuICAgICAgICB0aGlzLnN0b3JlLnJlbW92ZUl0ZW0odGhpcy5pZClcclxuICAgICAgICByZXR1cm4gdGhpc1xyXG4gICAgfVxyXG59XHJcblxyXG4vLyB2YXIgc3RvcmUgPSBuZXcgU3RvcmUoJ3dlYicpXHJcbi8vIHN0b3JlLmxvYWQoKVxyXG4vLyBnbG9iYWxUaGlzLmFkZEV2ZW50TGlzdGVuZXIoJ2JlZm9yZXVubG9hZCcsICgpID0+IHN0b3JlLnNhdmUoKSkiLCIvLyB3cmFwcyBmdW5jdGlvbi9vYmplY3Qvc3RyaW5nL3dvcmtlclxuLy9cbmV4cG9ydCBsZXQgd3JhcCA9ICh3KSA9PiB7XG4gICAgaWYgKHcgaW5zdGFuY2VvZiBXb3JrZXIpIHtcbiAgICAgICAgcmV0dXJuIHdyYXBfd29ya2VyKHcpXG4gICAgfVxuXG4gICAgbGV0IHNyY1xuICAgIGlmICh0eXBlb2Yodyk9PT0nZnVuY3Rpb24nKSB7XG4gICAgICAgIHNyYyA9IGAoJHtwcm94eX0pKCR7d30pYFxuICAgIH1cbiAgICBlbHNlIGlmICh3IGluc3RhbmNlb2YgT2JqZWN0ICYmIHcuY29uc3RydWN0b3I9PT1PYmplY3QpIHtcbiAgICAgICAgc3JjID0gYCgke3Byb3h5fSkoJHt0b1NyYyh3KX0pYFxuICAgIH1cbiAgICBlbHNlIGlmICh0eXBlb2Yodyk9PT0nc3RyaW5nJykge1xuICAgICAgICBzcmMgPSB3XG4gICAgfVxuICAgIGlmICghc3JjKSB0aHJvdyBuZXcgRXJyb3IoJ3Vuc3VwcG9ydGVkIHR5cGUnKVxuXG4gICAgbGV0IGIgPSBuZXcgQmxvYiggW3NyY10sXG4gICAgICAgIHsgdHlwZTogJ3RleHQvamF2YXNjcmlwdCcgfSlcbiAgICBsZXQgdSA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYilcbiAgICBsZXQgYSA9IG5ldyBXb3JrZXIodSxcbiAgICAgICAgXCJEZW5vXCIgaW4gZ2xvYmFsVGhpc1xuICAgICAgICA/IHt0eXBlOidtb2R1bGUnfVxuICAgICAgICA6IHt9KVxuXG4gICAgcmV0dXJuIHdyYXBfd29ya2VyKGEpXG59XG5cbi8vIG9iamVjdCAtPiBzb3VyY2Utc3RyaW5nXG4vL1xubGV0IHRvU3JjID0gKG9iaikgPT4ge1xuICAgIHJldHVybiBgeyAke1xuICAgICAgICBPYmplY3QuZW50cmllcyhvYmopXG4gICAgICAgIC5tYXAoIChba2V5LCB2YWxdKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gYCR7a2V5fToke1xuICAgICAgICAgICAgICAgIHR5cGVvZih2YWwpPT09J2Z1bmN0aW9uJ1xuICAgICAgICAgICAgICAgID8gdmFsKycnXG4gICAgICAgICAgICAgICAgOiBKU09OLnN0cmluZ2lmeSh2YWwpXG4gICAgICAgICAgICB9YFxuICAgICAgICB9KVxuICAgICAgICAuam9pbignLCcpXG4gICAgfSB9YFxufVxuXG4vLyB3cmFwcyBhIHdvcmtlclxuLy9cbmV4cG9ydCBsZXQgd3JhcF93b3JrZXIgPSAodykgPT4ge1xuICAgIGxldCBfaWQgPSAwXG4gICAgbGV0IF9jYiA9IHt9XG5cbiAgICBsZXQgZm4gPSAoLi4uYXJncykgPT4gbmV3IFByb21pc2UoKG9rLCBlcnIpID0+IHtcbiAgICAgICAgbGV0IGlkID0gKytfaWRcbiAgICAgICAgdy5wb3N0TWVzc2FnZSh7aWQsIGFyZ3N9KVxuICAgICAgICBfY2JbaWRdID0ge29rLCBlcnJ9XG4gICAgfSlcblxuICAgIHcub25tZXNzYWdlID0gKGUpID0+IHtcbiAgICAgICAgaWYgKCFlKSByZXR1cm5cbiAgICAgICAgbGV0IHsgaWQsIGRhdGEsIGVycm9yIH0gPSBlLmRhdGEgfHwge31cbiAgICAgICAgaWYgKCFpZCkgcmV0dXJuXG5cbiAgICAgICAgbGV0IGNiID0gX2NiW2lkXVxuICAgICAgICBpZiAoIWNiKSByZXR1cm5cbiAgICAgICAgZGVsZXRlIF9jYltpZF1cblxuICAgICAgICBsZXQgeyBvaywgZXJyIH0gPSBjYlxuICAgICAgICByZXR1cm4gZXJyb3JcbiAgICAgICAgICAgID8gZXJyKGVycm9yKVxuICAgICAgICAgICAgOiBvayhkYXRhKVxuICAgIH1cblxuICAgIHJldHVybiBuZXcgUHJveHkoZm4sIHtcbiAgICAgICAgZ2V0KF8sIHByb3ApIHtcbiAgICAgICAgICAgIGlmIChwcm9wID09PSAnX193b3JrZXInKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHdcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuICguLi5hcmdzKSA9PiBuZXcgUHJvbWlzZSgob2ssIGVycikgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpZCA9ICsrX2lkXG4gICAgICAgICAgICAgICAgdy5wb3N0TWVzc2FnZSh7aWQsIGZuOnByb3AsIGFyZ3N9KVxuICAgICAgICAgICAgICAgIF9jYltpZF0gPSB7b2ssIGVycn1cbiAgICAgICAgICAgIH0pXG4gICAgICAgIH1cbiAgICB9KVxufVxuXG5cbi8vIHByb3h5IHdvcmtlciBmdW5jdGlvbi9vYmplY3Rcbi8vXG5leHBvcnQgbGV0IHByb3h5ID0gKGFyZywgc2NvcGU9bnVsbCkgID0+IHtcbiAgICBsZXQgRm4gPSB7fVxuICAgIGlmICgodHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJykpIHtcbiAgICAgICAgRm4uXyA9IGFyZ1xuICAgIH1cbiAgICBlbHNlIGlmIChcbiAgICAgICAgYXJnICE9PSBudWxsXG4gICAgICAgICYmIGFyZyBpbnN0YW5jZW9mIE9iamVjdFxuICAgICAgICAmJiBhcmcuY29uc3RydWN0b3IgPT09IE9iamVjdFxuICAgICkge1xuICAgICAgICBGbiA9IGFyZ1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdwbGVhc2UgcGFzcyBmdW5jdGlvbi9vYmplY3QnKVxuICAgIH1cblxuICAgIGdsb2JhbFRoaXMub25tZXNzYWdlID0gZnVuY3Rpb24oZSkge1xuICAgICAgICBpZiAoIWUpIHJldHVyblxuICAgICAgICBsZXQgeyBpZCwgZm49J18nLCBhcmdzIH0gPSBlLmRhdGEgfHwge31cblxuICAgICAgICB7KGFzeW5jICgpPT4ge1xuICAgICAgICAgICAgdmFyIHAgPSB7IGlkIH1cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgaWYgKCFGbi5oYXNPd25Qcm9wZXJ0eShmbikpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd1bmRlZmluZWQgcHJvcGVydHknKVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBmID0gRm5bZm5dXG4gICAgICAgICAgICAgICAgbGV0IGlzRm4gPSB0eXBlb2YgZiA9PT0gJ2Z1bmN0aW9uJ1xuICAgICAgICAgICAgICAgIHAuZGF0YSA9IGlzRm5cbiAgICAgICAgICAgICAgICAgICAgPyBhd2FpdCAoZi5hcHBseShzY29wZSB8fCBGbiwgYXJncykpXG4gICAgICAgICAgICAgICAgICAgIDogZlxuXG4gICAgICAgICAgICAgICAgaWYgKCFpc0ZuICYmIGFyZ3MubGVuZ3RoPjApIHtcbiAgICAgICAgICAgICAgICAgICAgRm5bZm5dID0gYXJnc1swXVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgfSBjYXRjaChlKSB7XG4gICAgICAgICAgICAgICAgcC5lcnJvciA9IGVcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGdsb2JhbFRoaXMucG9zdE1lc3NhZ2UocClcbiAgICAgICAgfSkoKX1cbiAgICB9XG59XG4iLCIvLyBkZW5vIGNhY2hlIC1yIG1vZC5qc1xyXG4vLyBkZW5vIHJ1biAtQSBidWlsZC5qc1xyXG5cclxuLy8gd3JhcHMgZmV0Y2hcclxuLy9cclxuZXhwb3J0IHtcclxuICAgIGFqYXgsXHJcbiAgICBhamF4RGVmYXVsdHMsXHJcbiAgICBhamF4Rm4sXHJcbn0gZnJvbSAnaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvYWpheC5qcy9tYWluL21vZC5qcydcclxuXHJcblxyXG4vLyBmb3IgY3JlYXRpbmcgd2ViLWNvbXBvbmVudFxyXG4vL1xyXG5leHBvcnQge1xyXG4gICAgY3VzdG9tRWxlbWVudCxcclxuICAgIGN1c3RvbUVsZW1lbnREZWZhdWx0cyxcclxuICAgIHRtcGwsXHJcbiAgICB3aXJlRWxlbWVudCxcclxufSBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9jdXN0b20tZWxlbWVudC5qcy9tYWluL21vZC5qcydcclxuXHJcbmV4cG9ydCB7XHJcbiAgICB3aXJlLFxyXG59IGZyb20gJ2h0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3dpcmUuanMvbWFpbi9tb2QuanMnXHJcblxyXG5cclxuLy8gcHVibGlzaC1zdWJzY3JpYmUgdXNpbmcgYnJvYWRjYXN0IGNoYW5uZWxcclxuLy9cclxuZXhwb3J0IHtcclxuICAgIFB1YlN1YixcclxufSBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9wdWJzdWIuanMvbWFpbi9tb2QuanMnXHJcblxyXG5cclxuLy8gY2FjaGUgdG8gbG9jYWwtc3RvcmFnZVxyXG4vL1xyXG5leHBvcnQge1xyXG4gICAgU3RvcmUsXHJcbiAgICAvLyB1dGlsaXR5IGZ1bmN0aW9uc1xyXG4gICAgQXJyLFxyXG4gICAgSXMsXHJcbiAgICBPYmosXHJcbiAgICBGbixcclxufSBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9zdG9yZS5qcy9tYWluL21vZC5qcydcclxuXHJcblxyXG4vLyBXYWFmLndyYXAgb2JqZWN0L3N0cmluZy9mdW5jdGlvbi93b3JrZXIgYXMgd2ViLXdvcmtlclxyXG4vLyBXYWFmLnByb3h5IGZvciBwcm94eSB0byBjb21tdW5pY2F0ZSB3aXRoIHdyYXBwZWQgd2ViLXdvcmtlclxyXG4vL1xyXG5leHBvcnQgKiBhcyBXYWFmXHJcbiAgICBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS93YWFmLmpzL21haW4vbW9k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
