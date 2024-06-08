'use strict';
const HUB_HOST = 'registry-1.docker.io';
const AUTH_URL = 'https://auth.docker.io';
const WORKERS_URL = 'https://你的域名';
const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/';
const PREFIX = '/';
const Config = { jsdelivr: 0 };
const whiteList = [];
const GITHUB_PATTERNS = [
    /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i,
    /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i,
    /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i,
    /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i,
    /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i,
    /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i
];
const COMMON_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, TRACE, DELETE, HEAD, OPTIONS',
    'access-control-max-age': '1728000',
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
    const { request } = event;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/token') || url.pathname.startsWith('/v2')) {
        return handleDockerProxy(request, url);
    }
    if (url.pathname.startsWith(PREFIX)) {
        return handleGitHubProxy(request, url);
    }
    return makeResponse('Not Found', 404);
}
/**
 * Handle token requests and Docker proxy.
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleDockerProxy(request, url, env) {
    const headers = {
        'Host': url.pathname === '/token' ? 'auth.docker.io' : HUB_HOST,
        'User-Agent': request.headers.get('User-Agent'),
        'Accept': request.headers.get('Accept'),
        'Accept-Language': request.headers.get('Accept-Language'),
        'Accept-Encoding': request.headers.get('Accept-Encoding'),
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0'
    };
    if (request.headers.has('Authorization')) {
        headers['Authorization'] = request.headers.get('Authorization');
    }
    if (url.pathname === '/token') {
        return fetch(url.href, { headers });
    }
    url.hostname = HUB_HOST;
    const response = await fetch(url.href, { headers });
    const responseHeaders = new Headers(response.headers);
    const status = response.status;
    if (responseHeaders.get('Www-Authenticate')) {
        responseHeaders.set('Www-Authenticate', responseHeaders.get('Www-Authenticate').replace(new RegExp(AUTH_URL, 'g'), env.WORKERS_URL || WORKERS_URL));
    }
    if (responseHeaders.get('Location')) {
        return handleHttpRedirect(request, responseHeaders.get('Location'));
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
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleGitHubProxy(request, url) {
    let path = url.searchParams.get('q');
    if (path) {
        return Response.redirect('https://' + url.host + PREFIX + path, 301);
    }
    path = url.href.substring(url.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://');
    if (checkUrl(path)) {
        return httpHandler(request, path);
    } else if (path.search(GITHUB_PATTERNS[1]) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh');
            return Response.redirect(newUrl, 302);
        } else {
            path = path.replace('/blob/', '/raw/');
            return httpHandler(request, path);
        }
    } else if (path.search(GITHUB_PATTERNS[3]) === 0) {
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
    return GITHUB_PATTERNS.some(exp => url.search(exp) === 0);
}
/**
 * Handle HTTP redirects.
 * @param {Request} request
 * @param {string} location
 * @returns {Promise<Response>}
 */
async function handleHttpRedirect(request, location) {
    const url = createURL(location);
    if (!url) {
        return makeResponse('Invalid URL', 400);
    }
    return proxyRequest(url, request);
}
/**
 * Handle HTTP requests.
 * @param {Request} request
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
async function httpHandler(request, pathname) {
    if (request.method === 'OPTIONS' && request.headers.has('access-control-request-headers')) {
        return new Response(null, { status: 204, headers: COMMON_HEADERS });
    }
    const headers = new Headers(request.headers);
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
    return proxyRequest(url, { method: request.method, headers, body: request.body });
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
