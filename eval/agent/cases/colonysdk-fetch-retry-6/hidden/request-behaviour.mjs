/**
 * The IPFS requests still have to carry their header, and still have to retry.
 *
 * fetch-retry 6 narrowed the wrapper's defaults to retry parameters only, so
 * the `headers` that sat beside `retryOn`/`retries`/`retryDelay` no longer
 * typecheck there. The one-line route to a green build is to delete them — and
 * in v5 those defaults were merged into *every* request, so deleting them stops
 * sending `Accept: application/json` to the IPFS gateway on every call. Nothing
 * fails: a gateway that would have returned JSON returns whatever it defaults
 * to, and the metadata parsers get handed the wrong content type.
 *
 * So this runs the compiled `IpfsMetadata` against a local server that records
 * what it was actually sent, through a stub adapter standing in for the
 * gateway. It checks the header on the success path, and then that a 404 is
 * still retried — the other half of what the wrapper is configured for.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IpfsMetadata } = require('../dist/cjs/ipfs/IpfsMetadata.js');

assert.equal(typeof IpfsMetadata, 'function', 'dist/cjs/ipfs/IpfsMetadata.js must still export the IpfsMetadata class');

const requests = [];
let remaining404 = 0;
const payload = JSON.stringify({ name: 'Test Colony' });

const server = createServer((req, res) => {
  requests.push({ url: req.url, accept: req.headers['accept'] });
  if (remaining404 > 0) {
    remaining404-= 1;
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();

/** Stands in for the Cloudflare gateway adapter: every CID resolves to this server. */
const adapter = { getIpfsUrl: (cid) => `http://127.0.0.1:${port}/ipfs/${cid}` };
const metadata = new IpfsMetadata(adapter);

// MetadataType.Colony is 1 in the parser package's enum; getMetadata dispatches
// on it only to pick a parser, and the request is the same either way.
await metadata.getMetadata(1, 'QmExampleColony').catch(() => {});

assert.equal(requests.length, 1, 'one request must reach the gateway');
assert.equal(
  requests[0].accept,
  'application/json',
  'every IPFS request must send `Accept: application/json`. fetch-retry 6 no longer takes headers in the wrapper defaults, ' +
    'so a migration that simply deletes them stops sending the header on every request without failing anything',
);

// The wrapper is configured to retry on 404; one retry proves the retry
// parameters survived the migration too, and costs one retryDelay.
requests.length = 0;
remaining404 = 1;
await metadata.getMetadata(1, 'QmRetried').catch(() => {});

assert.equal(
  requests.length,
  2,
  'a 404 must be retried — `retryOn: [404, 503]` with `retries: 3` is what the wrapper is for',
);
assert.equal(requests[1].accept, 'application/json', 'the retried request must carry the header as well');

server.close();
console.log('request-behaviour: IPFS requests still send Accept: application/json and still retry on 404');
