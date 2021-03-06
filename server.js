"use strict";

const handler = require('./handler.js');
const Logger = require('./logger.js');
const util = require('./util.js');
const http = require('http');
const log = new Logger('server');

const DEFAULTS = {
    listenAddress: '127.0.0.1',
    listenPort: 56789,
    clientTimeout: 20000,
    maxConnections: 20,
    cors: '*',
}

/*
 * Handlers internal representation:
 * {
 *     GET: {
 *         entity: {
 *             '*': {
 *                 '*': {
 *                     '.': 'handler object for /entity/x/y' },
 *                     databases: 'handler object for /entity/x/y/databases' },
 *                     devices: 'handler object /entity/x/y/devices' },
 *                 }
 *             }
 *         }
 *     }
 * }
 */

/* Custom property Symbols added to the client socket objects.
 * ES6 Symbols are used to avoid naming conflicts. */
const SOCK_NAME = Symbol('socketName');

function parseUrl(url) {
    var out = {}
    var qmark = url.indexOf('?');
    if (qmark > -1) {
        out.path = url.substr(0, qmark);
        out.qs = Object.fromEntries(new URLSearchParams(url.substr(qmark + 1)));
    }
    else {
        out.path = url;
        out.qs = {};
    }
    return out;
}

function Server(options) {
    options = util.omerge({}, DEFAULTS, options);

    var self = this;
    var server = http.createServer();
    var sockets = {};
    var connections = 0;
    var handlers = {};

    function onError(err) {
        log.error('Server error:', err.message);
        self.stop();
    }

    function onListening() {
        var addr = this.address();
        log.info(`Server listening on ${addr.address}:${addr.port}`);
    }

    function onConnection(sock) {
        /* Name the socket, for shortcut in logs and mostly because the local
         * information isn't available anymore after close. */
        sock[SOCK_NAME] = sock.remoteAddress + ':' + sock.remotePort + ' ' +
            sock.localAddress + ':' + sock.localPort;
        connections++;
        sockets[sock[SOCK_NAME]] = sock;
        sock.on('close', onConnectionClose);
        log.debug(`${sock[SOCK_NAME]}, connection:`,
                  `${connections}/${options.maxConnections}`);
    }

    function onConnectionClose() {
        log.debug(`${this[SOCK_NAME]}, connection closed`);
        connections--;
        delete sockets[this[SOCK_NAME]];
    }

    function onClientError(err, sock) {
        /* Some clients may send RST instead of a "clean" FIN. This may be
         * to avoid time waits (port starvation on proxies).
         * It produces annoying logs so ignore ECONNRESET until we
         * find something better. */
        if (err.code != 'ECONNRESET')
            log.error(`${sock[SOCK_NAME]}, client error. ${util.err2str(err)}`);
        sock.destroy();
    }

    function onTimeout(sock) {
        log.debug(`${sock[SOCK_NAME]}, client timeout:`,
                  `${options.clientTimeout} ms`);
        sock.destroy();
    }

    function onRequestError(err) {
        log.error(`${this.socket[SOCK_NAME]}, request error.`,
            util.err2str(err));
    }

    async function onRequest(req, res) {
        req.on('error', onRequestError);
        log.debug(`${req.socket[SOCK_NAME]}, new request:`,
                 `"${req.method} ${req.url} HTTP/${req.httpVersion}"`);

        let start = new Date().getTime(), elapsed = 0;
        let url = parseUrl(req.url);
        let h = getHandler(req.method, url.path);

        if (options.cors)
            res.setHeader('Access-Control-Allow-Origin', options.cors);

        if (h.handler) {
            url.params = h.params;
            let ctx = { req, res, url };
            /* assume request handlers are proper objects */
            let [e, result] = await util.safePromise(h.handler.handle(ctx));
            if (e)
                log.error(`${req.socket[SOCK_NAME]}, handler error.`, e);

            /* try to cleanup */
            if (res.headersSent) {
                if (!res.writableEnded)
                    res.end()
            }
            else {
                res.writeHead(500);
                res.end()
            }
        }
        else {
            res.writeHead(404);
            res.end();
        }

        elapsed = new Date().getTime() - start;
        log.info(`${req.socket[SOCK_NAME]}, end request:`,
                 `${res.statusCode} ${elapsed}`,
                 `"${req.method} ${req.url} HTTP/${req.httpVersion}"`);
    }

    function onClose() {
        log.info('Server close');
    }

    function start() {
        if (!server.listening)
            server.listen(options.listenPort, options.listenAddress);
    }

    function stop() {
        if (!server.listening)
            return;
        server.close();
        for (let i in sockets)
            sockets[i].destroy();
    }

    /* Register a <handler> to a request <method> + <url>. The <url> must be
     * made of path components without a query string. The handler object is
     * expected to be an instance of Handler. When a path component of
     * <uri> is single character '*', it becomes a parameter.
     */
    function setHandler(method, url, handler) {
        if (!handlers[method])
            handlers[method] = {};

        var pathComponents = url.split('/');
        var pos = handlers[method];

        for (let i = 0, l = pathComponents.length; i < l; i++) {
            let c = pathComponents[i];

            if (c.length == 0)
                continue; /* pass empty component */

            if (pos[c]) { /* node or handler exists */
                if (i == l-1) { /* last */
                    if (typeof pos[c] == 'object')
                        pos[c]['.'] = handler; /* may override */
                    else
                    return; /* done */
                        pos[c] = handler; /* override */
                }
                else if (typeof pos[c] != 'object') {
                    pos[c] = { '.': pos[c] }; /* convert to node */
                }
            }
            /* node does not exist */
            else if (i == l-1) { /* last */
                pos[c] = handler;
                return; /* done */
            }
            else
                pos[c] = {} /* intermediate */

            pos = pos[c]; /* move forward */
        }

        /* special case for root */
        pos['.'] = handler;
    }

    /* Find the handler previously registered to process a request <method> +
     * <url>. The <url> passed to this function must not include the query
     * string. Returns an object with properties:
     * - "handler", the registered handler, or null of none was found
     * - "params", an array of strings representing the wildcard parameter
     *   values extracted from <url>.
     */
    function getHandler(method, url) {
        var out = { handler: null, params: [] }
        var pathComponents = url.split('/');

        if (pathComponents[0] != '')
            return out; /* must start with slash */
        if (!handlers[method])
            return out; /* method not registered */

        var pos = handlers[method];

        for (let c of pathComponents) {
            if (c.length == 0)
                continue; /* pass empty component */

            if (pos[c]) {
                pos = pos[c] /* pass match */
                continue;
            }
            if (pos['*']) {
                out.params.push(c);
                pos = pos['*']; /* pass parameter */
                continue;
            }

            return out; /* not registered */
        }

        if (util.isObject(pos)) {
            if (!pos['.'])
                return out; /* not registered */
            pos = pos['.'];
        }

        if (pos instanceof handler.Handler)
            out.handler = pos; /* found handler */
        return out
    }

    server.on('error', onError);
    server.on('connection', onConnection);
    server.on('listening', onListening);
    server.on('request', onRequest);
    server.on('clientError', onClientError);
    server.on('timeout', onTimeout);
    server.on('close', onClose);

    server.timeout = options.clientTimeout;
    server.keepAliveTimeout = options.clientTimeout;
    server.maxConnections = options.maxConnections;

    /* Exposed methods */
    this.start = start;
    this.stop = stop;
    this.setHandler = setHandler;
}

module.exports = Server;
