'use strict';
/* Immutable administrative / student action log. Records are only ever inserted. */

const ctx = require('./context');
const { uuid, str } = require('./util');

const roleOf = (u) => (!u ? 'system' : u.isAdmin ? 'admin' : u.role === 'starosta' || u.role === 'deputy' ? u.role : 'student');

/** Never throws: a failed audit write must not undo the action it describes. */
async function audit(actor, action, { target = null, details = {}, ip = '' } = {}) {
  try {
    await ctx.col.audit.insertOne({
      _id: uuid(), at: ctx.now(), action,
      actorId: actor ? actor._id : null, actorName: actor ? actor.fullName : 'Система', actorRole: roleOf(actor),
      target, details, ip: str(ip, 60),
    });
  } catch (e) {
    console.error('audit:', e.message);
  }
}

/** Short, secret-free summary of a request body for the generic admin-route audit. */
function summarize(body) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body).slice(0, 20)) {
    if (/password|token|secret|key$|subscription|data$/i.test(k)) continue;
    if (v == null || typeof v === 'boolean' || typeof v === 'number') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 160);
    else if (Array.isArray(v)) out[k] = `[${v.length}]`;
    else out[k] = '{…}';
  }
  return out;
}

module.exports = { audit, summarize, roleOf };
