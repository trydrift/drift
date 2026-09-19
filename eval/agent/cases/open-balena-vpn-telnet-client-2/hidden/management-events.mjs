/**
 * The manager still has to talk to OpenVPN's management interface.
 *
 * telnet-client 2 publishes named exports, which breaks the 1.x-era
 * `require('telnet-client') as typeof import('telnet-client').default` cast
 * this file used to get past the old typings. That is one line, and several
 * ways to make it compile — casting to `any`, keeping the require and widening
 * the type — leave the connector constructed from something that is no longer
 * the client class. Nothing fails until a VPN instance is actually managed:
 * the socket never connects, or connects and emits nothing, and the service
 * silently stops seeing client connect/disconnect events.
 *
 * So this runs the compiled VpnManager against a TCP server standing in for
 * OpenVPN's management interface: it connects for real, and the log and client
 * lines the server writes have to come back out as parsed events.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VpnManager } = require('../build/src/utils/openvpn.js');
const { Netmask } = require('../build/src/utils/netmask.js');

assert.equal(typeof VpnManager, 'function', 'build/src/utils/openvpn.js must still export the VpnManager class');

const sockets = [];
const written = [];
const server = createServer((socket) => {
  sockets.push(socket);
  // The management interface greets the client; telnet-client negotiates
  // against this before `connect()` resolves.
  socket.write('>INFO:OpenVPN Management Interface Version 3\r\n');
  // ...and acknowledges each command, which is the response `send` waits for.
  socket.on('data', (chunk) => {
    written.push(chunk.toString());
    socket.write('SUCCESS: real-time log notification set to ON\r\n');
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();

const manager = new VpnManager(1, 443, port, new Netmask('10.2.0.0', 24), undefined, false);

const logs = [];
const connects = [];
manager.on('log', (level, message) => logs.push({ level, message }));
manager.on('client:connect', (clientId, data) => connects.push({ clientId, data }));

await manager.connect();
assert.equal(sockets.length, 1, 'connect() must open a real connection to the management port');

// `log on all` is what enableLogging sends; it proves the outbound half works.
await manager.enableLogging();
await new Promise((resolve) => setTimeout(resolve, 200));
assert.ok(
  written.join('').includes('log on all'),
  `commands must reach the management interface (saw ${JSON.stringify(written.join(''))})`,
);

sockets[0].write('>LOG:1699999999,I,peer info line\r\n');
sockets[0].write('>CLIENT:CONNECT,7,0\r\n');
sockets[0].write('>CLIENT:ENV,username=someuser\r\n');
sockets[0].write('>CLIENT:ENV,END\r\n');
await new Promise((resolve) => setTimeout(resolve, 400));

assert.ok(
  logs.some((entry) => entry.message.includes('peer info line')),
  `a >LOG: line from the management interface must surface as a parsed log event (saw ${JSON.stringify(logs)})`,
);
assert.ok(
  connects.some((entry) => entry.clientId === 7),
  `a >CLIENT:CONNECT line must surface as a parsed client:connect event (saw ${JSON.stringify(connects)})`,
);

server.close();
for (const socket of sockets) socket.destroy();
console.log('management-events: the manager connects to the management interface and parses its events');
