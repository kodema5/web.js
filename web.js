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
            this.wiresConfig = typeof _wires === 'function' ? _wires : ()=>_wires;
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
            this.wires_ = wire(r, this.wiresConfig.call(this.context_, this), {
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
        this.wiresConfig = typeof _wires === 'function' ? _wires : ()=>_wires;
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
        this.wires_ = wire(r, this.wiresConfig.call(this.context_, this), {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L2FqYXguanMvbWFpbi9zcmMvaW5kZXguanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9tZW1vLWZ1bmN0aW9uLmpzL21haW4vc3JjL21lbW8uanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS90bXBsLmpzL21haW4vc3JjL3RtcGwuanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS93aXJlLmpzL21haW4vc3JjL3dpcmUuanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9jdXN0b20tZWxlbWVudC5qcy9tYWluL3NyYy9jdXN0b20tZWxlbWVudC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L2N1c3RvbS1lbGVtZW50LmpzL21haW4vc3JjL3dpcmUtZWxlbWVudC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3B1YnN1Yi5qcy9tYWluL3NyYy9pbmRleC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3N0b3JlLmpzL21haW4vc3JjL2lzLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvYXJyLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvb2JqLmpzIiwiaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvc3RvcmUuanMvbWFpbi9zcmMvZm4uanMiLCJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9zdG9yZS5qcy9tYWluL3NyYy9pbmRleC5qcyIsImh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3dhYWYuanMvbWFpbi9zcmMvaW5kZXguanMiLCJmaWxlOi8vL0M6L3RtcC9zcmMva29kZW1hNS93ZWIuanMvbW9kLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIlxyXG5sZXQgcHJvY2Vzc0JvZHkgPSAoZGF0YSwgdHlwZSkgPT4ge1xyXG4gICAgc3dpdGNoKHR5cGUpIHtcclxuICAgICAgICBjYXNlIFwiYW55XCI6IHJldHVybiBkYXRhXHJcbiAgICAgICAgY2FzZSBcInRleHRcIjogcmV0dXJuIGRhdGEgPyBkYXRhLnRvU3RyaW5nKCkgOiBkYXRhXHJcbiAgICAgICAgY2FzZSBcImpzb25cIjogcmV0dXJuIEpTT04uc3RyaW5naWZ5KGRhdGEpXHJcbiAgICB9XHJcblxyXG4gICAgdGhyb3cgbmV3IEVycm9yKCd1bmtub3duIHJlcXVlc3QgZGF0YSB0eXBlJylcclxufVxyXG5cclxubGV0IHByb2Nlc3NSZXNwb25zZSA9IChyZXMsIHR5cGUpID0+IHtcclxuICAgIHN3aXRjaCh0eXBlKSB7XHJcbiAgICAgICAgY2FzZSAnYXJyYXlCdWZmZXInOiByZXR1cm4gcmVzLmFycmF5QnVmZmVyKClcclxuICAgICAgICBjYXNlICdibG9iJzogcmV0dXJuIHJlcy5ibG9iKClcclxuICAgICAgICBjYXNlICdmb3JtRGF0YSc6IHJldHVybiByZXMuZm9ybURhdGEoKVxyXG4gICAgICAgIGNhc2UgJ2pzb24nOiByZXR1cm4gcmVzLmpzb24oKVxyXG4gICAgICAgIGNhc2UgJ3RleHQnOiByZXR1cm4gcmVzLnRleHQoKVxyXG4gICAgfVxyXG5cclxuICAgIHRocm93IG5ldyBFcnJvcigndW5rbm93biByZXNwb25zZSB0eXBlJylcclxufVxyXG5cclxuZXhwb3J0IGxldCBhamF4RGVmYXVsdHMgPSB7XHJcbiAgICBiYXNlSHJlZjonJyxcclxuICAgIHRpbWVvdXQ6IDAsXHJcblxyXG4gICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xyXG4gICAgfSxcclxuXHJcbiAgICByZXF1ZXN0VHlwZTogJ2pzb24nLCAvLyBqc29uLCB0ZXh0LCBhbnlcclxuICAgIHJlc3BvbnNlVHlwZTogJ2pzb24nLCAvLyBhcnJheUJ1ZmZlciwgYmxvYiwgZm9ybURhdGEsIGpzb24sIHRleHQsXHJcbn1cclxuXHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYWpheCAoe1xyXG4gICAgdXJsLFxyXG4gICAgZGF0YSxcclxuICAgIGJvZHksIC8vIGZvciBGb3JtRGF0YSwgVVJMU2VhcmNoUGFyYW1zLCBzdHJpbmcsIGV0Y1xyXG5cclxuICAgIC8vIHRyYW5zZm9ybWVyL3ZhbGlkYXRvclxyXG4gICAgaW5wdXQgPSAoYSkgPT4gYSxcclxuICAgIG91dHB1dCA9IChhKSA9PiBhLFxyXG5cclxuICAgIGJhc2VIcmVmID0gYWpheERlZmF1bHRzLmJhc2VIcmVmLFxyXG4gICAgbWV0aG9kID0gYWpheERlZmF1bHRzLm1ldGhvZCxcclxuICAgIGhlYWRlcnMgPSBhamF4RGVmYXVsdHMuaGVhZGVycyxcclxuICAgIHRpbWVvdXQgPSBhamF4RGVmYXVsdHMudGltZW91dCxcclxuICAgIHJlcXVlc3RUeXBlID0gYWpheERlZmF1bHRzLnJlcXVlc3RUeXBlLFxyXG4gICAgcmVzcG9uc2VUeXBlID0gYWpheERlZmF1bHRzLnJlc3BvbnNlVHlwZSxcclxufSA9IHt9KSB7XHJcblxyXG4gICAgaWYgKCF1cmwpIHRocm93IG5ldyBFcnJvcigndXJsIHJlcXVpcmVkJylcclxuXHJcbiAgICB1cmwgPSB1cmwuaW5kZXhPZignaHR0cCcpIDwgMCAmJiBiYXNlSHJlZlxyXG4gICAgICAgID8gYmFzZUhyZWYgKyB1cmxcclxuICAgICAgICA6IHVybFxyXG5cclxuICAgIGRhdGEgPSBpbnB1dChkYXRhKVxyXG5cclxuICAgIGxldCBvcHQgPSB7XHJcbiAgICAgICAgbWV0aG9kLFxyXG4gICAgICAgIGhlYWRlcnM6IHtcclxuICAgICAgICAgICAgLi4uKGhlYWRlcnMpXHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGxldCBoYXNCb2R5ID0gIShtZXRob2Q9PT0nR0VUJyB8fCBtZXRob2Q9PT0nSEVBRCcpXHJcbiAgICBpZiAoaGFzQm9keSkge1xyXG4gICAgICAgIG9wdC5ib2R5ID0gYm9keSB8fCBwcm9jZXNzQm9keShkYXRhLCByZXF1ZXN0VHlwZSlcclxuICAgIH1cclxuXHJcbiAgICBsZXQgQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKClcclxuICAgIG9wdC5zaWduYWwgPSBBYm9ydC5zaWduYWxcclxuXHJcbiAgICBsZXQgcCA9IG5ldyBQcm9taXNlKGFzeW5jIChvaywgZXJyKSA9PiB7XHJcbiAgICAgICAgbGV0IHRJZFxyXG4gICAgICAgIGlmICh0aW1lb3V0KSB7XHJcbiAgICAgICAgICAgIHRJZCA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgQWJvcnQuYWJvcnQoKVxyXG4gICAgICAgICAgICB9LCB0aW1lb3V0KVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgb3B0LnNpZ25hbC5vbmFib3J0ID0gKCkgPT4ge1xyXG4gICAgICAgICAgICBlcnIobmV3IEVycm9yKCdhYm9ydGVkJykpXHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBsZXQgcmVzID0gYXdhaXQgZmV0Y2godXJsLCBvcHQpXHJcblxyXG4gICAgICAgICAgICBpZiAodElkKSBjbGVhclRpbWVvdXQodElkKVxyXG5cclxuICAgICAgICAgICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgICAgICAgICAgIGF3YWl0IHJlcy5ib2R5LmNhbmNlbCgpXHJcbiAgICAgICAgICAgICAgICB0aHJvdyB7XHJcbiAgICAgICAgICAgICAgICAgICAgW3Jlcy5zdGF0dXNdOiByZXMuc3RhdHVzVGV4dFxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBsZXQgYm9keSA9IGF3YWl0IHByb2Nlc3NSZXNwb25zZShyZXMsIHJlc3BvbnNlVHlwZSlcclxuXHJcbiAgICAgICAgICAgIG9rKGF3YWl0IG91dHB1dChib2R5KSlcclxuICAgICAgICB9XHJcbiAgICAgICAgY2F0Y2goZSkge1xyXG4gICAgICAgICAgICBlcnIoZSlcclxuICAgICAgICB9XHJcbiAgICB9KVxyXG5cclxuICAgIHAuYWJvcnQgPSAoKSA9PiBBYm9ydC5hYm9ydCgpXHJcblxyXG4gICAgcmV0dXJuIHBcclxufVxyXG5cclxuLy8gd3JhcHMgYWpheC1jYWxsIGFzIGEgZnVuY3Rpb25cclxuLy9cclxuY29uc3QgaXNPYmplY3QgPSAoYSkgPT4gKGEgIT09IG51bGwgJiYgYSBpbnN0YW5jZW9mIE9iamVjdCAmJiBhLmNvbnN0cnVjdG9yID09PSBPYmplY3QpXHJcblxyXG5leHBvcnQgY29uc3QgYWpheEZuID0gKGNmZykgPT4gYXN5bmMgKGRhdGEpID0+IHtcclxuICAgIGxldCBhID0gYXdhaXQgYWpheCh7XHJcbiAgICAgICAgLi4uKGNmZyksXHJcbiAgICAgICAgZGF0YToge1xyXG4gICAgICAgICAgICAuLi4oY2ZnLmRhdGEgfHwge30pLFxyXG4gICAgICAgICAgICAuLi4oZGF0YSlcclxuICAgICAgICB9XHJcbiAgICB9KVxyXG5cclxuICAgIC8vIHByb2Nlc3MgZGF0YS9lcnJvcnMsXHJcbiAgICAvLyBib3Jyb3dlZCBmcm9tIGdyYXBoUUxcclxuICAgIC8vXHJcbiAgICBpZiAoaXNPYmplY3QoYSkpIHtcclxuICAgICAgICBsZXQgeyBkYXRhOmQsIGVycm9ycyB9ID0gYVxyXG4gICAgICAgIGlmIChCb29sZWFuKGQpIF4gQm9vbGVhbihlcnJvcnMpKSB7XHJcbiAgICAgICAgICAgIGlmIChlcnJvcnMpIHRocm93IGVycm9yc1xyXG4gICAgICAgICAgICByZXR1cm4gZFxyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICByZXR1cm4gYVxyXG59XHJcbiIsIlxuLy8gcmVmOiBodHRwczovL3N0YWNrb3ZlcmZsb3cuY29tL3F1ZXN0aW9ucy8xMDA3OTgxL2hvdy10by1nZXQtZnVuY3Rpb24tcGFyYW1ldGVyLW5hbWVzLXZhbHVlcy1keW5hbWljYWxseVxuLy9cbmxldCBTVFJJUF9DT01NRU5UUyA9IC8oXFwvXFwvLiokKXwoXFwvXFwqW1xcc1xcU10qP1xcKlxcLyl8KFxccyo9W14sXFwpXSooKCcoPzpcXFxcJ3xbXidcXHJcXG5dKSonKXwoXCIoPzpcXFxcXCJ8W15cIlxcclxcbl0pKlwiKSl8KFxccyo9W14sXFwpXSopKS9tZztcbmxldCBBUkdVTUVOVF9OQU1FUyA9IC8oW15cXHMsXSspL2c7XG5mdW5jdGlvbiBnZXRBcmdOYW1lcyhmdW5jKSB7XG4gICAgaWYgKHR5cGVvZihmdW5jKSE9PVwiZnVuY3Rpb25cIikgcmV0dXJuIFtdXG5cbiAgICBsZXQgZm5TdHIgPSBmdW5jXG4gICAgICAgIC50b1N0cmluZygpXG4gICAgICAgIC5yZXBsYWNlKFNUUklQX0NPTU1FTlRTLCAnJylcbiAgICBsZXQgYXJyID0gZm5TdHJcbiAgICAgICAgLnNsaWNlKGZuU3RyLmluZGV4T2YoJygnKSsxLCBmblN0ci5pbmRleE9mKCcpJykpXG4gICAgICAgIC5tYXRjaChBUkdVTUVOVF9OQU1FUyk7XG4gICAgcmV0dXJuIGFyciA/PyBbXVxufVxuXG4vLyBxdWVyeSBvYmplY3QgZm9yIHBhdGhcbi8vXG5sZXQgcXVlcnlBcmcgPSAob2JqLCBwYXRoKSA9PiB7XG4gICAgaWYgKCFvYmogfHwgdHlwZW9mIG9iaiAhPT0gJ29iamVjdCcpIHJldHVyblxuXG4gICAgbGV0IG4gPSBwYXRoLmxlbmd0aFxuICAgIGlmIChuPT09MCkgcmV0dXJuXG5cbiAgICB2YXIgY3VyID0gb2JqXG4gICAgdmFyIHZhbCA9IHVuZGVmaW5lZFxuICAgIGZvciAobGV0IG4gb2YgcGF0aCkge1xuICAgICAgICBpZiAoIWN1ci5oYXNPd25Qcm9wZXJ0eShuKSkge1xuICAgICAgICAgICAgdmFsID0gdW5kZWZpbmVkXG4gICAgICAgICAgICBicmVha1xuICAgICAgICB9XG4gICAgICAgIHZhbCA9IGN1ciA9IGN1cltuXVxuICAgIH1cbiAgICByZXR1cm4gdmFsXG59XG5cbi8vIHF1ZXJ5IGZvciBlYWNoIG5hbWVzXG4vL1xubGV0IHF1ZXJ5QXJncyA9IChcbiAgICBjdHgsXG4gICAgbmFtZXMsXG4gICAgZGVsaW1pdGVyPSckJywgLy8gdmFsaWQgdmFyLW5hbWVzIGlzIFthLXpBLVowLTlfJF1cbikgPT4ge1xuICAgIHJldHVybiBBcnJheVxuICAgICAgICAuZnJvbShuYW1lcylcbiAgICAgICAgLm1hcChuID0+IG4uc3BsaXQoZGVsaW1pdGVyKS5maWx0ZXIoQm9vbGVhbikpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgLm1hcChucyA9PiBxdWVyeUFyZyhjdHgsIG5zKSlcbn1cblxuXG4vLyBjaGVjayBpZiBzYW1lXG4vL1xubGV0IGVxdWFsQXJncyA9IChhcmdzMSwgYXJnczIpID0+IHtcblxuICAgIGlmIChhcmdzMS5sZW5ndGghPT1hcmdzMi5sZW5ndGgpIHJldHVybiBmYWxzZVxuXG4gICAgcmV0dXJuIGFyZ3MxLmV2ZXJ5KChhLCBpKSA9PiB7XG4gICAgICAgIGxldCBiID0gYXJnczJbaV1cbiAgICAgICAgcmV0dXJuIHR5cGVvZihhKSA9PSAnb2JqZWN0J1xuICAgICAgICAgICAgPyBhID09IGIgLy8gY2hlY2sgcG9pbnRlciBvbmx5XG4gICAgICAgICAgICA6IGEgPT09IGJcbiAgICB9KVxufVxuXG5cbi8vIGNhY2hlcyBsYXN0IG91dHB1dFxuLy9cbmV4cG9ydCBjbGFzcyBNZW1vRnVuY3Rpb24ge1xuXG4gICAgY29uc3RydWN0b3IoZnVuYykge1xuICAgICAgICB0aGlzLmZ1bmMgPSBmdW5jXG4gICAgICAgIHRoaXMuYXJnTmFtZXMgPSBnZXRBcmdOYW1lcyhmdW5jKVxuICAgIH1cblxuICAgIGNhbGwodGhpc0FyZykge1xuXG4gICAgICAgIGlmICh0aGlzLmFyZ05hbWVzLmxlbmd0aD09PTApIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmZ1bmMuY2FsbCh0aGlzQXJnKVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGFyZ3VtZW50cy5sZW5ndGg9PT0wKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jdXJPdXRwdXRcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLmFwcGx5KFxuICAgICAgICAgICAgdGhpc0FyZyxcbiAgICAgICAgICAgIHF1ZXJ5QXJncyh0aGlzQXJnLCB0aGlzLmFyZ05hbWVzKSlcbiAgICB9XG5cbiAgICBhcHBseSh0aGlzQXJnLCBhcmdzKSB7XG5cbiAgICAgICAgbGV0IGYgPSAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMClcbiAgICAgICAgICAgIHx8IChcbiAgICAgICAgICAgICAgICB0aGlzLmN1ckFyZ3NcbiAgICAgICAgICAgICAgICAmJiBlcXVhbEFyZ3MoYXJncywgdGhpcy5jdXJBcmdzKVxuICAgICAgICAgICAgKVxuICAgICAgICBpZiAoZikgcmV0dXJuIHRoaXMuY3VyT3V0cHV0XG5cblxuICAgICAgICB0aGlzLmN1ckFyZ3MgPSBhcmdzXG4gICAgICAgIHRoaXMuY3VyT3V0cHV0ID0gdGhpcy5mdW5jLmFwcGx5KHRoaXNBcmcsIGFyZ3MpXG4gICAgICAgIHJldHVybiB0aGlzLmN1ck91dHB1dFxuICAgIH1cbn0iLCJpbXBvcnQgeyBNZW1vRnVuY3Rpb24gfSBmcm9tICcuL2RlcHMuanMnXG5cbi8vIHJlZnJlc2hhYmxlIHN0cmluZyB0ZW1wbGF0ZSB3aXRoIG1lbW9pemVkIGZ1bmN0aW9uc1xuLy9cbmxldCBUbXBsID0gY2xhc3Mge1xuICAgIGNvbnN0cnVjdG9yKHN0cmluZ3MsIGZ1bmNzKSB7XG4gICAgICAgIHRoaXMuc3RyaW5ncyA9IHN0cmluZ3NcbiAgICAgICAgdGhpcy5mdW5jdGlvbnMgPSBmdW5jc1xuICAgICAgICAgICAgLm1hcChmID0+IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHlwZW9mKGYpID09PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgICAgID8gbmV3IE1lbW9GdW5jdGlvbihmKVxuICAgICAgICAgICAgICAgICAgICA6ICgoKSA9PiBmKVxuICAgICAgICAgICAgfSlcbiAgICB9XG5cblxuICAgIGJ1aWxkKGNvbnRleHQpIHtcbiAgICAgICAgbGV0IG4gPSBhcmd1bWVudHMubGVuZ3RoXG4gICAgICAgIHJldHVybiB0aGlzLnN0cmluZ3NcbiAgICAgICAgICAgIC5tYXAoKHN0ciwgaW5keCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBmID0gdGhpcy5mdW5jdGlvbnNbaW5keF1cbiAgICAgICAgICAgICAgICBsZXQgdCA9IGYgPyAobj09PTAgPyBmLmNhbGwoKTogZi5jYWxsKGNvbnRleHQpKSA6ICcnXG4gICAgICAgICAgICAgICAgaWYgKHQgJiYgdCBpbnN0YW5jZW9mIFRtcGwpIHtcbiAgICAgICAgICAgICAgICAgICAgdCA9IGNvbnRleHQgPyB0LmJ1aWxkKGNvbnRleHQpIDogdC5idWlsZCgpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgICAgIHN0cixcbiAgICAgICAgICAgICAgICAgICAgdCxcbiAgICAgICAgICAgICAgICBdXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmZsYXQoKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICAgICAgLmpvaW4oJycpXG4gICAgfVxufVxuXG5leHBvcnQgbGV0IHRtcGwgPSAoc3RyaW5ncywgLi4uZnVuY3MpID0+IHtcbiAgICByZXR1cm4gbmV3IFRtcGwoc3RyaW5ncywgZnVuY3MpXG59XG4iLCIvLyB3aXJlIGVsZW1lbnRzIHdpdGggZXZlbnRzXG4vL1xuZXhwb3J0IGxldCB3aXJlID0gKHJvb3QsIGNmZywgYXJnKSA9PiBuZXcgQ2lyY3VpdChyb290LCBjZmcsIGFyZylcblxuZXhwb3J0IGxldCBDaXJjdWl0ID0gY2xhc3Mge1xuXG4gICAgY29uc3RydWN0b3IoXG4gICAgICAgIHJvb3RFbCxcbiAgICAgICAgZXZlbnRDb25maWdzLFxuICAgICAgICB7XG4gICAgICAgICAgICB0aGlzT2JqID0ge30sXG4gICAgICAgICAgICBxdWVyeUZuTmFtZSA9ICdxdWVyeVNlbGVjdG9yQWxsJyxcbiAgICAgICAgICAgIGxpc3RlbkZuTmFtZSA9ICdhZGRFdmVudExpc3RlbmVyJyxcbiAgICAgICAgICAgIHVubGlzdGVuRm5OYW1lPSAncmVtb3ZlRXZlbnRMaXN0ZW5lcicsXG4gICAgICAgICAgICBub3RpZnlGbk5hbWU9J2Rpc3BhdGNoRXZlbnQnLFxuICAgICAgICAgICAgdmFsaWRhdG9yID0gKGUpID0+IGUucGFyZW50Tm9kZSxcbiAgICAgICAgfSA9IHt9XG4gICAgKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbWUucm9vdEVsID0gcm9vdEVsXG4gICAgICAgIG1lLm5vZGVzID0ge31cbiAgICAgICAgbWUud2lyZXMgPSBuZXcgV2Vha01hcCgpXG4gICAgICAgIG1lLmZ1bmNzID0ge1xuICAgICAgICAgICAgcXVlcnlGbk5hbWUsXG4gICAgICAgICAgICBsaXN0ZW5Gbk5hbWUsXG4gICAgICAgICAgICB1bmxpc3RlbkZuTmFtZSxcbiAgICAgICAgICAgIG5vdGlmeUZuTmFtZSxcbiAgICAgICAgICAgIHZhbGlkYXRvcixcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGV2ZW50J3MgbGlzdGVuZXJzIHNjb3BlXG4gICAgICAgIC8vXG4gICAgICAgIG1lLnRoaXMgPSBuZXcgUHJveHkodGhpc09iaiwge1xuICAgICAgICAgICAgZ2V0KF8sIG5hbWUpIHtcbiAgICAgICAgICAgICAgICBpZiAobmFtZSA9PT0gJ3RvcF8nICYmICEoJ3RvcF8nIGluIHRoaXNPYmopKSByZXR1cm4gbWVcbiAgICAgICAgICAgICAgICBpZiAobmFtZSA9PT0gJ2ZpcmVfJyAmJiAhKCdmaXJlXycgaW4gdGhpc09iaikpIHJldHVybiBtZS5maXJlLmJpbmQobWUpXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gbWUubm9kZXMgJiYgbWUubm9kZXNbbmFtZV1cbiAgICAgICAgICAgICAgICAgICAgfHwgUmVmbGVjdC5nZXQoLi4uYXJndW1lbnRzKVxuICAgICAgICAgICAgfSxcblxuICAgICAgICAgICAgZGVsZXRlUHJvcGVydHkoXywgbmFtZSkge1xuICAgICAgICAgICAgICAgIGlmICghbWUubm9kZXMgfHwgIW1lLm5vZGVzW25hbWVdKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBSZWZsZWN0LmRlbGV0ZVByb3BlcnR5KC4uLmFyZ3VtZW50cylcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbGV0IGVsID0gbWUubm9kZXNbbmFtZV1cbiAgICAgICAgICAgICAgICBtZS5kZXdpcmUoZWwpXG4gICAgICAgICAgICAgICAgZGVsZXRlIG1lLm5vZGVzW25hbWVdXG4gICAgICAgICAgICB9LFxuICAgICAgICB9KVxuXG4gICAgICAgIC8vIGluaXRpYWxpemUgZXZlbnQtY29uZmlnc1xuICAgICAgICAvL1xuICAgICAgICBPYmplY3QuZW50cmllcyhldmVudENvbmZpZ3MpLmZvckVhY2goKFtxcnksIGV2ZW50Q29uZmlnXSkgPT4ge1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mIGV2ZW50Q29uZmlnID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGV2ZW50Q29uZmlnRm4gPSBldmVudENvbmZpZ1xuXG4gICAgICAgICAgICAgICAgbWUuI2dldEVsZW1zKHFyeSkuZm9yRWFjaCggKGVsLCBpLCBhcnIpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGEgPSBldmVudENvbmZpZ0ZuLmNhbGwobWUudGhpcywgZWwsIGksIGFycilcbiAgICAgICAgICAgICAgICAgICAgbGV0IHsgY2ZnLCBub2RlSWQgfSA9IG1lLiNnZXRDZmcoYSlcblxuICAgICAgICAgICAgICAgICAgICBtZS53aXJlKGVsLCBjZmcsIG5vZGVJZClcbiAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBjZmcsIG5vZGVJZCB9ID0gbWUuI2dldENmZyhldmVudENvbmZpZylcblxuICAgICAgICAgICAgICAgIG1lLiNnZXRFbGVtcyhxcnkpLmZvckVhY2goIChlbCwgaSwgYXJyKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIG1lLndpcmUoZWwsIGNmZywgbm9kZUlkKVxuICAgICAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICB9XG5cbiAgICAjZ2V0RWxlbXMocXJ5KSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbGV0IHF1ZXJ5Rm5OYW1lID0gbWUuZnVuY3MucXVlcnlGbk5hbWVcbiAgICAgICAgbGV0IGlzUm9vdCA9IHFyeT09PScuJ1xuICAgICAgICByZXR1cm4gaXNSb290XG4gICAgICAgICAgICA/IFttZS5yb290RWxdXG4gICAgICAgICAgICA6IFsuLi4obWUucm9vdEVsW3F1ZXJ5Rm5OYW1lXShxcnkpKV1cbiAgICB9XG5cbiAgICAjZ2V0Q2ZnKGV2ZW50Q29uZmlnKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbGV0IG1ldGEgPSB7fVxuICAgICAgICBsZXQgY2ZnID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgICAgICAgT2JqZWN0XG4gICAgICAgICAgICAuZW50cmllcyhldmVudENvbmZpZylcbiAgICAgICAgICAgIC5maWx0ZXIoIChbbmFtZSwgdmFsXSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpc0NvbmZpZyA9IG5hbWVbMF09PT0nXydcbiAgICAgICAgICAgICAgICBpZiAoaXNDb25maWcpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGsgPSBuYW1lLnNsaWNlKDEpXG4gICAgICAgICAgICAgICAgICAgIG1ldGFba10gPSB2YWxcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICB9KVxuICAgICAgICApXG5cbiAgICAgICAgbGV0IG5vZGVJZCA9IG1ldGEuaWRcbiAgICAgICAgbGV0IGlzQ29uZmxpY3QgPSBtZS50aGlzW25vZGVJZF1cbiAgICAgICAgICAgIHx8IHR5cGVvZiBtZS50aGlzW25vZGVJZF0gPT09ICdmdW5jdGlvbidcbiAgICAgICAgaWYgKGlzQ29uZmxpY3QpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgY29uZmxpY3Rpbmcgbm9kZXMgXCIke25vZGVJZH1cImApXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY2ZnLFxuICAgICAgICAgICAgbm9kZUlkLFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gY291bnRlciBmb3IgdW5uYW1lZCBub2RlSWRcbiAgICAvL1xuICAgIHN0YXRpYyBfaWQgPSAwXG5cbiAgICAvLyBhdHRhY2ggZXZlbnRzIHRvIGVsZW1lbnRcbiAgICAvL1xuICAgIHdpcmUoZWwsIGV2ZW50cywgbm9kZUlkKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcblxuICAgICAgICBpZiAoIW1lLndpcmVzLmhhcyhlbCkpIHtcbiAgICAgICAgICAgIG1lLndpcmVzLnNldChlbCwgW10pXG4gICAgICAgICAgICBsZXQgaWQgPSBub2RlSWQgfHwgYG5vZGUtJHsrK0NpcmN1aXQuX2lkfWBcbiAgICAgICAgICAgIG1lLm5vZGVzW2lkXSA9IGVsXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGlzdGVuID0gbWUuZnVuY3MubGlzdGVuRm5OYW1lXG4gICAgICAgIE9iamVjdFxuICAgICAgICAuZW50cmllcyhldmVudHMpXG4gICAgICAgIC5mb3JFYWNoKChbdHlwZSwgbGlzdGVuZXJdKSA9PiB7XG4gICAgICAgICAgICBsZXQgZm4gPSBsaXN0ZW5lci5iaW5kKG1lLnRoaXMpXG4gICAgICAgICAgICBlbFtsaXN0ZW5dKHR5cGUsIGZuKVxuXG4gICAgICAgICAgICBtZS53aXJlc1xuICAgICAgICAgICAgICAgIC5nZXQoZWwpXG4gICAgICAgICAgICAgICAgLnB1c2goW3R5cGUsIGZuXSlcbiAgICAgICAgfSlcbiAgICB9XG5cblxuICAgIC8vIHJlbW92ZSBldmVudHMgZnJvbSBhbiBlbGVtZW50XG4gICAgLy9cbiAgICBkZXdpcmUoZWwpIHtcbiAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICBsZXQgd20gPSBtZS53aXJlc1xuICAgICAgICBpZiAoIXdtLmhhcyhlbCkpIHJldHVybiBmYWxzZVxuXG4gICAgICAgIGxldCB1bmxpc3RlbiA9IG1lLmZ1bmNzLnVubGlzdGVuRm5OYW1lXG4gICAgICAgIHdtLmdldChlbCkuZm9yRWFjaCggKFt0eXBlLCBmbl0pID0+IHtcbiAgICAgICAgICAgIGVsW3VubGlzdGVuXSh0eXBlLCBmbilcbiAgICAgICAgfSlcbiAgICB9XG5cbiAgICAvLyBkZWxldGUgZXZlbnRzIGZyb20gYWxsIGVsZW1lbnRzXG4gICAgLy9cbiAgICBkZWxldGUoKSB7XG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgT2JqZWN0LnZhbHVlcyhtZS5ub2RlcykuZm9yRWFjaChlbCA9PiBtZS5kZXdpcmUoZWwpKVxuICAgICAgICBtZS5yb290RWwgPSBudWxsXG4gICAgICAgIG1lLm5vZGVzID0gbnVsbFxuICAgICAgICBtZS53aXJlcyA9IG51bGxcbiAgICB9XG5cbiAgICAvLyByZW1vdmUgb3JwaGFuZWQgZWxlbWVudHNcbiAgICAvL1xuICAgIGNsZWFuKCkge1xuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIGxldCB2YWxpZGF0ZSA9IG1lLmZ1bmNzLnZhbGlkYXRvclxuICAgICAgICBmb3IgKGxldCBbaWQsIGVsXSBvZiBPYmplY3QuZW50cmllcyhtZS5ub2RlcykpIHtcbiAgICAgICAgICAgIGlmIChlbD09bWUucm9vdEVsIHx8IHZhbGlkYXRlKGVsKSkgY29udGludWVcblxuICAgICAgICAgICAgbWUuZGV3aXJlKGVsKVxuICAgICAgICAgICAgZGVsZXRlIG1lLm5vZGVzW2lkXVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLy8gZ2V0IG5vZGVzIHdoaWNoIGhhcyBldmVudE5hbWVcbiAgICAvL1xuICAgIG5vZGVzVGhhdExpc3RlblRvKGV2ZW50TmFtZSx7XG4gICAgICAgIGlzU2tpcFJvb3RFbD1mYWxzZSxcbiAgICB9ID0ge30pIHtcblxuICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgIGxldCB3bSA9IG1lLndpcmVzXG5cbiAgICAgICAgcmV0dXJuIE9iamVjdFxuICAgICAgICAgICAgLnZhbHVlcyhtZS5ub2RlcylcbiAgICAgICAgICAgIC5maWx0ZXIoZWwgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgIXdtLmhhcyhlbClcbiAgICAgICAgICAgICAgICAgICAgfHwgaXNTa2lwUm9vdEVsICYmIGVsPT09bWUucm9vdEVsXG4gICAgICAgICAgICAgICAgKSByZXR1cm5cblxuICAgICAgICAgICAgICAgIHJldHVybiB3bS5nZXQoZWwpXG4gICAgICAgICAgICAgICAgICAgIC5maW5kKCAoW25hbWUsX10pID0+IG5hbWU9PT1ldmVudE5hbWUpXG4gICAgICAgICAgICB9KVxuICAgIH1cblxuICAgIC8vIHRyaWdnZXJzIGV2ZW50cyBvZiBzcGVjaWZpYyBuYW1lXG4gICAgLy9cbiAgICBmaXJlKGV2dCwge1xuICAgICAgICBpc1NraXBSb290RWw9ZmFsc2UsXG4gICAgfSA9IHt9KSB7XG4gICAgICAgIGlmICghZXZ0IHx8ICFldnQudHlwZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdpbnZhbGlkIGV2ZW50JylcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBtZSA9IHRoaXNcbiAgICAgICAgbGV0IGZuID0gbWUuZnVuY3Mubm90aWZ5Rm5OYW1lXG5cbiAgICAgICAgbGV0IGV2ZW50VHlwZSA9IGV2dC50eXBlXG4gICAgICAgIG1lXG4gICAgICAgIC5ub2Rlc1RoYXRMaXN0ZW5UbyhldmVudFR5cGUsIHsgaXNTa2lwUm9vdEVsIH0pXG4gICAgICAgIC5mb3JFYWNoKGVsID0+IHtcbiAgICAgICAgICAgIGlmICghZWxbZm5dKSByZXR1cm5cbiAgICAgICAgICAgIGVsW2ZuXS5jYWxsKGVsLCBldnQpXG4gICAgICAgIH0pXG4gICAgfVxufVxuIiwiZXhwb3J0IHsgdG1wbCwgfSBmcm9tICcuL2RlcHMuanMnXG5pbXBvcnQgeyB3aXJlLCB9IGZyb20gJy4vZGVwcy5qcydcblxuZXhwb3J0IGxldCBjdXN0b21FbGVtZW50RGVmYXVsdHMgPSB7XG4gICAgaGVhZGVyOiAnJyxcbiAgICBmb290ZXI6ICcnLFxufVxuXG4vLyBidWlsZHMgYSB3aXJlZCBjdXN0b20tZWxlbWVudCBmcm9tIGEgc3RyaW5nIHRlbXBsYXRlXG4vL1xuZXhwb3J0IGxldCBjdXN0b21FbGVtZW50ID0gKFxuICAgIHRlbXBsYXRlLFxuICAgIHtcbiAgICAgICAgX2hlYWRlciA9IGN1c3RvbUVsZW1lbnREZWZhdWx0cy5oZWFkZXIsXG4gICAgICAgIF9mb290ZXIgPSBjdXN0b21FbGVtZW50RGVmYXVsdHMuZm9vdGVyLFxuICAgICAgICBfd2lyZXMgPSB7fSxcbiAgICAgICAgX2F0dHJpYnV0ZXMgPSB7fSxcbiAgICAgICAgX2Zvcm1Bc3NvY2lhdGVkID0gdHJ1ZSxcbiAgICAgICAgLi4uY29udGV4dFxuICAgIH0gPSB7fSxcblxuICAgIC8vIG5lZWRlZCBjbGFzc2VzIGZvciB0ZXN0aW5nXG4gICAge1xuICAgICAgICBIVE1MRWxlbWVudCA9IGdsb2JhbFRoaXMuSFRNTEVsZW1lbnQsXG4gICAgICAgIGRvY3VtZW50ID0gZ2xvYmFsVGhpcy5kb2N1bWVudCxcbiAgICAgICAgQ3VzdG9tRXZlbnQgPSBnbG9iYWxUaGlzLkN1c3RvbUV2ZW50LFxuICAgIH0gPSB7fSxcbikgPT4ge1xuXG4gICAgcmV0dXJuIGNsYXNzIGV4dGVuZHMgSFRNTEVsZW1lbnQge1xuICAgICAgICBzdGF0aWMgZm9ybUFzc29jaWF0ZWQgPSBfZm9ybUFzc29jaWF0ZWRcblxuICAgICAgICBjb25zdHJ1Y3RvcigpIHtcbiAgICAgICAgICAgIHN1cGVyKClcbiAgICAgICAgICAgIHRoaXMudGVtcGxhdGVfID0gdGVtcGxhdGVcbiAgICAgICAgICAgIHRoaXMuY29udGV4dF8gPSBPYmplY3QuYXNzaWduKHtcbiAgICAgICAgICAgICAgICByb290Xzp0aGlzLFxuICAgICAgICAgICAgICAgIGJ1aWxkXzogdGhpcy5idWlsZC5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgICAgIGZpcmVfOiB0aGlzLmZpcmUuYmluZCh0aGlzKSxcbiAgICAgICAgICAgIH0sIGNvbnRleHQpXG5cbiAgICAgICAgICAgIHRoaXMud2lyZXNDb25maWcgPSB0eXBlb2YoX3dpcmVzKT09PSdmdW5jdGlvbidcbiAgICAgICAgICAgICAgICA/IF93aXJlc1xuICAgICAgICAgICAgICAgIDogKCgpID0+IF93aXJlcylcblxuICAgICAgICAgICAgdGhpcy5hdHRhY2hTaGFkb3coeyBtb2RlOidvcGVuJyB9KVxuICAgICAgICAgICAgdGhpcy5idWlsZCgpXG4gICAgICAgIH1cblxuICAgICAgICBidWlsZChcbiAgICAgICAgICAgIHVwZGF0ZUNvbnRleHQ9e30sXG4gICAgICAgICkge1xuICAgICAgICAgICAgaWYgKHRoaXMud2lyZXNfKSB7XG4gICAgICAgICAgICAgICAgdGhpcy53aXJlc18uZGVsZXRlKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcy5jb250ZXh0XywgdXBkYXRlQ29udGV4dClcblxuICAgICAgICAgICAgbGV0IHIgPSB0aGlzLnNoYWRvd1Jvb3RcbiAgICAgICAgICAgIHdoaWxlKHIuZmlyc3RDaGlsZCkge1xuICAgICAgICAgICAgICAgIHIucmVtb3ZlQ2hpbGQoci5maXJzdENoaWxkKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3RlbXBsYXRlJylcbiAgICAgICAgICAgIHQuaW5uZXJIVE1MID0gW1xuICAgICAgICAgICAgICAgIF9oZWFkZXIsXG4gICAgICAgICAgICAgICAgdGVtcGxhdGUuYnVpbGQodGhpcy5jb250ZXh0XyksXG4gICAgICAgICAgICAgICAgX2Zvb3RlclxuICAgICAgICAgICAgXS5maWx0ZXIoQm9vbGVhbikuam9pbignJylcbiAgICAgICAgICAgIHIuYXBwZW5kQ2hpbGQodC5jb250ZW50LmNsb25lTm9kZSh0cnVlKSlcbiAgICAgICAgICAgIHQgPSBudWxsXG5cbiAgICAgICAgICAgIHRoaXMud2lyZXNfID0gd2lyZShyLFxuICAgICAgICAgICAgICAgIHRoaXMud2lyZXNDb25maWcuY2FsbCh0aGlzLmNvbnRleHRfLCB0aGlzKSxcbiAgICAgICAgICAgICAgICB7IHRoaXNPYmo6IHRoaXMuY29udGV4dF8sfSlcblxuICAgICAgICAgICAgdGhpcy50aGlzID0gdGhpcy53aXJlc18udGhpc1xuICAgICAgICB9XG5cbiAgICAgICAgZmlyZShldikge1xuICAgICAgICAgICAgdGhpcy53aXJlc18uZmlyZShldilcbiAgICAgICAgICAgIHRoaXMuZGlzcGF0Y2hFdmVudChldilcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbm5lY3RlZENhbGxiYWNrKCkge1xuICAgICAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICAgICAgbGV0IGV2ID0gbmV3IEN1c3RvbUV2ZW50KCdjb25uZWN0ZWQnLCB7IGRldGFpbDpudWxsIH0pXG4gICAgICAgICAgICBtZS5maXJlKGV2KVxuICAgICAgICB9XG5cbiAgICAgICAgZGlzY29ubmVjdGVkQ2FsbGJhY2soKSB7XG4gICAgICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgICAgICBsZXQgZXYgPSBuZXcgQ3VzdG9tRXZlbnQoJ2Rpc2Nvbm5lY3RlZCcsIHsgZGV0YWlsOm51bGwgfSlcbiAgICAgICAgICAgIG1lLmZpcmUoZXYpXG4gICAgICAgIH1cblxuICAgICAgICBhZG9wdGVkQ2FsbGJhY2soKSB7XG4gICAgICAgICAgICBsZXQgbWUgPSB0aGlzXG4gICAgICAgICAgICBsZXQgZXYgPSBuZXcgQ3VzdG9tRXZlbnQoJ2Fkb3B0ZWQnLCB7IGRldGFpbDpudWxsIH0pXG4gICAgICAgICAgICBtZS5maXJlKGV2KVxuICAgICAgICB9XG5cbiAgICAgICAgc3RhdGljIGdldCBvYnNlcnZlZEF0dHJpYnV0ZXMoKSB7XG4gICAgICAgICAgICByZXR1cm4gT2JqZWN0LmtleXMoX2F0dHJpYnV0ZXMpXG4gICAgICAgIH1cblxuICAgICAgICBhdHRyaWJ1dGVDaGFuZ2VkQ2FsbGJhY2sobmFtZSwgb2xkVmFsdWUsIHZhbHVlKSB7XG4gICAgICAgICAgICBsZXQgZiA9IF9hdHRyaWJ1dGVzW25hbWVdXG4gICAgICAgICAgICBpZiAoZiAmJiB0eXBlb2YgZiA9PT0nZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgZi5jYWxsKHRoaXMuY29udGV4dF8sIHZhbHVlLCBvbGRWYWx1ZSlcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IG1lID0gdGhpc1xuICAgICAgICAgICAgbGV0IGV2ID0gbmV3IEN1c3RvbUV2ZW50KCdhdHRyaWJ1dGVfY2hhbmdlZCcsIHtcbiAgICAgICAgICAgICAgICBkZXRhaWw6e25hbWUsIHZhbHVlLCBvbGRWYWx1ZSx9XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgbWUuZmlyZShldilcbiAgICAgICAgfVxuICAgIH1cbn1cbiIsImltcG9ydCB7IHRtcGwsIHdpcmUsIH0gZnJvbSAnLi9kZXBzLmpzJ1xuXG5leHBvcnQgbGV0IHdpcmVFbGVtZW50ID0gKFxuICAgIHJvb3RFbCxcbiAgICB0ZW1wbGF0ZSxcbiAgICBjZmcsXG5cbiAgICAvLyBuZWVkZWQgY2xhc3NlcyBmb3IgdGVzdGluZ1xuICAgIHtcbiAgICAgICAgZG9jdW1lbnQgPSBnbG9iYWxUaGlzLmRvY3VtZW50LFxuICAgIH0gPSB7fSxcbikgPT4ge1xuICAgIHJldHVybiBuZXcgV2lyZWRFbGVtZW50KFxuICAgICAgICByb290RWwsIHRlbXBsYXRlLCBjZmcsIHsgZG9jdW1lbnQgfVxuICAgIClcblxufVxuXG5sZXQgV2lyZWRFbGVtZW50ID0gY2xhc3Mge1xuICAgIGNvbnN0cnVjdG9yKFxuICAgICAgICByb290RWwsXG4gICAgICAgIHRlbXBsYXRlLFxuICAgICAgICB7XG4gICAgICAgICAgICBfd2lyZXMgPSB7fSxcbiAgICAgICAgICAgIC4uLmNvbnRleHRcbiAgICAgICAgfSA9IHt9LFxuICAgICAgICB7XG4gICAgICAgICAgICBkb2N1bWVudCA9IGdsb2JhbFRoaXMuZG9jdW1lbnQsXG4gICAgICAgIH1cbiAgICApIHtcbiAgICAgICAgdGhpcy5yb290ID0gcm9vdEVsXG4gICAgICAgIHRoaXMudGVtcGxhdGVfID0gdGVtcGxhdGVcbiAgICAgICAgdGhpcy5jb250ZXh0XyA9IE9iamVjdC5hc3NpZ24oe1xuICAgICAgICAgICAgcm9vdF86dGhpcyxcbiAgICAgICAgICAgIGJ1aWxkXzogdGhpcy5idWlsZC5iaW5kKHRoaXMpLFxuICAgICAgICAgICAgZmlyZV86IHRoaXMuZmlyZS5iaW5kKHRoaXMpLFxuICAgICAgICB9LCBjb250ZXh0KVxuXG4gICAgICAgIHRoaXMud2lyZXNDb25maWcgPSB0eXBlb2YoX3dpcmVzKT09PSdmdW5jdGlvbidcbiAgICAgICAgICAgID8gX3dpcmVzXG4gICAgICAgICAgICA6ICgoKSA9PiBfd2lyZXMpXG5cbiAgICAgICAgdGhpcy5kb2N1bWVudCA9IGRvY3VtZW50XG4gICAgICAgIHRoaXMuYnVpbGQoKVxuICAgIH1cblxuICAgIGJ1aWxkKFxuICAgICAgICB1cGRhdGVDb250ZXh0PXt9LFxuICAgICkge1xuICAgICAgICBpZiAodGhpcy53aXJlc18pIHtcbiAgICAgICAgICAgIHRoaXMud2lyZXNfLmRlbGV0ZSgpO1xuICAgICAgICB9XG5cbiAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLmNvbnRleHRfLCB1cGRhdGVDb250ZXh0KVxuXG4gICAgICAgIGxldCByID0gdGhpcy5yb290XG4gICAgICAgIHdoaWxlKHIuZmlyc3RDaGlsZCkge1xuICAgICAgICAgICAgci5yZW1vdmVDaGlsZChyLmZpcnN0Q2hpbGQpXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdCA9IHRoaXMuZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGVtcGxhdGUnKVxuICAgICAgICB0LmlubmVySFRNTCA9IHRoaXMudGVtcGxhdGVfLmJ1aWxkKHRoaXMuY29udGV4dF8pLFxuICAgICAgICByLmFwcGVuZENoaWxkKHQuY29udGVudC5jbG9uZU5vZGUodHJ1ZSkpXG4gICAgICAgIHQgPSBudWxsXG5cbiAgICAgICAgdGhpcy53aXJlc18gPSB3aXJlKHIsXG4gICAgICAgICAgICB0aGlzLndpcmVzQ29uZmlnLmNhbGwodGhpcy5jb250ZXh0XywgdGhpcyksXG4gICAgICAgICAgICB7IHRoaXNPYmo6IHRoaXMuY29udGV4dF8sIH0pXG5cbiAgICAgICAgdGhpcy50aGlzID0gdGhpcy53aXJlc18udGhpc1xuICAgIH1cblxuICAgIGZpcmUoZXYpIHtcbiAgICAgICAgdGhpcy53aXJlc18uZmlyZShldiwge2lzU2tpcFJvb3RFbDp0cnVlfSlcbiAgICAgICAgdGhpcy5yb290LmRpc3BhdGNoRXZlbnQoZXYpXG4gICAgfVxuXG59IiwibGV0IGFycmF5RnJvbSA9IChhcnIpID0+IEFycmF5LmlzQXJyYXkoYXJyKSA/IGFyciA6IFthcnJdXHJcblxyXG4vLyBwdWJsaXNoLXN1YnNjcmliZSB0byBjaGFubmVsc1xyXG4vL1xyXG5leHBvcnQgY2xhc3MgUHViU3ViIHtcclxuICAgIGNvbnN0cnVjdG9yICh7XHJcbiAgICAgICAgYnJvYWRjYXN0Q2hhbm5lbElkXHJcbiAgICB9KSB7XHJcbiAgICAgICAgdmFyIG1lID0gdGhpc1xyXG4gICAgICAgIG1lLl9pZCA9IDBcclxuICAgICAgICBtZS5jaGFubmVscyA9IHt9IC8vIGxvY2FsIGNoYW5uZWxzXHJcblxyXG4gICAgICAgIC8vIGFsc28gbGlzdGVucyB0byBicm9hZGFjYXN0IGNoYW5uZWxcclxuICAgICAgICAvL1xyXG4gICAgICAgIGlmIChicm9hZGNhc3RDaGFubmVsSWQpIHtcclxuICAgICAgICAgICAgbGV0IGJjID0gbmV3IEJyb2FkY2FzdENoYW5uZWwoYnJvYWRjYXN0Q2hhbm5lbElkKVxyXG5cclxuICAgICAgICAgICAgYmMub25tZXNzYWdlID0gKGV2KSA9PiB7XHJcbiAgICAgICAgICAgICAgICBsZXQgeyBjaGFubmVsLCBhcmdzIH0gPSBldi5kYXRhXHJcbiAgICAgICAgICAgICAgICBtZS5wdWJsaXNoXy5hcHBseShtZSwgW2NoYW5uZWxdLmNvbmNhdChhcmdzKSlcclxuICAgICAgICAgICAgfVxyXG5cclxuICAgICAgICAgICAgbWUuYnJvYWRjYXN0Q2hhbm5lbCA9IGJjXHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8vIGNsZWFycyBhbGwgY2hhbm5lbFxyXG4gICAgcmVzZXQoKSB7XHJcbiAgICAgICAgdGhpcy5faWQgPSAwXHJcbiAgICAgICAgdGhpcy5jaGFubmVscyA9IHt9XHJcbiAgICB9XHJcblxyXG4gICAgLy8gY3JlYXRlcyBjaGFubmVsLnVuaXF1ZV9pZFxyXG4gICAgLy9cclxuICAgIGNoYW5uZWxJZChpZCkge1xyXG4gICAgICAgIGxldCBbY2gsIC4uLm5zXSA9IChpZCB8fCAnJykuc3BsaXQoJy4nKVxyXG4gICAgICAgIHJldHVybiBbXHJcbiAgICAgICAgICAgIGNoLCAvLyBjaGFubmVsLW5hbWVcclxuICAgICAgICAgICAgbnMuam9pbignLicpIHx8IGBfJHsrK3RoaXMuX2lkfWAgLy8gaWQgdG8gY2hhbm5lbFxyXG4gICAgICAgIF1cclxuICAgIH1cclxuXHJcbiAgICAvLyBjaGFubmVsc1tjaGFubmVsXSA9IHsgaWQ6IGZuIH1cclxuICAgIC8vXHJcbiAgICBzdWJzY3JpYmUoaWQsIGZuLCBvdmVycmlkZT1mYWxzZSkge1xyXG4gICAgICAgIGxldCBbY2gsIG5dID0gdGhpcy5jaGFubmVsSWQoaWQpXHJcbiAgICAgICAgaWYgKCFjaCkgcmV0dXJuXHJcblxyXG4gICAgICAgIGxldCBjaGFubmVscyA9IHRoaXMuY2hhbm5lbHNcclxuICAgICAgICBpZiAoIWNoYW5uZWxzW2NoXSkgY2hhbm5lbHNbY2hdID0ge31cclxuICAgICAgICBsZXQgc3VicyA9IGNoYW5uZWxzW2NoXVxyXG5cclxuICAgICAgICBpZiAoc3Vic1tuXSAmJiAhb3ZlcnJpZGUpIHtcclxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBzdWJzY3JpYmU6ICR7aWR9IGFscmVhZHkgZXhpc3RzYClcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHN1YnNbbl0gPSBmblxyXG4gICAgICAgIHJldHVybiBbY2gsIG5dLmpvaW4oJy4nKVxyXG4gICAgfVxyXG5cclxuICAgIC8vIGRlbGV0ZXMgZnJvbSBjaGFubmVsXHJcbiAgICAvL1xyXG4gICAgdW5zdWJzY3JpYmUoKSB7XHJcbiAgICAgICAgbGV0IG1lID0gdGhpc1xyXG4gICAgICAgIEFycmF5LmZyb20oYXJndW1lbnRzKS5mbGF0KCkuZm9yRWFjaCgoaWQpID0+IHtcclxuICAgICAgICAgICAgbGV0IFtjaCwgbl0gPSBtZS5jaGFubmVsSWQoaWQpXHJcbiAgICAgICAgICAgIGlmICghY2gpIHJldHVyblxyXG5cclxuICAgICAgICAgICAgbGV0IHN1YnMgPSBtZS5jaGFubmVsc1tjaF1cclxuICAgICAgICAgICAgaWYgKCFzdWJzKSByZXR1cm5cclxuXHJcbiAgICAgICAgICAgIGRlbGV0ZSBzdWJzW25dXHJcbiAgICAgICAgfSlcclxuICAgIH1cclxuXHJcbiAgICAvLyBwdWJsaXNoIHRvIGxvY2FsIHBvb2xcclxuICAgIC8vXHJcbiAgICBwdWJsaXNoXyhjaCwgLi4uYXJncykge1xyXG4gICAgICAgIGxldCBzdWJzID0gdGhpcy5jaGFubmVsc1tjaF1cclxuICAgICAgICBpZiAoIXN1YnMpIHJldHVyblxyXG5cclxuICAgICAgICBPYmplY3QudmFsdWVzKHN1YnMpXHJcbiAgICAgICAgLmZvckVhY2goZm4gPT4ge1xyXG4gICAgICAgICAgICBmbi5hcHBseShudWxsLCBhcmdzKVxyXG4gICAgICAgIH0pXHJcbiAgICB9XHJcblxyXG4gICAgLy8gcHVibGlzaCB0byBsb2NhbCBhbmQgYnJvYWRjYXN0IGNoYW5uZWxcclxuICAgIC8vIGNoYW5uZWwgZW5kcyB3aXRoIFwiIVwiIGJyb2FkY2FzdCB0byBhbGwgbGlzdGVuZXJzXHJcbiAgICAvL1xyXG4gICAgcHVibGlzaChjaGFubmVsLCAuLi5hcmdzKSB7XHJcbiAgICAgICAgbGV0IGJyb2FkY2FzdCA9IGNoYW5uZWwuc2xpY2UoLTEpPT09JyEnXHJcbiAgICAgICAgY2hhbm5lbCA9IGJyb2FkY2FzdFxyXG4gICAgICAgICAgICA/IGNoYW5uZWwuc2xpY2UoMCwgLTEpXHJcbiAgICAgICAgICAgIDogY2hhbm5lbFxyXG5cclxuICAgICAgICBpZiAoYnJvYWRjYXN0ICYmIHRoaXMuYnJvYWRjYXN0Q2hhbm5lbCApIHtcclxuICAgICAgICAgICAgdGhpcy5icm9hZGNhc3RDaGFubmVsLnBvc3RNZXNzYWdlKHtcclxuICAgICAgICAgICAgICAgIGNoYW5uZWwsXHJcbiAgICAgICAgICAgICAgICBhcmdzXHJcbiAgICAgICAgICAgIH0pXHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0aGlzLnB1Ymxpc2hfLmFwcGx5KHRoaXMsIFtjaGFubmVsXS5jb25jYXQoYXJncykpXHJcbiAgICB9XHJcblxyXG4gICAgLy8gZXhlY3V0ZSB0byBsb2NhbCBjaGFubmVscyBvbmx5XHJcbiAgICAvL1xyXG4gICAgYXN5bmMgZXhlYyhjaCwgLi4uYXJncykge1xyXG4gICAgICAgIGxldCBzdWJzID0gdGhpcy5jaGFubmVsc1tjaF1cclxuICAgICAgICBpZiAoIXN1YnMpIHJldHVyblxyXG5cclxuICAgICAgICBsZXQgZm5zID0gT2JqZWN0LnZhbHVlcyhzdWJzKVxyXG4gICAgICAgICAgICAubWFwKGZuID0+IGZuLmFwcGx5KG51bGwsIGFyZ3MpKVxyXG4gICAgICAgIGxldCBhcnIgPSBhd2FpdCBQcm9taXNlLmFsbChmbnMpXHJcblxyXG4gICAgICAgIHJldHVybiBPYmplY3Qua2V5cyhzdWJzKVxyXG4gICAgICAgICAgICAucmVkdWNlKCAoeCwgaWQsIGkpID0+IHtcclxuICAgICAgICAgICAgICAgIHhbaWRdID0gYXJyW2ldXHJcbiAgICAgICAgICAgICAgICByZXR1cm4geFxyXG4gICAgICAgICAgICB9LCB7fSlcclxuICAgIH1cclxufVxyXG5cclxuLy8gZm9yIGEgZ2xvYmFsIHB1YnN1YlxyXG4vL1xyXG5jb25zdCBXRUJfUFVCU1VCX0JST0FEQ0FTVF9DSEFOTkVMX0lEID1cclxuICAgIGdsb2JhbFRoaXMuV0VCX1BVQlNVQl9CUk9BRENBU1RfQ0hBTk5FTF9JRFxyXG4gICAgfHwgJ3dlYi1wdWJzdWItYnJvYWRjYXN0LWNoYW5uZWwtaWQnXHJcbmV4cG9ydCBsZXQgcHVic3ViID0gbmV3IFB1YlN1Yih7XHJcbiAgICBicm9hZGNhc3RDaGFubmVsSWQ6IFdFQl9QVUJTVUJfQlJPQURDQVNUX0NIQU5ORUxfSURcclxufSlcclxuZXhwb3J0IGxldCBwdWJsaXNoID0gcHVic3ViLnB1Ymxpc2guYmluZChwdWJzdWIpXHJcbmV4cG9ydCBsZXQgc3Vic2NyaWJlID0gcHVic3ViLnN1YnNjcmliZS5iaW5kKHB1YnN1YilcclxuZXhwb3J0IGxldCB1bnN1YnNjcmliZSA9IHB1YnN1Yi51bnN1YnNjcmliZS5iaW5kKHB1YnN1YilcclxuZXhwb3J0IGxldCBleGVjID0gcHVic3ViLmV4ZWMuYmluZChwdWJzdWIpXHJcbiIsImV4cG9ydCBjb25zdCBpc0VtcHR5ID0gKGEpID0+IChhPT1udWxsKSB8fCAoYT09PScnKSB8fCAoQXJyYXkuaXNBcnJheShhKSAmJiBhLmxlbmd0aD09PTApXHJcblxyXG5leHBvcnQgY29uc3QgaXNTdHJpbmcgPSAoYSkgPT4gKHR5cGVvZiBhID09PSAnc3RyaW5nJylcclxuXHJcbmV4cG9ydCBjb25zdCBpc0Jvb2xlYW4gPSAoYSkgPT4gKHR5cGVvZiBhID09PSAnYm9vbGVhbicpXHJcblxyXG5leHBvcnQgY29uc3QgaXNGdW5jdGlvbiA9IChhKSA9PiAodHlwZW9mIGEgPT09ICdmdW5jdGlvbicpXHJcblxyXG5leHBvcnQgY29uc3QgaXNPYmplY3QgPSAoYSkgPT4gKGEgIT09IG51bGwgJiYgYSBpbnN0YW5jZW9mIE9iamVjdCAmJiBhLmNvbnN0cnVjdG9yID09PSBPYmplY3QpXHJcbiIsImV4cG9ydCBsZXQgZnJvbSA9ICh2YWwpID0+XG5cdCh2YWwgPT09IHVuZGVmaW5lZCB8fCB2YWw9PT1udWxsKSA/IFtdIDpcblx0QXJyYXkuaXNBcnJheSh2YWwpID8gdmFsIDpcblx0W3ZhbF1cbiIsImltcG9ydCB7IGlzRW1wdHksIGlzT2JqZWN0LCB9IGZyb20gXCIuL2lzLmpzXCJcclxuaW1wb3J0ICogYXMgQXJyIGZyb20gXCIuL2Fyci5qc1wiXHJcblxyXG5leHBvcnQgbGV0IGNsZWFuID0gKG9iaikgPT4ge1xyXG4gICAgbGV0IHYgPSB7fVxyXG4gICAgZm9yIChsZXQgayBpbiBvYmopIHtcclxuICAgICAgICBsZXQgYSA9IG9ialtrXVxyXG4gICAgICAgIGlmIChpc0VtcHR5KGEpKSBjb250aW51ZVxyXG4gICAgICAgIHZba10gPSBhXHJcbiAgICB9XHJcbiAgICByZXR1cm4gdlxyXG59XHJcblxyXG5leHBvcnQgbGV0IHNldCA9IChyb290LCBwYXRoLCB2YWx1ZSkgPT4ge1xyXG5cclxuICAgIGxldCBrZXlzID0gcGF0aC5zcGxpdCgnLicpXHJcbiAgICBsZXQgbGFzdEtleSA9IGtleXMucG9wKClcclxuXHJcbiAgICB2YXIgciA9IHJvb3QgfHwge31cclxuICAgIGtleXMuZm9yRWFjaChrID0+IHtcclxuICAgICAgICBpZiAoIXIuaGFzT3duUHJvcGVydHkoaykpIHJba10gPSB7fVxyXG4gICAgICAgIHIgPSByW2tdXHJcbiAgICB9KVxyXG5cclxuICAgIHJbbGFzdEtleV0gPSB2YWx1ZVxyXG5cclxuICAgIHJldHVybiByb290XHJcbn1cclxuXHJcbmV4cG9ydCBsZXQgZ2V0ID0gKHJvb3QsIHBhdGgsIGRlZmF1bHRWYWx1ZSkgPT4ge1xyXG4gICAgbGV0IGtleXMgPSBwYXRoLnNwbGl0KCcuJylcclxuICAgIGxldCByID0gcm9vdCB8fCB7fVxyXG4gICAgZm9yIChsZXQgayBvZiBrZXlzKSB7XHJcbiAgICAgICAgaWYgKCFyLmhhc093blByb3BlcnR5KGspKSByZXR1cm4gZGVmYXVsdFZhbHVlXHJcbiAgICAgICAgciA9IHJba11cclxuICAgIH1cclxuICAgIHJldHVybiByXHJcbn1cclxuXHJcbmV4cG9ydCBsZXQgdHJpbSA9IChyb290LCBwYXRoKSA9PiB7XHJcbiAgICBsZXQga2V5cyA9IHBhdGguc3BsaXQoJy4nKVxyXG4gICAgbGV0IGxhc3RLZXkgPSBrZXlzLnBvcCgpXHJcblxyXG4gICAgdmFyIHIgPSByb290IHx8IHt9XHJcbiAgICBmb3IgKGxldCBrIG9mIGtleXMpIHtcclxuICAgICAgICBpZiAoIXIuaGFzT3duUHJvcGVydHkoaykpIHJldHVybiBmYWxzZVxyXG4gICAgICAgIHIgPSByW2tdXHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuIGRlbGV0ZSByW2xhc3RLZXldXHJcbn1cclxuXHJcbmV4cG9ydCBsZXQgcGFyc2UgPSAoc3RyLCBkZWZhdWx0VmFsdWUpID0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2Uoc3RyKVxyXG4gICAgfSBjYXRjaCh4KSB7XHJcbiAgICAgICAgcmV0dXJuIGRlZmF1bHRWYWx1ZVxyXG4gICAgfVxyXG59XHJcblxyXG5leHBvcnQgbGV0IG1lcmdlID0gKG9iaiwuLi5icykgPT4ge1xyXG4gICAgQXJyYXkuZnJvbShicykuZmlsdGVyKEJvb2xlYW4pLmZvckVhY2goKGIpID0+IHtcclxuXHJcbiAgICAgICAgZm9yIChsZXQgW2ssdl0gb2YgT2JqZWN0LmVudHJpZXMoYikpIHtcclxuICAgICAgICAgICAgbGV0IGEgPSBvYmpba11cclxuXHJcbiAgICAgICAgICAgIC8vIG1lcmdlIG9iamVjdFxyXG4gICAgICAgICAgICBpZiAoaXNPYmplY3QoYSkgJiYgaXNPYmplY3QodikpIHtcclxuICAgICAgICAgICAgICAgIG9ialtrXSA9IHsuLi5hLCAuLi52fVxyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICAvLyBtZXJnZSBhcnJheVxyXG4gICAgICAgICAgICBlbHNlIGlmIChBcnJheS5pc0FycmF5KGEpKSB7XHJcbiAgICAgICAgICAgICAgICBvYmpba10gPSBbXHJcbiAgICAgICAgICAgICAgICAgICAgLi4uYSxcclxuICAgICAgICAgICAgICAgICAgICAuLi4oQXJyLmZyb20odikpXHJcbiAgICAgICAgICAgICAgICBdXHJcbiAgICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICAgIC8vIHJlcGxhY2VtZW50XHJcbiAgICAgICAgICAgIGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgb2JqW2tdID0gdlxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSlcclxuICAgIHJldHVybiBvYmpcclxufSIsImltcG9ydCB7IGlzRnVuY3Rpb24gfSBmcm9tIFwiLi9pcy5qc1wiXG5leHBvcnQgbGV0IGZyb20gPSAoYSkgPT4gaXNGdW5jdGlvbihhKSA/IGEgOiAoICgpID0+IGEpIiwiaW1wb3J0ICogYXMgT2JqIGZyb20gJy4vb2JqLmpzJ1xyXG5cclxuZXhwb3J0IHsgT2JqIH1cclxuXHJcbmV4cG9ydCAqIGFzIElzIGZyb20gJy4vaXMuanMnXHJcbmV4cG9ydCAqIGFzIEFyciBmcm9tICcuL2Fyci5qcydcclxuZXhwb3J0ICogYXMgRm4gZnJvbSAnLi9mbi5qcydcclxuXHJcbmV4cG9ydCBjbGFzcyBTdG9yZSB7XHJcbiAgICBjb25zdHJ1Y3RvcihcclxuICAgICAgICBpZCxcclxuICAgICAgICB7XHJcbiAgICAgICAgICAgIGluaXRpYWwgPSB7fSxcclxuICAgICAgICAgICAgc3RvcmUgPSBnbG9iYWxUaGlzLnNlc3Npb25TdG9yYWdlLFxyXG4gICAgICAgIH0gPSB7fVxyXG4gICAgKSB7XHJcbiAgICAgICAgaWYgKCFpZCkgdGhyb3cgbmV3IEVycm9yKCdzdG9yZSBpZCByZXF1aXJlZCcpXHJcbiAgICAgICAgdGhpcy5pZCA9IGlkXHJcbiAgICAgICAgdGhpcy52YWx1ZSA9IGluaXRpYWxcclxuICAgICAgICB0aGlzLnN0b3JlID0gc3RvcmVcclxuICAgIH1cclxuXHJcbiAgICBzZXQocGF0aCwgdmFsdWVzKSB7XHJcbiAgICAgICAgdGhpcy52YWx1ZSA9IE9iai5zZXQodGhpcy52YWx1ZSB8fCB7fSwgcGF0aCwgdmFsdWVzKVxyXG4gICAgICAgIHRoaXMuc2F2ZSgpXHJcbiAgICAgICAgcmV0dXJuIHRoaXNcclxuICAgIH1cclxuXHJcbiAgICBnZXQocGF0aCwgZGVmYXVsdFZhbHVlKSB7XHJcbiAgICAgICAgcmV0dXJuICh0aGlzLnZhbHVlICYmIHBhdGgpXHJcbiAgICAgICAgICAgID8gT2JqLmdldCh0aGlzLnZhbHVlLCBwYXRoLCBkZWZhdWx0VmFsdWUpXHJcbiAgICAgICAgICAgIDogdGhpcy52YWx1ZVxyXG4gICAgfVxyXG5cclxuICAgIHRyaW0ocGF0aCkge1xyXG4gICAgICAgIGlmIChwYXRoKSB7XHJcbiAgICAgICAgICAgIE9iai50cmltKHRoaXMudmFsdWUsIHBhdGgpXHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy52YWx1ZSA9IHt9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0aGlzXHJcbiAgICB9XHJcblxyXG4gICAgLy8gbG9jYWwgc3RvcmFnZVxyXG4gICAgLy9cclxuICAgIHNhdmUoKSB7XHJcbiAgICAgICAgdGhpcy5zdG9yZS5zZXRJdGVtKHRoaXMuaWQsIEpTT04uc3RyaW5naWZ5KHRoaXMudmFsdWUpKVxyXG4gICAgICAgIHJldHVybiB0aGlzXHJcbiAgICB9XHJcblxyXG4gICAgbG9hZCgpIHtcclxuICAgICAgICBsZXQgcyA9IHRoaXMuc3RvcmUuZ2V0SXRlbSh0aGlzLmlkKVxyXG4gICAgICAgIHRoaXMudmFsdWUgPSBPYmoucGFyc2UocykgfHwge31cclxuICAgICAgICByZXR1cm4gdGhpc1xyXG4gICAgfVxyXG5cclxuICAgIHJlc2V0KCkge1xyXG4gICAgICAgIHRoaXMudmFsdWUgPSB7fVxyXG4gICAgICAgIHRoaXMuc3RvcmUucmVtb3ZlSXRlbSh0aGlzLmlkKVxyXG4gICAgICAgIHJldHVybiB0aGlzXHJcbiAgICB9XHJcbn1cclxuXHJcbi8vIHZhciBzdG9yZSA9IG5ldyBTdG9yZSgnd2ViJylcclxuLy8gc3RvcmUubG9hZCgpXHJcbi8vIGdsb2JhbFRoaXMuYWRkRXZlbnRMaXN0ZW5lcignYmVmb3JldW5sb2FkJywgKCkgPT4gc3RvcmUuc2F2ZSgpKSIsIi8vIHdyYXBzIGZ1bmN0aW9uL29iamVjdC9zdHJpbmcvd29ya2VyXG4vL1xuZXhwb3J0IGxldCB3cmFwID0gKHcpID0+IHtcbiAgICBpZiAodyBpbnN0YW5jZW9mIFdvcmtlcikge1xuICAgICAgICByZXR1cm4gd3JhcF93b3JrZXIodylcbiAgICB9XG5cbiAgICBsZXQgc3JjXG4gICAgaWYgKHR5cGVvZih3KT09PSdmdW5jdGlvbicpIHtcbiAgICAgICAgc3JjID0gYCgke3Byb3h5fSkoJHt3fSlgXG4gICAgfVxuICAgIGVsc2UgaWYgKHcgaW5zdGFuY2VvZiBPYmplY3QgJiYgdy5jb25zdHJ1Y3Rvcj09PU9iamVjdCkge1xuICAgICAgICBzcmMgPSBgKCR7cHJveHl9KSgke3RvU3JjKHcpfSlgXG4gICAgfVxuICAgIGVsc2UgaWYgKHR5cGVvZih3KT09PSdzdHJpbmcnKSB7XG4gICAgICAgIHNyYyA9IHdcbiAgICB9XG4gICAgaWYgKCFzcmMpIHRocm93IG5ldyBFcnJvcigndW5zdXBwb3J0ZWQgdHlwZScpXG5cbiAgICBsZXQgYiA9IG5ldyBCbG9iKCBbc3JjXSxcbiAgICAgICAgeyB0eXBlOiAndGV4dC9qYXZhc2NyaXB0JyB9KVxuICAgIGxldCB1ID0gVVJMLmNyZWF0ZU9iamVjdFVSTChiKVxuICAgIGxldCBhID0gbmV3IFdvcmtlcih1LFxuICAgICAgICBcIkRlbm9cIiBpbiBnbG9iYWxUaGlzXG4gICAgICAgID8ge3R5cGU6J21vZHVsZSd9XG4gICAgICAgIDoge30pXG5cbiAgICByZXR1cm4gd3JhcF93b3JrZXIoYSlcbn1cblxuLy8gb2JqZWN0IC0+IHNvdXJjZS1zdHJpbmdcbi8vXG5sZXQgdG9TcmMgPSAob2JqKSA9PiB7XG4gICAgcmV0dXJuIGB7ICR7XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKG9iailcbiAgICAgICAgLm1hcCggKFtrZXksIHZhbF0pID0+IHtcbiAgICAgICAgICAgIHJldHVybiBgJHtrZXl9OiR7XG4gICAgICAgICAgICAgICAgdHlwZW9mKHZhbCk9PT0nZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgPyB2YWwrJydcbiAgICAgICAgICAgICAgICA6IEpTT04uc3RyaW5naWZ5KHZhbClcbiAgICAgICAgICAgIH1gXG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCcsJylcbiAgICB9IH1gXG59XG5cbi8vIHdyYXBzIGEgd29ya2VyXG4vL1xuZXhwb3J0IGxldCB3cmFwX3dvcmtlciA9ICh3KSA9PiB7XG4gICAgbGV0IF9pZCA9IDBcbiAgICBsZXQgX2NiID0ge31cblxuICAgIGxldCBmbiA9ICguLi5hcmdzKSA9PiBuZXcgUHJvbWlzZSgob2ssIGVycikgPT4ge1xuICAgICAgICBsZXQgaWQgPSArK19pZFxuICAgICAgICB3LnBvc3RNZXNzYWdlKHtpZCwgYXJnc30pXG4gICAgICAgIF9jYltpZF0gPSB7b2ssIGVycn1cbiAgICB9KVxuXG4gICAgdy5vbm1lc3NhZ2UgPSAoZSkgPT4ge1xuICAgICAgICBpZiAoIWUpIHJldHVyblxuICAgICAgICBsZXQgeyBpZCwgZGF0YSwgZXJyb3IgfSA9IGUuZGF0YSB8fCB7fVxuICAgICAgICBpZiAoIWlkKSByZXR1cm5cblxuICAgICAgICBsZXQgY2IgPSBfY2JbaWRdXG4gICAgICAgIGlmICghY2IpIHJldHVyblxuICAgICAgICBkZWxldGUgX2NiW2lkXVxuXG4gICAgICAgIGxldCB7IG9rLCBlcnIgfSA9IGNiXG4gICAgICAgIHJldHVybiBlcnJvclxuICAgICAgICAgICAgPyBlcnIoZXJyb3IpXG4gICAgICAgICAgICA6IG9rKGRhdGEpXG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBQcm94eShmbiwge1xuICAgICAgICBnZXQoXywgcHJvcCkge1xuICAgICAgICAgICAgaWYgKHByb3AgPT09ICdfX3dvcmtlcicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gd1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gKC4uLmFyZ3MpID0+IG5ldyBQcm9taXNlKChvaywgZXJyKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGlkID0gKytfaWRcbiAgICAgICAgICAgICAgICB3LnBvc3RNZXNzYWdlKHtpZCwgZm46cHJvcCwgYXJnc30pXG4gICAgICAgICAgICAgICAgX2NiW2lkXSA9IHtvaywgZXJyfVxuICAgICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgIH0pXG59XG5cblxuLy8gcHJveHkgd29ya2VyIGZ1bmN0aW9uL29iamVjdFxuLy9cbmV4cG9ydCBsZXQgcHJveHkgPSAoYXJnLCBzY29wZT1udWxsKSAgPT4ge1xuICAgIGxldCBGbiA9IHt9XG4gICAgaWYgKCh0eXBlb2YgYXJnID09PSAnZnVuY3Rpb24nKSkge1xuICAgICAgICBGbi5fID0gYXJnXG4gICAgfVxuICAgIGVsc2UgaWYgKFxuICAgICAgICBhcmcgIT09IG51bGxcbiAgICAgICAgJiYgYXJnIGluc3RhbmNlb2YgT2JqZWN0XG4gICAgICAgICYmIGFyZy5jb25zdHJ1Y3RvciA9PT0gT2JqZWN0XG4gICAgKSB7XG4gICAgICAgIEZuID0gYXJnXG4gICAgfVxuICAgIGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3BsZWFzZSBwYXNzIGZ1bmN0aW9uL29iamVjdCcpXG4gICAgfVxuXG4gICAgZ2xvYmFsVGhpcy5vbm1lc3NhZ2UgPSBmdW5jdGlvbihlKSB7XG4gICAgICAgIGlmICghZSkgcmV0dXJuXG4gICAgICAgIGxldCB7IGlkLCBmbj0nXycsIGFyZ3MgfSA9IGUuZGF0YSB8fCB7fVxuXG4gICAgICAgIHsoYXN5bmMgKCk9PiB7XG4gICAgICAgICAgICB2YXIgcCA9IHsgaWQgfVxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBpZiAoIUZuLmhhc093blByb3BlcnR5KGZuKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3VuZGVmaW5lZCBwcm9wZXJ0eScpXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGYgPSBGbltmbl1cbiAgICAgICAgICAgICAgICBsZXQgaXNGbiA9IHR5cGVvZiBmID09PSAnZnVuY3Rpb24nXG4gICAgICAgICAgICAgICAgcC5kYXRhID0gaXNGblxuICAgICAgICAgICAgICAgICAgICA/IGF3YWl0IChmLmFwcGx5KHNjb3BlIHx8IEZuLCBhcmdzKSlcbiAgICAgICAgICAgICAgICAgICAgOiBmXG5cbiAgICAgICAgICAgICAgICBpZiAoIWlzRm4gJiYgYXJncy5sZW5ndGg+MCkge1xuICAgICAgICAgICAgICAgICAgICBGbltmbl0gPSBhcmdzWzBdXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB9IGNhdGNoKGUpIHtcbiAgICAgICAgICAgICAgICBwLmVycm9yID0gZVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZ2xvYmFsVGhpcy5wb3N0TWVzc2FnZShwKVxuICAgICAgICB9KSgpfVxuICAgIH1cbn1cbiIsIi8vIGRlbm8gY2FjaGUgLXIgbW9kLmpzXHJcbi8vIGRlbm8gcnVuIC1BIGJ1aWxkLmpzXHJcblxyXG4vLyB3cmFwcyBmZXRjaFxyXG4vL1xyXG5leHBvcnQge1xyXG4gICAgYWpheCxcclxuICAgIGFqYXhEZWZhdWx0cyxcclxuICAgIGFqYXhGbixcclxufSBmcm9tICdodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20va29kZW1hNS9hamF4LmpzL21haW4vbW9kLmpzJ1xyXG5cclxuXHJcbi8vIGZvciBjcmVhdGluZyB3ZWItY29tcG9uZW50XHJcbi8vXHJcbmV4cG9ydCB7XHJcbiAgICBjdXN0b21FbGVtZW50LFxyXG4gICAgY3VzdG9tRWxlbWVudERlZmF1bHRzLFxyXG4gICAgdG1wbCxcclxuICAgIHdpcmVFbGVtZW50LFxyXG59IGZyb20gJ2h0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L2N1c3RvbS1lbGVtZW50LmpzL21haW4vbW9kLmpzJ1xyXG5cclxuZXhwb3J0IHtcclxuICAgIHdpcmUsXHJcbn0gZnJvbSAnaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL2tvZGVtYTUvd2lyZS5qcy9tYWluL21vZC5qcydcclxuXHJcblxyXG4vLyBwdWJsaXNoLXN1YnNjcmliZSB1c2luZyBicm9hZGNhc3QgY2hhbm5lbFxyXG4vL1xyXG5leHBvcnQge1xyXG4gICAgUHViU3ViLFxyXG59IGZyb20gJ2h0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3B1YnN1Yi5qcy9tYWluL21vZC5qcydcclxuXHJcblxyXG4vLyBjYWNoZSB0byBsb2NhbC1zdG9yYWdlXHJcbi8vXHJcbmV4cG9ydCB7XHJcbiAgICBTdG9yZSxcclxuICAgIC8vIHV0aWxpdHkgZnVuY3Rpb25zXHJcbiAgICBBcnIsXHJcbiAgICBJcyxcclxuICAgIE9iaixcclxuICAgIEZuLFxyXG59IGZyb20gJ2h0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3N0b3JlLmpzL21haW4vbW9kLmpzJ1xyXG5cclxuXHJcbi8vIFdhYWYud3JhcCBvYmplY3Qvc3RyaW5nL2Z1bmN0aW9uL3dvcmtlciBhcyB3ZWItd29ya2VyXHJcbi8vIFdhYWYucHJveHkgZm9yIHByb3h5IHRvIGNvbW11bmljYXRlIHdpdGggd3JhcHBlZCB3ZWItd29ya2VyXHJcbi8vXHJcbmV4cG9ydCAqIGFzIFdhYWZcclxuICAgIGZyb20gJ2h0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS9rb2RlbWE1L3dhYWYuanMvbWFpbi9tb2QuanMnXHJcblxyXG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQ0EsSUFBSSxjQUFjLENBQUMsTUFBTSxPQUFTO0lBQzlCLE9BQU87UUFDSCxLQUFLO1lBQU8sT0FBTztRQUNuQixLQUFLO1lBQVEsT0FBTyxPQUFPLEtBQUssUUFBUSxLQUFLLElBQUk7UUFDakQsS0FBSztZQUFRLE9BQU8sS0FBSyxTQUFTLENBQUM7SUFDdkM7SUFFQSxNQUFNLElBQUksTUFBTSw2QkFBNEI7QUFDaEQ7QUFFQSxJQUFJLGtCQUFrQixDQUFDLEtBQUssT0FBUztJQUNqQyxPQUFPO1FBQ0gsS0FBSztZQUFlLE9BQU8sSUFBSSxXQUFXO1FBQzFDLEtBQUs7WUFBUSxPQUFPLElBQUksSUFBSTtRQUM1QixLQUFLO1lBQVksT0FBTyxJQUFJLFFBQVE7UUFDcEMsS0FBSztZQUFRLE9BQU8sSUFBSSxJQUFJO1FBQzVCLEtBQUs7WUFBUSxPQUFPLElBQUksSUFBSTtJQUNoQztJQUVBLE1BQU0sSUFBSSxNQUFNLHlCQUF3QjtBQUM1QztBQUVPLElBQUksZUFBZTtJQUN0QixVQUFTO0lBQ1QsU0FBUztJQUVULFFBQVE7SUFDUixTQUFTO1FBQ0wsZ0JBQWdCO0lBQ3BCO0lBRUEsYUFBYTtJQUNiLGNBQWM7QUFDbEI7QUFHTyxTQUFTLEtBQU0sRUFDbEIsSUFBRyxFQUNILEtBQUksRUFDSixLQUFJLEVBR0osT0FBUSxDQUFDLElBQU0sRUFBQyxFQUNoQixRQUFTLENBQUMsSUFBTSxFQUFDLEVBRWpCLFVBQVcsYUFBYSxRQUFRLENBQUEsRUFD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
