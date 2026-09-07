'use strict';
// Hostname-based pass-through for the DMS cloud.
//
// The load balancer forwards every *.tui-farms.com hostname to this app on
// port 80. When a request arrives for the DMS cloud's hostname, or for one of
// the cloud's per-node hostnames, it is handed to the cloud process running on
// this same machine instead of the farm site. WebSocket upgrades are passed
// through the same way (the cloud's node tunnel rides on one).
//
// The hostnames come from the environment, never from this repo, so the cloud
// stays unlisted. With nothing configured the proxy is inert and the farm site
// behaves exactly as before.

const httpProxy = require('http-proxy');

function createDmsProxy({ host, nodeHostSuffix, target } = {}) {
  const cloudHost = String(host || '').trim().toLowerCase();
  const suffix = String(nodeHostSuffix || '').trim().toLowerCase();
  if (!cloudHost && !suffix) return null;

  const proxy = httpProxy.createProxyServer({
    target: target || 'http://127.0.0.1:4000',
    ws: true,
    xfwd: true,
  });

  proxy.on('error', (err, req, resOrSocket) => {
    console.error('[dms-proxy] ' + err.message);
    if (!resOrSocket) return;
    if (typeof resOrSocket.writeHead === 'function') {
      if (!resOrSocket.headersSent) {
        resOrSocket.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      resOrSocket.end('The DMS cloud is not running.');
    } else if (typeof resOrSocket.destroy === 'function') {
      resOrSocket.destroy();
    }
  });

  function isDms(req) {
    const h = String((req.headers && req.headers.host) || '').split(':')[0].toLowerCase();
    if (!h) return false;
    if (cloudHost && h === cloudHost) return true;
    if (suffix && h.length > suffix.length && h.endsWith(suffix)) return true;
    return false;
  }

  // Express middleware: must sit ahead of any body parser so the request
  // body streams through untouched.
  function middleware(req, res, next) {
    if (!isDms(req)) return next();
    proxy.web(req, res);
  }

  // http.Server 'upgrade' handler. Only the cloud's hostnames may upgrade;
  // everything else is dropped.
  function upgrade(req, socket, head) {
    if (!isDms(req)) { socket.destroy(); return; }
    proxy.ws(req, socket, head);
  }

  return { middleware, upgrade, isDms };
}

module.exports = { createDmsProxy };
