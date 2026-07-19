// Monorepo-aware Metro config.
// - watchFolders extends Metro's file watcher to the monorepo root so changes
//   in /packages/* and root-hoisted deps are picked up.
// - nodeModulesPaths lets Metro resolve packages from both the app's local
//   node_modules and the root-hoisted node_modules.
// - disableHierarchicalLookup prevents Metro from walking parent directories
//   beyond the explicit paths above (avoids duplicate-package surprises with
//   npm-hoisted deps).
const path = require('path');
const https = require('https');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// The Thought Stream prototype is served from a private Tailscale origin, but
// its real production APIs only allow their public browser origins through
// CORS. Keep this fixed-target proxy in the development server so prototype
// evaluation can use the existing production test accounts without changing
// production CORS or OAuth configuration.
const prototypeProxyRoutes = [
  {
    prefix: '/__thought-stream-proxy/openchat',
    target: new URL('https://chat.globalbr.ai'),
    allowedPath: /^\/(?:api\/|socket\.io(?:\/|$))/,
  },
  {
    prefix: '/__thought-stream-proxy/noos',
    target: new URL('https://globalbr.ai'),
    allowedPath: /^\/api\/auth\/login$/,
  },
];

function proxyThoughtStreamRequest(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  const route = prototypeProxyRoutes.find(({ prefix }) =>
    requestUrl.pathname.startsWith(`${prefix}/`)
  );

  if (!route) return false;

  const upstreamPath = requestUrl.pathname.slice(route.prefix.length);
  if (!route.allowedPath.test(upstreamPath)) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Prototype proxy path not allowed' }));
    return true;
  }

  const upstream = https.request(
    {
      protocol: route.target.protocol,
      hostname: route.target.hostname,
      port: route.target.port || 443,
      method: req.method,
      path: `${upstreamPath}${requestUrl.search}`,
      headers: { ...req.headers, host: route.target.host },
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    }
  );

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Prototype API proxy failed' }));
  });
  req.pipe(upstream);
  return true;
}

const defaultEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const enhancedMiddleware = defaultEnhanceMiddleware
    ? defaultEnhanceMiddleware(middleware, server)
    : middleware;

  return (req, res, next) => {
    if (proxyThoughtStreamRequest(req, res)) return;
    return enhancedMiddleware(req, res, next);
  };
};

module.exports = config;
