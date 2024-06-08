'use strict';

const HUB_HOST = 'registry-1.docker.io';
const AUTH_URL = 'https://auth.docker.io';
const WORKERS_URL = 'https://your.domain';
const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/';
const PREFIX = '/';
const Config = { jsdelivr: 0 };
const whiteList = [];

const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i;
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i;
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i;
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i;
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i;
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i;

/** @type {RequestInit} */
const PREFLIGHT_INIT = {
    // @ts-ignore
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, TRACE, DELETE, HEAD, OPTIONS',
        'access-control-max-age': '1728000',
    }),
};

/**
 * Create a new response.
 * @param {any} body
 * @param {number} [status=200]
 * @param {Object<string, string>} headers
 * @returns {Response}
 */
function makeResponse(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*';
    return new Response(body, { status, headers });
}

/**
 * Create a new URL object.
 * @param {string} urlStr
 * @returns {URL|null}
 */
function createURL(urlStr) {
    try {
        return new URL(urlStr);
    } catch (err) {
        return null;
    }
}

addEventListener('fetch', (event) => {
    event.respondWith(handleFetchEvent(event).catch(err => makeResponse(`cfworker error:\n${err.stack}`, 502)));
});

/**
 * Handle the fetch event.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function handleFetchEvent(event) {
    const req = event.request;
    const url = new URL(req.url);

    if (url.pathname.startsWith('/token') || url.pathname.startsWith('/v2')) {
        return handleDockerProxy(req, url);
    }

    if (url.pathname.startsWith(PREFIX)) {
        return handleGitHubProxy(req, url);
    }

    return makeResponse('Not Found', 404);
}

/**
 * Handle token requests and Docker proxy.
 * @param {Request} req
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleDockerProxy(req, url) {
    if (url.pathname === '/token') {
        const tokenURL = AUTH_URL + url.pathname + url.search;
        const headers = new Headers({
            'Host': 'auth.docker.io',
            'User-Agent': req.headers.get('User-Agent'),
            'Accept': req.headers.get('Accept'),
            'Accept-Language': req.headers.get('Accept-Language'),
            'Accept-Encoding': req.headers.get('Accept-Encoding'),
            'Connection': 'keep-alive',
            'Cache-Control': 'max-age=0'
        });
        return fetch(new Request(tokenURL, req), { headers });
    }

    url.hostname = HUB_HOST;
    const headers = new Headers({
        'Host': HUB_HOST,
        'User-Agent': req.headers.get('User-Agent'),
        'Accept': req.headers.get('Accept'),
        'Accept-Language': req.headers.get('Accept-Language'),
        'Accept-Encoding': req.headers.get('Accept-Encoding'),
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0'
    });

    if (req.headers.has('Authorization')) {
        headers.set('Authorization', req.headers.get('Authorization'));
    }

    const response = await fetch(new Request(url, req), { headers });
    const responseHeaders = new Headers(response.headers);
    const status = response.status;

    if (responseHeaders.get('Www-Authenticate')) {
        const authHeader = responseHeaders.get('Www-Authenticate');
        const re = new RegExp(AUTH_URL, 'g');
        responseHeaders.set('Www-Authenticate', authHeader.replace(re, WORKERS_URL));
    }

    if (responseHeaders.get('Location')) {
        return handleHttpRedirect(req, responseHeaders.get('Location'));
    }

    responseHeaders.set('access-control-expose-headers', '*');
    responseHeaders.set('access-control-allow-origin', '*');
    responseHeaders.set('Cache-Control', 'max-age=1500');
    responseHeaders.delete('Content-Security-Policy');
    responseHeaders.delete('Content-Security-Policy-Report-Only');
    responseHeaders.delete('Clear-Site-Data');

    return new Response(response.body, { status, headers: responseHeaders });
}

/**
 * Handle GitHub proxy requests.
 * @param {Request} req
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleGitHubProxy(req, url) {
    let path = url.searchParams.get('q');
    if (path) {
        return Response.redirect('https://' + url.host + PREFIX + path, 301);
    }
    path = url.href.substr(url.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://');
    if (checkUrl(path)) {
        return httpHandler(req, path);
    } else if (path.search(exp2) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh');
            return Response.redirect(newUrl, 302);
        } else {
            path = path.replace('/blob/', '/raw/');
            return httpHandler(req, path);
        }
    } else if (path.search(exp4) === 0) {
        const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh');
        return Response.redirect(newUrl, 302);
    } else {
        return fetch(ASSET_URL + path);
    }
}

/**
 * Check if the URL matches GitHub patterns.
 * @param {string} url
 * @returns {boolean}
 */
function checkUrl(url) {
    return [exp1, exp2, exp3, exp4, exp5, exp6].some(exp => url.search(exp) === 0);
}

/**
 * Handle HTTP redirects.
 * @param {Request} req
 * @param {string} location
 * @returns {Promise<Response>}
 */
async function handleHttpRedirect(req, location) {
    const url = createURL(location);
    if (!url) {
        return makeResponse('Invalid URL', 400);
    }
    return proxyRequest(url, req);
}

/**
 * Handle HTTP requests.
 * @param {Request} req
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
async function httpHandler(req, pathname) {
    if (req.method === 'OPTIONS' && req.headers.has('access-control-request-headers')) {
        return new Response(null, PREFLIGHT_INIT);
    }

    const headers = new Headers(req.headers);
    let flag = !whiteList.length;
    for (const i of whiteList) {
        if (pathname.includes(i)) {
            flag = true;
            break;
        }
    }
    if (!flag) {
        return new Response('blocked', { status: 403 });
    }

    if (pathname.search(/^https?:\/\//) !== 0) {
        pathname = 'https://' + pathname;
    }

    const url = createURL(pathname);
    return proxyRequest(url, { method: req.method, headers, body: req.body });
}

/**
 * Proxy a request.
 * @param {URL} url
 * @param {RequestInit} reqInit
 * @returns {Promise<Response>}
 */
async function proxyRequest(url, reqInit) {
    const response = await fetch(url.href, reqInit);
    const responseHeaders = new Headers(response.headers);

    if (responseHeaders.has('location')) {
        const location = responseHeaders.get('location');
        if (checkUrl(location)) {
            responseHeaders.set('location', PREFIX + location);
        } else {
            reqInit.redirect = 'follow';
            return proxyRequest(createURL(location), reqInit);
        }
    }

    responseHeaders.set('access-control-expose-headers', '*');
    responseHeaders.set('access-control-allow-origin', '*');
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('content-security-policy-report-only');
    responseHeaders.delete('clear-site-data');

    return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
    });
}
