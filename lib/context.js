'use strict';
/* Shared runtime context: MongoDB handles, settings and hooks provided by server.js at start-up. */
module.exports = {
  client: null,
  db: null,
  /** Collections, see initDb() in server.js. */
  col: {},
  /** true when the deployment supports multi-document transactions (replica set / Atlas). */
  txn: false,
  settings: { defaultMaxScore: 100, trustedDevicesOnly: true, digestHour: 20 },
  /** Clock used by every time-dependent calculation (tests may replace it). */
  now: () => new Date(),
  /** Hooks: sendPush(sub, payload), claim(key) — set by server.js. */
  sendPush: null,
  claim: null,
};
