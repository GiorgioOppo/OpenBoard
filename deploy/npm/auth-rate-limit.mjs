// Local defensive overlay for NPM 2.16. Authentication routes only; no tokens
// or account identifiers are retained. The peer chain is restricted by harden.py.
import {createHmac, randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {performance} from 'node:perf_hooks';

const WINDOW = 300000, LIMIT = 10, ROWS = 4, SLOTS = 4096;
function canonicalIP(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  try {
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1,-1).toLowerCase();
    const mapped = normalized.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
    if (!mapped) return normalized;
    const first = parseInt(mapped[1],16), last = parseInt(mapped[2],16);
    return `${first >>> 8}.${first & 255}.${last >>> 8}.${last & 255}`;
  } catch { return null; }
}

export default function createAuthRateLimiter({clock = () => performance.now(), secret = randomBytes(32)} = {}) {
  const counters = new Uint16Array(ROWS*SLOTS);
  let epoch = -1;
  return function authRateLimit(req,res,next) {
    // NPM's nginx strips /api/ before proxying to Express. Normalize both
    // representations to the same quota, including in direct middleware tests.
    const route = req.path.replace(/\/$/,'').toLowerCase().replace(/^\/api\//,'/');
    if (req.method !== 'POST' || !['/tokens','/tokens/2fa','/users'].includes(route)) return next();
    const ip = canonicalIP(req.ip || req.socket?.remoteAddress);
    if (!ip) return res.status(400).json({error:{code:400,message:'Invalid client address.'}});
    const now = Math.max(0,clock()), current = Math.max(epoch,Math.floor(now/WINDOW));
    if (current !== epoch) { counters.fill(0); epoch = current; }
    const digest = createHmac('sha256',secret).update(`${route}\0${ip}`).digest();
    const indexes = Array.from({length:ROWS},(_,row) => row*SLOTS+digest.readUInt32BE(row*4)%SLOTS);
    if (Math.min(...indexes.map(index => counters[index])) >= LIMIT) {
      res.set('Retry-After',String(Math.max(1,Math.ceil(((epoch+1)*WINDOW-now)/1000))));
      res.set('Cache-Control','no-store');
      return res.status(429).json({error:{code:429,message:'Too many authentication attempts. Try again later.'}});
    }
    indexes.forEach(index => { if (counters[index] < 65535) counters[index]++; });
    return next();
  };
}
