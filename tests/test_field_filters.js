'use strict';
const assert=require('node:assert/strict');
const {fieldMatchesAdvanced:matches}=require('../web/productivity.js');
const number={type:'number'},text={type:'text'},date={type:'date'},flag={type:'boolean'},select={type:'select',options:['España','Italia']};
const match=(value,field,op,target)=>matches(value,field,{op,value:target});
for(const [op,target,yes,no] of [['eq',10,10,20],['ne',10,20,10],['gt',10,11,10],['gte',10,10,9],['lt',10,9,10],['lte',10,10,11]]) {
 assert(match(yes,number,op,target));assert(!match(no,number,op,target));assert(!match(null,number,op,target));assert(!match(undefined,number,op,target));
}
assert(!match('10',number,'eq',10));assert(!match(10,number,'eq','10'));
for(const value of [NaN,Infinity,-Infinity,1e13])assert(!match(10,number,'gt',value));
assert(match(0,number,'eq',-0));assert(match(-1e12,number,'lte',-1e12));
assert(match(false,flag,'eq',false));assert(match(false,flag,'ne',true));assert(!match(false,flag,'eq',0));assert(!match(false,flag,'gt',false));
assert(matches(false,flag,{op:'is_set'}));assert(matches(0,number,{op:'is_set'}));assert(matches('',text,{op:'is_set'}));
assert(matches(null,text,{op:'is_unset'}));assert(matches(undefined,text,{op:'is_unset'}));assert(!matches(null,text,{op:'is_set'}));
assert(match(null,text,'eq',null));assert(!match(undefined,text,'eq',null));assert(match('',text,'ne',null));assert(!match(null,text,'ne','x'));
assert(!matches(null,text,{op:'is_unset',value:null}));assert(!matches('x',text,{op:'eq'}));assert(!match('x',text,'eq',undefined));
assert(match('Caffè ☕',text,'contains','Caffè'));assert(!match('Caffè ☕',text,'contains','CAFFÈ'));assert(match('Caffè ☕',text,'contains',''));
assert(match('España',select,'contains','paña'));assert(match('España',select,'eq','España'));assert(!match('España',select,'eq','France'));
assert(match('2028-02-29',date,'lt','2028-03-01'));assert(match('0001-01-01',date,'gte','0001-01-01'));
assert(!match('2027-02-28',date,'lt','2027-02-29'));assert(!match('0001-01-01',date,'gte','0000-01-01'));
assert(!match('2',text,'gt','10'));assert(!match('x',text,'eq','x\0'));assert(!match('x',text,'eq','\uD800'));assert(!match('x',text,'eq','\uDC00'));
assert(match('☕'.repeat(2000),text,'eq','☕'.repeat(2000)));assert(!match('x',text,'eq','☕'.repeat(2001)));
assert(match('👩🏽‍💻',text,'eq','👩🏽‍💻'));assert(!matches('x',{type:'text',deleted_at:'now'},{op:'eq',value:'x'}));
assert(!matches('x',{type:'unknown'},{op:'is_set'}));assert(!matches('x',text,{op:'eq',value:'x',unknown:true}));
assert(!matches('x',text,{op:'xor',value:'x'}));assert(!matches('x',text,null));
console.log('Advanced field filter semantics passed.');
