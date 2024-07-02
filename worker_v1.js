// _worker.js
// Docker 镜像仓库主机地址
const HUB_HOST = 'registry-1.docker.io';
// Docker 认证服务器地址
const AUTH_URL = 'https://auth.docker.io';
// 自定义的工作服务器地址
const WORKERS_URL = 'https://your.domain/';
// 根据主机名选择对应的上游地址
const routeByHosts = (host) => {
  const routes = {
    // 生产环境
    "quay": "quay.io",
    "gcr": "gcr.io",
    "k8s-gcr": "k8s.gcr.io",
    "k8s": "registry.k8s.io",
    "ghcr": "ghcr.io",
    "cloudsmith": "docker.cloudsmith.io",
    // 测试环境
    "test": HUB_HOST,
  };
  return [routes[host] || HUB_HOST, !(host in routes)];
};
const PREFLIGHT_INIT = {
  headers: {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
    'access-control-max-age': '1728000',
  },
};
const makeRes = (body, status = 200, headers = {}) => {
  headers['access-control-allow-origin'] = '*';
  return new Response(body, { status, headers });
};
const newUrl = (urlStr) => {
  try {
    return new URL(urlStr);
  } catch (err) {
    return null;
  }
};
const isUUID = (uuid) => /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
const nginxPage = `
<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
  body {
    width: 35em;
    margin: 0 auto;
    font-family: Tahoma, Verdana, Arial, sans-serif;
  }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
<p>For online documentation and support please refer to <a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at <a href="http://nginx.com/">nginx.com</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;
export default {
  async fetch(request, env, ctx) {
    const getReqHeader = (key) => request.headers.get(key);
    let url = new URL(request.url);
    const pathname = url.pathname;
    const hostname = url.searchParams.get('hubhost') || url.hostname;
    const hostTop = hostname.split('.')[0];
    const [hubHost, fakePage] = routeByHosts(hostTop);
    const isUuid = isUUID(pathname.split('/')[1]?.split('/')[0]);
    const conditions = [
      isUuid,
      pathname.includes('/_'),
      pathname.includes('/r'),
      pathname.includes('/v2/user'),
      pathname.includes('/v2/orgs'),
      pathname.includes('/v2/_catalog'),
      pathname.includes('/v2/categories'),
      pathname.includes('/v2/feature-flags'),
      pathname.includes('search'),
      pathname.includes('source'),
      pathname === '/',
      pathname === '/favicon.ico',
      pathname === '/auth/profile',
    ];
    if (conditions.some(Boolean) && (fakePage || hostTop === 'docker')) {
      if (env.URL302) {
        return Response.redirect(env.URL302, 302);
      } else if (env.URL) {
        if (env.URL.toLowerCase() === 'nginx') {
          return new Response(nginxPage, {
            headers: {'Content-Type': 'text/html; charset=UTF-8'},
          });
        } else {
          return fetch(new Request(env.URL, request));
        }
      }
      const newUrl = new URL("https://registry.hub.docker.com" + pathname + url.search);
      const headers = new Headers(request.headers);
      headers.set('Host', 'registry.hub.docker.com');
      const newRequest = new Request(newUrl, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? null : await request.blob(),
        redirect: 'follow',
      });
      return fetch(newRequest);
    }
    if (!/%2F/.test(url.search) && /%3A/.test(url.toString())) {
      url = new URL(url.toString().replace(/%3A(?=.*?&)/, '%3Alibrary%2F'));
    }
    if (url.pathname.includes('/token')) {
      const tokenParameter = {
        headers: {
          'Host': 'auth.docker.io',
          'User-Agent': getReqHeader("User-Agent"),
          'Accept': getReqHeader("Accept"),
          'Accept-Language': getReqHeader("Accept-Language"),
          'Accept-Encoding': getReqHeader("Accept-Encoding"),
          'Connection': 'keep-alive',
          'Cache-Control': 'max-age=0',
        },
      };
      return fetch(new Request(AUTH_URL + url.pathname + url.search, request), tokenParameter);
    }
    if (/^\/v2\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname) && !/^\/v2\/library/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/v2\//, '/v2/library/');
    }
    url.hostname = hubHost;
    const parameter = {
      headers: {
        'Host': hubHost,
        'User-Agent': getReqHeader("User-Agent"),
        'Accept': getReqHeader("Accept"),
        'Accept-Language': getReqHeader("Accept-Language"),
        'Accept-Encoding': getReqHeader("Accept-Encoding"),
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0',
      },
      cacheTtl: 3600,
    };
    if (request.headers.has("Authorization")) {
      parameter.headers.Authorization = getReqHeader("Authorization");
    }
    const originalResponse = await fetch(new Request(url, request), parameter);
    const originalText = originalResponse.clone().body;
    const responseHeaders = new Headers(originalResponse.headers);
    const status = originalResponse.status;
    if (responseHeaders.get("Www-Authenticate")) {
      responseHeaders.set("Www-Authenticate", responseHeaders.get("Www-Authenticate").replace(new RegExp(AUTH_URL, 'g'), WORKERS_URL));
    }
    if (responseHeaders.get("Location")) {
      return httpHandler(request, responseHeaders.get("Location"));
    }
    return new Response(originalText, {
      status,
      headers: responseHeaders,
    });
  },
};
const httpHandler = (req, pathname) => {
  const reqHdrRaw = req.headers;
  if (req.method === 'OPTIONS' && reqHdrRaw.has('access-control-request-headers')) {
    return new Response(null, PREFLIGHT_INIT);
  }
  const urlObj = newUrl(pathname);
  const reqInit = {
    method: req.method,
    headers: new Headers(reqHdrRaw),
    redirect: 'follow',
    body: req.body,
  };
  return proxy(urlObj, reqInit);
};
const proxy = async (urlObj, reqInit) => {
  const res = await fetch(urlObj.href, reqInit);
  const resHdrOld = res.headers;
  const resHdrNew = new Headers(resHdrOld);
  resHdrNew.set('access-control-expose-headers', '*');
  resHdrNew.set('access-control-allow-origin', '*');
  resHdrNew.set('Cache-Control', 'max-age=1500');
  ['content-security-policy', 'content-security-policy-report-only', 'clear-site-data'].forEach(h => resHdrNew.delete(h));
  return new Response(res.body, {
    status: res.status,
    headers: resHdrNew,
  });
};
