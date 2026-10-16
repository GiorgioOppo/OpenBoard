import assert from 'node:assert/strict';
import createAuthRateLimiter from '../deploy/npm/auth-rate-limit.mjs';

let now = 0;
const limiter = createAuthRateLimiter({clock:() => now,secret:Buffer.alloc(32,7)});
function call(ip,path='/api/tokens',method='POST') {
  let next = false, status = 200, body = null;
  const headers = {};
  const response = {set(key,value){headers[key]=value;return this;},status(value){status=value;return this;},json(value){body=value;return this;}};
  limiter({ip,path,method},response,() => {next=true;});
  return {next,status,body,headers};
}
for (let i=0;i<10;i++) assert.equal(call('192.0.2.1').next,true);
const denied = call('192.0.2.1');
assert.equal(denied.status,429);assert.equal(denied.headers['Retry-After'],'300');
assert.equal(denied.headers['Cache-Control'],'no-store');
assert.equal(call('192.0.2.2').next,true);
assert.equal(call('192.0.2.1','/api/tokens/2fa').next,true);
assert.equal(call('192.0.2.1','/api/users').next,true);
assert.equal(call('192.0.2.1','/api/tokens','GET').next,true);
assert.equal(call('192.0.2.1','/api/nginx/proxy-hosts').next,true);
for (let i=0;i<10;i++) assert.equal(call('2001:db8::1').next,true);
assert.equal(call('2001:0db8:0:0:0:0:0:1').status,429);
assert.equal(call('::ffff:c000:201').status,429);
assert.equal(call('::ffff:192.0.2.1').status,429);
assert.equal(call('198.51.100.1, 203.0.113.1').status,400);
assert.equal(call('fe80::1%lo0').status,400);
assert.equal(call('localhost').status,400);
assert.equal(call('192.0.2.1','/API/TOKENS/').status,429);
// NPM's actual internal route has no /api prefix. Both aliases share a quota.
assert.equal(call('192.0.2.1','/tokens').status,429);
for (let i=0;i<9;i++) assert.equal(call('192.0.2.1','/tokens/2fa').next,true);
assert.equal(call('192.0.2.1','/api/tokens/2fa').status,429);
for (let i=0;i<9;i++) assert.equal(call('192.0.2.1','/users').next,true);
assert.equal(call('192.0.2.1','/api/users').status,429);
now = 299999;assert.equal(call('192.0.2.1').headers['Retry-After'],'1');
now = 300000;assert.equal(call('192.0.2.1').next,true);
for (let i=0;i<9;i++) assert.equal(call('192.0.2.1').next,true);
now = 0;assert.equal(call('192.0.2.1').status,429);
now = 600000;assert.equal(call('192.0.2.1').next,true);
console.log('NPM authentication limits: separate clients and routes, canonical addresses, bounded counters, expiry and retry feedback verified.');
