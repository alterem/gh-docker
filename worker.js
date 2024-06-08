'use strict';
const HUB_HOST = 'registry-1.docker.io';
const AUTH_URL = 'https://auth.docker.io';
const WORKERS_URL = 'https://your.domain';
/**
 * static files (404.html, sw.js, conf.js)
 */
/** @type {RequestInit} */
const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
};
/**
 * @param {any} body
 * @param {number} [status=200]
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*';
    return new Response(body, { status, headers });
}
/**
 * @param {string} urlStr
 * @returns {URL|null}
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr);
    } catch (err) {
        return null;
    }
}
addEventListener('fetch', e => {
    e.respondWith(
        fetchHandler(e).catch(err => makeRes('cfworker error:\n' + err.stack, 502))
    );
});
/**
 * @param {FetchEvent} e
 */
async function fetchHandler(e) {
    const req = e.request;
    const url = new URL(req.url);
    if (url.pathname === '/token') {
        return handleTokenRequest(req, url);
    }
    url.hostname = HUB_HOST;
    const headers = createHeaders(req, HUB_HOST);
    if (req.headers.has('Authorization')) {
        headers.Authorization = req.headers.get('Authorization');
    }
    const response = await fetch(new Request(url, req), { headers, cacheTtl: 3600 });
    return handleResponse(response, req);
}
/**
 * @param {Request} req
 * @param {URL} url
 * @returns {Promise<Response>}
 */
function handleTokenRequest(req, url) {
    const tokenUrl = AUTH_URL + url.pathname + url.search;
    const headers = createHeaders(req, 'auth.docker.io');
    return fetch(new Request(tokenUrl, req), { headers });
}
/**
 * @param {Request} req
 * @param {string} host
 * @returns {Headers}
 */
function createHeaders(req, host) {
    return {
        'Host': host,
        'User-Agent': req.headers.get('User-Agent'),
        'Accept': req.headers.get('Accept'),
        'Accept-Language': req.headers.get('Accept-Language'),
        'Accept-Encoding': req.headers.get('Accept-Encoding'),
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0'
    };
}
/**
 * @param {Response} response
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function handleResponse(response, req) {
    const headers = new Headers(response.headers);
    const status = response.status;
    if (headers.has('Www-Authenticate')) {
        const auth = headers.get('Www-Authenticate');
        const re = new RegExp(AUTH_URL, 'g');
        headers.set('Www-Authenticate', auth.replace(re, WORKERS_URL));
    }
    if (headers.has('Location')) {
        return httpHandler(req, headers.get('Location'));
    }
    headers.set('access-control-expose-headers', '*');
    headers.set('access-control-allow-origin', '*');
    headers.set('Cache-Control', 'max-age=1500');
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    headers.delete('clear-site-data');
    return new Response(response.body, { status, headers });
}
/**
 * @param {Request} req
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
function httpHandler(req, pathname) {
    if (req.method === 'OPTIONS' && req.headers.has('access-control-request-headers')) {
        return new Response(null, PREFLIGHT_INIT);
    }
    const url = newUrl(pathname);
    if (!url) {
        return makeRes('Invalid URL', 400);
    }
    const reqInit = {
        method: req.method,
        headers: req.headers,
        redirect: 'follow',
        body: req.body
    };
    return proxy(url, reqInit);
}
/**
 * @param {URL} url
 * @param {RequestInit} reqInit
 * @returns {Promise<Response>}
 */
async function proxy(url, reqInit) {
    const res = await fetch(url.href, reqInit);
    const headers = new Headers(res.headers);
    headers.set('access-control-expose-headers', '*');
    headers.set('access-control-allow-origin', '*');
    headers.set('Cache-Control', 'max-age=1500');
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    headers.delete('clear-site-data');
    return new Response(res.body, {
        status: res.status,
        headers
    });
}
