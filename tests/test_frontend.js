'use strict';
const assert = require('node:assert/strict');
const p = require('../web/productivity.js');
const hostile = p.markdown('<img src=x onerror=alert(1)>\n[click](javascript:alert)\n[safe](https://example.com?q="x")\n**bold**\n```\n<script>bad()</script>\n```');
assert(!hostile.includes('<img')); assert(!hostile.includes('<script>')); assert(!hostile.includes('href="javascript:')); assert(hostile.includes('rel="noopener noreferrer nofollow"')); assert(hostile.includes('<strong>bold</strong>'));
assert.equal(p.safeURL('https://me:secret@example.com'), '');
for (const formula of ['=SUM(1,2)',' +123','\t@SUM(A1)','-1','\rfoo']) assert(p.csvCell(formula).startsWith('"\''));
assert.equal(p.csvCell('a,"b"\nc'), '"a,""b""\nc"');
const board = {id:7,name:'Demo\r\nInjected:test',columns:[{title:'List',cards:[{id:8,title:'Caffè, lavoro; fase\\1\r\nInjected:value',description:'A\nB',due_date:'2026-12-31',start_date:'2026-12-30',completed:false},{id:9,title:'Undated'},{id:10,title:'Impossible',due_date:'2026-02-30'}]}]};
const ics = p.calendar(board,new Date('2026-10-15T12:00:00Z'));
assert(ics.includes('UID:board-7-card-8@openboard\r\n')); assert(ics.includes('DTSTART;VALUE=DATE:20261230')); assert(ics.includes('DTEND;VALUE=DATE:20270101')); assert(!ics.includes('\r\nInjected:')); assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,1); assert(ics.includes('Caffè\\, lavoro\\; fase\\\\1\\nInjected:value'));
const long = p.foldLine('SUMMARY:'+ '🗂Caffè'.repeat(40)); assert(long.split('\r\n').every((line) => Buffer.byteLength(line,'utf8') <=75)); assert.equal(long.replace(/\r\n /g,''),'SUMMARY:'+ '🗂Caffè'.repeat(40));
assert(p.csv(board).startsWith('\uFEFF"ID"')); assert(p.csv(board).includes('"Undated"'));
assert(p.shouldDiscardDraft('owned','owned',false));
assert(!p.shouldDiscardDraft('unread other draft',undefined,false));
assert(!p.shouldDiscardDraft('other-tab','owned',false));
assert(!p.shouldDiscardDraft('owned','owned',true));
console.log('Frontend: Markdown, CSV e iCalendar verificati.');

// Typed fields preserve zero/false, distinguish clearing, and reject invalid dates/numbers.
assert.equal(p.fieldValue('number','0'),0); assert.equal(p.fieldValue('number','-1.25'),-1.25);
assert.equal(p.fieldValue('boolean','false'),false); assert.equal(p.fieldValue('boolean','true'),true);
for (const type of ['text','number','date','boolean','select']) assert.equal(p.fieldValue(type,''),null);
assert.equal(p.fieldValue('date','2028-02-29'),'2028-02-29');
assert.throws(() => p.fieldValue('date','2026-02-29')); assert.throws(() => p.fieldValue('number','Infinity')); assert.throws(() => p.fieldValue('number','1000000000001'));
assert.throws(() => p.fieldValue('boolean','yes'));
assert.equal(p.fieldText(false),'No'); assert.equal(p.fieldText(0),'0'); assert.equal(p.fieldText(null),'—');
assert(p.fieldMatches('Caffè e Design','CAFFÈ')); assert(p.fieldMatches(false,'no')); assert(!p.fieldMatches(null,''));
const logsCSV = p.worklogCSV([{id:1,date:'2026-10-16',author:'=SUM(A1)',board_name:'Team',card_title:'\"Scheda\"',minutes:30,note:'@IMPORTDATA(secret)'}]);
assert(logsCSV.includes('"\'=SUM(A1)"')); assert(logsCSV.includes('"\'@IMPORTDATA(secret)"')); assert(logsCSV.includes('"""Scheda"""'));
assert.equal(p.fieldCell('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
assert.equal(p.fieldCell(false),'No'); assert.equal(p.fieldCell(0),'0');
console.log('Frontend 0.4: campi tipizzati, filtri, CSV e struttura tabellare verificati.');

// Exercise the actual table renderer with hostile stored board data.
const vm = require('node:vm'), fs = require('node:fs');
const dynamicInputs = [{dataset:{customKey:'score',customType:'number'},value:'0'},{dataset:{customKey:'ready',customType:'boolean'},value:'false'}];
const context = {OpenBoardProductivity:p,productivity:p,state:{board:{name:'<script>board</script>',custom_fields:[{id:1,key:'score',name:'<img src=x>',type:'number',position:0}],milestones:[],columns:[{id:1,title:'<b>List</b>',cards:[{id:5,title:'<img onerror=attack()>',priority:'normal',custom_values:{score:0},total_minutes:17}]}]},cardEditor:{customValues:{retired:'preserved',score:2}}},
 document:{addEventListener(){},querySelectorAll(){return dynamicInputs;}},escapeHTML:(value) => String(value ?? '').replace(/[&<>"']/g,(char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),sorted:(cards) => cards,selectionCheckbox:()=>'',priorities:{normal:'Normale'}};
vm.createContext(context); vm.runInContext(fs.readFileSync(require.resolve('../web/planning.js'),'utf8'),context);
const table = vm.runInContext('renderTable()',context);
assert(!table.includes('<img')); assert(!table.includes('<script>')); assert(table.includes('scope="row"')); assert(table.includes('scope="col"')); assert(table.includes('data-table-card="5"')); assert(table.includes('<td>0</td>'));
const values = vm.runInContext('readCustomValues()',context); assert.equal(values.score,0); assert.equal(values.ready,false); assert.equal(values.retired,'preserved');

const outgoing = p.planningPayload({custom_values:{active:0,retired:'keep'},milestone_key:'old'},[{key:'active'},{key:'retired',deleted_at:'now'}],[{key:'old',deleted_at:'now'}],'old');
assert.deepEqual(outgoing.custom_values,{active:0}); assert(!Object.hasOwn(outgoing,'milestone_key'));
assert.equal(p.planningPayload({custom_values:{active:null},milestone_key:''},[{key:'active'}],[],'old').milestone_key,'');
assert.equal(p.planningPayload({milestone_key:'new'},[],[{key:'new'}],'old').milestone_key,'new');

assert.equal(p.storageLabel('sqlite'),'SQLite');
assert.equal(p.storageLabel('postgresql+mongodb'),'PostgreSQL + MongoDB');
assert.equal(p.storageLabel(undefined),''); assert.equal(p.storageLabel('<script>'),'');

const catalogFixture = {labels:{design:'Design',sviluppo:'Sviluppo'},priorities:{low:'Bassa',normal:'Normale',high:'Alta',urgent:'Urgente'},covers:['','sage','peach'],custom_field_types:[{value:'text',label:'Testo'},{value:'number',label:'Numero'},{value:'date',label:'Data'},{value:'boolean',label:'Sì / No'},{value:'select',label:'Scelta'}]};
assert.deepEqual(p.catalog(catalogFixture).labels,catalogFixture.labels);
assert.equal(p.catalog(catalogFixture).fieldTypes.boolean,'Sì / No');
for (const catalog of [null,{}, {...catalogFixture,labels:{'bad" onclick="attack':'Unsafe'}}, {...catalogFixture,covers:['','bad/class']}, {...catalogFixture,custom_field_types:[{value:'script',label:'Unsafe'}]}, {...catalogFixture,priorities:{urgent:'Urgente'}}]) assert.throws(() => p.catalog(catalog));
assert.throws(() => p.catalog({...catalogFixture,labels:JSON.parse('{"__proto__":"unsafe"}')}));

const labelRenderer = fs.readFileSync(require.resolve('../web/app.js'),'utf8').match(/function labelBadges\(card\) \{[^\n]+/)[0];
const labelContext = {labels:{design:'<img src=x onerror=attack()>'},cardLabels:()=>['design'],escapeHTML:context.escapeHTML};
vm.createContext(labelContext); vm.runInContext(labelRenderer,labelContext);
assert(!vm.runInContext('labelBadges({})',labelContext).includes('<img'));

// Run real asynchronous UI loaders against independently controlled HTTP replies.
(async () => {
  function uiRuntime() {
    const nodes = new Map(), listeners = new Map(), requests = [], storage = new Map();
    for (const id of ['panel-dialog','card-dialog','panel-body','worklog-deleted','worklogs-list','card-time-summary','bookmark-card']) nodes.set(id,{open:true,checked:false,innerHTML:'',textContent:'',dataset:{},setAttribute(name,value){this[name]=value;},insertAdjacentHTML(_,value){this.innerHTML+=value;}});
    const runtime = {state:{board:{id:7},cardSequence:4,cardEditor:{id:8},auth:{user:{id:1,role:'member'}}},productivity:p,URLSearchParams,Number,Promise,
      document:{addEventListener(name,fn){if (!listeners.has(name)) listeners.set(name,[]); listeners.get(name).push(fn);}},
      $:(id) => nodes.get(id) || null,escapeHTML:context.escapeHTML,canWrite:()=>true,canManage:()=>false,formatDate:(value) => value || '',activityLabel:(value) => value || '',icon:()=>'',updateBusy(){},
      stored:(key) => storage.get(key) || '',remember:(key,value) => storage.set(key,value),forget:(key) => storage.delete(key),refreshNotifications(){},loadComments:async()=>{},
      api:(path,method='GET',body) => new Promise((resolve,reject) => requests.push({path,method,body,resolve,reject})),
      async showPanel(title,loader,kind) { this.state.panel = kind; const generation = this.state.panelSequence = (this.state.panelSequence || 0)+1; const body = await loader(); if (generation === this.state.panelSequence) nodes.get('panel-body').innerHTML = body; },
      perform:async(action) => { try { return await action(); } catch(error) { runtime.lastError=error; } },committed:async(write,refresh) => {const result=await write(); if(refresh) await refresh(result); return result;}};
    // Global functions have no implicit receiver, as in the browser.
    runtime.showPanel = async(title,loader,kind) => { runtime.state.panel=kind; const generation=runtime.state.panelSequence=(runtime.state.panelSequence||0)+1; const body=await loader(); if(generation===runtime.state.panelSequence) nodes.get('panel-body').innerHTML=body; };
    vm.createContext(runtime); vm.runInContext(fs.readFileSync(require.resolve('../web/planning.js'),'utf8'),runtime);
    return {runtime,nodes,requests,storage,listeners,call:(code) => vm.runInContext(code,runtime)};
  }
  const n = uiRuntime();
  n.runtime.state.notificationFilter={q:'old'}; const old=n.call('showFilteredNotifications()');
  n.runtime.state.notificationFilter={q:'new'}; const newer=n.call('showFilteredNotifications()');
  n.requests[1].resolve({items:[{id:20,title:'new first'}],next_cursor:20}); await newer;
  n.requests[0].resolve({items:[{id:10,title:'old result'}],next_cursor:10}); await old;
  const more=n.call('showFilteredNotifications(20,true)'); n.requests[2].resolve({items:[{id:19,title:'new second'}]}); await more;
  assert.deepEqual(Array.from(n.runtime.state.notificationsItems,(item)=>item.title),['new first','new second']);
  assert(!n.nodes.get('panel-body').innerHTML.includes('old result'));

  const w = uiRuntime(), first=w.call('loadWorklogs(8)');
  w.nodes.get('worklog-deleted').checked=true; const second=w.call('loadWorklogs(8)');
  w.requests[2].resolve({items:[{id:2,user_id:1,deleted_at:'now',date:'2026-10-16',minutes:30,note:''}]}); w.requests[3].resolve({total_minutes:30}); await second;
  w.requests[0].resolve({items:[{id:1,user_id:1,date:'2026-10-15',minutes:5,note:''}]}); w.requests[1].resolve({total_minutes:5}); await first;
  assert.equal(w.runtime.state.cardEditor.worklogs[0].id,2); assert(w.nodes.get('card-time-summary').textContent.includes('30 min totali'));

  const b=uiRuntime(), pending=b.call('loadBookmarkStatus(8,7,4)');
  assert.equal(b.runtime.state.cardEditor.bookmarkLoading,true);
  // Simulate an already acknowledged newer PATCH while the initial GET is delayed.
  b.runtime.state.cardEditor.bookmarkSequence++; b.runtime.state.cardEditor.bookmarkReady=true; b.runtime.state.cardEditor.bookmarkLoading=false; b.call('setBookmark(true)');
  b.requests[0].resolve({bookmarked:false}); await pending;
  assert.equal(b.nodes.get('bookmark-card').dataset.bookmarked,'true');
  const failed=uiRuntime(), status=failed.call('loadBookmarkStatus(8,7,4)'); failed.requests[0].reject(new Error('offline')); await status;
  assert.equal(failed.runtime.state.cardEditor.bookmarkReady,false); assert.equal(failed.nodes.get('bookmark-card').textContent,'Riprova stato segnalibro');

  const t=uiRuntime(); t.runtime.state.panel='thread'; t.runtime.state.threadId=3; t.runtime.state.threadCard=8;
  t.nodes.set('reply-body',{value:'Bozza **da conservare**'}); t.nodes.set('reply-form',{dataset:{parent:'3',card:'8'}});
  const thread=t.call('showThread(3)'); t.requests[0].resolve({parent:{id:3,card_id:8,body:'Parent',reactions:[]},replies:[]}); await thread;
  assert(t.nodes.get('panel-body').innerHTML.includes('Bozza **da conservare**'));
  const switching=t.call('showThread(4)'); t.requests[1].resolve({parent:{id:4,card_id:8,body:'Other',reactions:[]},replies:[]}); await switching;
  assert(!t.nodes.get('panel-body').innerHTML.includes('Bozza **da conservare**'));
  assert.equal(t.storage.get('reply.1.8.3'),'Bozza **da conservare**'); assert(!t.storage.has('reply.1.8.4'));
  t.runtime.state.threadId=3; t.nodes.get('reply-body').value='Reply awaiting server';
  const replyForm={id:'reply-form',dataset:{parent:'3',card:'8'}};
  const submit=() => {for(const listener of t.listeners.get('submit')) listener({target:replyForm,preventDefault(){}});};
  submit(); assert.equal(t.storage.get('reply.1.8.3'),'Reply awaiting server');
  t.requests[2].reject(new Error('network lost')); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.storage.get('reply.1.8.3'),'Reply awaiting server');
  submit(); t.requests[3].resolve({id:9}); await new Promise((resolve) => setImmediate(resolve));
  assert(!t.storage.has('reply.1.8.3')); assert.equal(t.nodes.get('reply-body').value,'');
  t.requests[4].resolve({parent:{id:3,card_id:8,body:'Parent'},replies:[{id:9,body:'Reply awaiting server'}]});
  await new Promise((resolve) => setImmediate(resolve)); assert(!t.storage.has('reply.1.8.3'));
  console.log('Frontend race tests: filtri, registro tempo, segnalibri e bozze risposta verificati.');
})().catch((error) => { console.error(error); process.exitCode=1; });
