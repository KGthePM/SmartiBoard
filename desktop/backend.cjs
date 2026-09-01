'use strict';

/**
 * Runs inside an Electron utility process. Next owns graceful HTTP cleanup;
 * this wrapper only ties its signals to Electron and makes parent loss fatal.
 */
const { parentPort } = process;

let lastHeartbeat = Date.now();
let lastWatchdogTick = Date.now();
let shuttingDown = false;

function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM');
  else process.exit(0);
}

if (!parentPort) {
  console.error('[desktop] backend has no Electron parent');
  process.exit(1);
}

parentPort.on('message', (event) => {
  const message = event?.data ?? event;
  if (message?.type === 'heartbeat') lastHeartbeat = Date.now();
  if (message?.type === 'shutdown') stop();
});

const watchdog = setInterval(() => {
  const now = Date.now();
  // A long gap means this process was suspended too. Give the parent a fresh
  // heartbeat window instead of treating normal laptop sleep as parent loss.
  if (now - lastWatchdogTick > 5_000) lastHeartbeat = now;
  lastWatchdogTick = now;
  if (now - lastHeartbeat > 10_000) stop();
}, 2_000);
watchdog.unref();

process.once('exit', () => clearInterval(watchdog));

require('./server.js');
