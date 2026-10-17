'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {test}=require('node:test'),{spawnSync}=require('node:child_process');
const timeline=require('../web/timeline.js'),{create}=require('../web/i18n.js');
const code=fs.readFileSync(require.resolve('../web/timeline.js'),'utf8');
const catalog={};
for(const name of fs.readdirSync(path.join(__dirname,'../locales')).filter(name=>name.endsWith('.json')))
  Object.assign(catalog,JSON.parse(fs.readFileSync(path.join(__dirname,'../locales',name),'utf8')));
const board=(cards=[],id=7)=>({id,version:1,role:'observer',readonly:true,columns:[{id:1,title:'Synthetic list',cards}]});
const card=(id,dates={})=>({id,title:'Synthetic card '+id,...dates});
const options={mode:'month',anchor:'2028-02-20'};
const tick=()=>new Promise(setImmediate);
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

function runtime(locale='it') {
  const nodes=new Map(),listeners=new Map(),requests=[],opened=[];
  let context,html='',focused=null;
  function make(id,tag,attributes={}) {
    const node={id,tag,attributes,dataset:{},disabled:Object.hasOwn(attributes,'disabled'),value:attributes.value??'',
      focus(){focused=this.id;context.document.activeElement=this;},
      hasAttribute(name){return Object.hasOwn(this.attributes,name);},
      closest(selector){return selector==='button'&&tag==='button'?this:null;},
      matches(selector){return selector==='.timeline-card-open'&&String(attributes.class).split(' ').includes('timeline-card-open');}};
    for(const [key,value] of Object.entries(attributes))if(key.startsWith('data-'))node.dataset[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
    nodes.set(id,node);return node;
  }
  function parse(value) {
    html=value;nodes.clear();
    let anonymous=0;
    for(const match of html.matchAll(/<(button|input|select)\b([^>]*)>/g)) {
      const attributes={};
      for(const item of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attributes[item[1]]=decode(item[2]??'');
      const node=make(attributes.id||'anonymous-'+(++anonymous),match[1],attributes);
      if(node.tag==='select') {
        const inner=html.slice(match.index+match[0].length).split('</select>')[0];
        const selected=[...inner.matchAll(/<option\b([^>]*)>/g)].find(option=>/\bselected\b/.test(option[1]));
        node.value=selected?.[1].match(/value="([^"]*)"/)?.[1]||'';
      }
    }
  }
  const i18n=create({locale,catalog});
  context={state:{view:'timeline',board:board([card(1,{start_date:'2028-02-01',due_date:'2028-02-03'}),card(2)]),
      auth:{enabled:true,user:{id:1,role:'observer'}},authGeneration:0,loadSequence:0,timelineSequence:0,loading:false,saving:false,
      timelineSettings:{...options,page:0,undatedPage:0}},
    Map,Set,Number,Date,Intl,JSON,Error,RangeError,OpenBoardI18n:i18n,tr:i18n.t,matches:()=>true,
    document:{activeElement:null,getElementById:id=>nodes.get(id)||null,
      querySelectorAll:selector=>selector==='.timeline-card-open'?[...nodes.values()].filter(node=>node.matches(selector)):[],
      addEventListener(type,handler){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(handler);}},
    sessionContext(){return {generation:context.state.authGeneration,id:context.state.auth.user?.id??null};},
    sessionCurrent(session){return !!session&&session.generation===context.state.authGeneration&&session.id===(context.state.auth.user?.id??null);},
    api(url,init){return new Promise((resolve,reject)=>requests.push({url,init,resolve,reject}));},
    openCard:id=>opened.push(id),renderBoard(){parse(context.renderTimeline());context.timelineAfterRender();}};
  vm.createContext(context);vm.runInContext(code,context);
  const event=(type,node,extra={})=>{
    const value={target:node,preventDefault(){this.prevented=true;},...extra};
    for(const handler of listeners.get(type)||[])handler(value);return value;
  };
  return {context,nodes,requests,opened,render:()=>context.renderBoard(),
    html:()=>html,focused:()=>focused,click:id=>event('click',nodes.get(id)),
    change(id,value){const node=nodes.get(id);node.value=value;return event('change',node);},
    key:(id,key,extra)=>event('keydown',nodes.get(id),{key,...extra}),
    reply(index=0,data={board_id:7,dependencies:[],truncated:false}){requests[index].resolve(data);return tick();},
    fail(index,status=503,message='Synthetic failure'){requests[index].reject(Object.assign(new Error(message),{status}));return tick();}};
}

test('strict UTC dates cover years1–9999 and reject normalized or malformed values',()=>{
  for(const value of ['0001-01-01','0099-12-31','2000-02-29','2028-02-29','9999-12-31'])assert.equal(timeline.iso(timeline.ordinal(value)),value);
  for(const value of ['0000-01-01','10000-01-01','1900-02-29','2028-02-30','2028-13-01','2028-00-01','2028-01-00','2028-1-01','2028-01-01T00:00:00Z','2028-01-01\0',null,1])assert.equal(timeline.ordinal(value),null,String(value));
  assert.equal(timeline.iso(NaN),null);assert.equal(timeline.iso(timeline.ordinal('0001-01-01')-1),null);
});

test('week and month windows clamp without inventing year0 or year10000',()=>{
  const month=timeline.period('month','2028-01-31',1);assert.equal(month.anchor,'2028-02-29');assert.equal(month.days.length,29);
  assert.equal(timeline.period('month','2027-01-31',1).anchor,'2027-02-28');
  const first=timeline.period('week','0001-01-01',-1),last=timeline.period('month','9999-12-31',1);
  assert.equal(first.start,'0001-01-01');assert.equal(first.previous,false);assert.equal(first.days.length,7);
  assert.equal(last.anchor,'9999-12-31');assert.equal(last.next,false);assert.equal(last.days.length,31);
  assert.equal(timeline.period('week','9999-12-31',1).end,'9999-12-31');
  assert.equal(timeline.period('week','2028-02-20').start,'2028-02-14');
  for(const invalid of [['day','2028-02-20'],['month','invalid'],['week','2028-02-20',7]])assert.equal(timeline.period(...invalid),null);
});

test('UTC geometry is independent of local DST and timezone',()=>{
  const script="const t=require('./web/timeline.js'); process.stdout.write(JSON.stringify([t.period('week','2028-03-12'),t.period('month','2028-11-01')]));";
  const results=['UTC','America/New_York','Pacific/Auckland'].map(TZ=>{
    const result=spawnSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout;
  });
  assert.equal(results[0],results[1]);assert.equal(results[1],results[2]);
});

test('real ranges, partial anchors, invalid pairs and undated cards keep distinct semantics',()=>{
  const cards=[card(1,{start_date:'2028-01-31',due_date:'2028-02-02'}),card(2,{start_date:'2028-02-03'}),
    card(3,{due_date:'2028-02-04'}),card(4),card(5,{start_date:'2028-03-01'}),
    card(6,{start_date:'2028-02-10',due_date:'2028-02-09'}),card(7,{due_date:'2028-02-31'})];
  const value=timeline.model(board(cards),options);
  assert.deepEqual(value.scheduled.items.map(row=>row.kind),['range','start','due']);
  assert.equal(value.scheduled.items[0].clipped,true);assert.equal(value.scheduled.items[0].width,2/29*100);
  assert.equal(value.scheduled.items[1].width,0);assert.equal(value.scheduled.items[1].from,value.scheduled.items[1].to);
  assert.equal(value.scheduled.items[2].width,0);assert.equal(value.outside,1);
  assert.deepEqual(value.undated.items.map(row=>row.kind),['undated','invalid','invalid']);
  const html=timeline.render(value);assert.match(html,/Solo inizio:/);assert.match(html,/Solo scadenza:/);assert.match(html,/Date non valide/);
});

test('live summaries, filters and dependency endpoints restrict visible data',()=>{
  const data=board([card(1,{due_date:'2028-02-10'}),card(2),card(3,{deleted_at:'2028-01-01'}),card(-1),card(1)]);
  data.columns.push({title:'Deleted list',deleted_at:'2028-01-01',cards:[card(4)]});
  const value=timeline.model(data,{...options,matches:card=>card.id!==2,
    edges:[{card_id:1,required_card_id:2},{card_id:1,required_card_id:4},{card_id:1,required_card_id:999},{card_id:1,required_card_id:1}]});
  assert.deepEqual([...value.visible.keys()],[1]);assert.equal(value.scheduled.items[0].requires.length,0);
});

test('rendering and dependency lists are bounded and pagination clamps independently',()=>{
  const data=board(Array.from({length:10000},(_,index)=>card(index+1,index<5000?{due_date:'2028-02-10'}:{})));
  const edges=Array.from({length:2001},(_,index)=>({card_id:1,required_card_id:index+2}));
  const value=timeline.model(data,{...options,page:10000,undatedPage:-1,edges});
  assert.equal(value.scheduled.items.length,100);assert.equal(value.undated.items.length,100);
  assert.equal(value.scheduled.index,49);assert.equal(value.undated.index,0);assert.equal(value.truncated,true);
  const html=timeline.render(value);assert.equal((html.match(/class="timeline-card-open"/g)||[]).length,200);
  const first=timeline.model(data,{...options,edges});const firstHTML=timeline.render(first);
  assert.equal((firstHTML.match(/class="timeline-dependency"/g)||[]).length,3);assert.match(firstHTML,/Altre dipendenze: 1997/);
  assert.equal(timeline.model(data,{...options,truncated:true}).truncated,true);
});

test('accessible text exposes dates and dependencies and escapes every user-controlled value',()=>{
  const data=board([card(1,{title:'<img src=x onerror=alert(1)>',due_date:'2028-02-10'}),card(2,{title:'<script>bad</script>'})]);
  data.columns[0].title='<svg onload=bad>';
  const value=timeline.model(data,{...options,edges:[{card_id:1,required_card_id:2},{card_id:1,required_card_id:2}]});
  assert.equal(value.scheduled.items[0].requires.length,1);
  const html=timeline.render(value,{error:'<iframe src=x>'});
  for(const unsafe of ['<img','<script','<svg','<iframe'])assert(!html.includes(unsafe),unsafe);
  assert.match(html,/&lt;img/);assert.match(html,/&lt;svg/);assert.match(html,/&lt;iframe/);
  assert.match(html,/<caption>/);assert.match(html,/scope="col"/);assert.match(html,/scope="row"/);assert.match(html,/aria-hidden="true"/);
  assert.match(html,/tabindex="0" role="region"/);assert.match(html,/Dipendenze non disponibili/);
  const safe=timeline.render(value);assert.match(safe,/Richiede: &lt;script&gt;/);assert(!safe.includes('onerror="'));
});

test('one authenticated board request serves date, filter and pagination changes',async()=>{
  const r=runtime();r.render();assert.equal(r.requests.length,1);assert.equal(r.requests[0].url,'/api/boards/7/timeline?include_archived=0');
  assert.match(r.html(),/Caricamento dipendenze/);
  r.change('timeline-mode','week');r.change('timeline-anchor','2028-02-02');r.click('timeline-next');
  assert.equal(r.requests.length,1);await r.reply(0,{board_id:7,dependencies:[{card_id:1,required_card_id:2}],truncated:false});
  assert.equal(r.context.state.timeline.edges.length,1);assert.equal(r.context.state.timeline.loaded,true);
  r.change('timeline-mode','month');assert.equal(r.requests.length,1);assert.equal(r.focused(),'timeline-mode');
  assert(r.requests.every(request=>request.init===undefined),'timeline must never write dates');
});

test('cache identity includes fresh board snapshots, loads, archive toggles and view changes',async()=>{
  const r=runtime();r.render();await r.reply();
  r.context.state.board={...r.context.state.board};r.render();assert.equal(r.requests.length,2,'same id/version is not a snapshot cache key');await r.reply(1);
  r.context.state.loadSequence++;r.render();assert.equal(r.requests.length,3);await r.reply(2);
  r.context.state.archived=true;r.render();assert.equal(r.requests.length,4);assert.match(r.requests[3].url,/include_archived=1/);await r.reply(3);
  r.context.state.timelineSequence++;r.render();assert.equal(r.requests.length,5);
});

test('late requests cannot replace another board, session, view or loading state',async()=>{
  for(const change of [r=>{r.context.state.board=board([card(9)],8);},r=>{r.context.state.authGeneration++;},
    r=>{r.context.state.auth.user=null;},r=>{r.context.state.view='board';},r=>{r.context.state.loadSequence++;},
    r=>{r.context.state.timelineSequence++;},r=>{r.context.state.loading=true;},r=>{r.context.state.board.role='unknown';}]) {
    const r=runtime();r.render();const old=r.context.state.timeline;change(r);const before=r.html();
    await r.reply(0,{board_id:7,dependencies:[{card_id:1,required_card_id:2}],truncated:false});
    assert.equal(old.loaded,false);assert.equal(old.edges.length,0);assert.equal(r.html(),before);
  }
});

test('stale failures do not render into a new snapshot and fresh responses win',async()=>{
  const r=runtime();r.render();const old=r.context.state.timeline;r.context.state.board={...r.context.state.board};r.render();
  await r.fail(0,403,'Old forbidden response');assert.equal(old.error,'');assert(!r.html().includes('Old forbidden'));
  await r.reply(1,{board_id:7,dependencies:[{card_id:1,required_card_id:2}],truncated:true});
  assert.equal(r.context.state.timeline.loaded,true);assert.match(r.html(),/2000 dipendenze/);
});

test('permission failures hide cards; transient failures preserve dates and explicit refresh retries',async()=>{
  for(const status of [401,403,404]) {const r=runtime();r.render();await r.fail(0,status);assert.equal(r.context.state.timelineVisible.size,0);assert(!r.html().includes('Synthetic card'));}
  const r=runtime();r.render();await r.fail(0,503,'<img src=x>');
  assert.equal(r.context.state.timelineVisible.size,2);assert.match(r.html(),/Synthetic card 1/);assert.match(r.html(),/&lt;img/);assert.match(r.html(),/Dipendenze non disponibili/);
  r.render();assert.equal(r.requests.length,1,'errors do not cause retry storms');r.click('timeline-refresh');assert.equal(r.requests.length,2);
  await r.reply(1);assert.equal(r.context.state.timeline.error,'');assert.equal(r.context.state.timeline.loaded,true);
});

test('malformed or oversized edge payloads are rejected before rendering',async()=>{
  const payloads=[{board_id:8,dependencies:[],truncated:false},{board_id:7,dependencies:[],truncated:'false'},
    {board_id:7,dependencies:[{card_id:1,required_card_id:-1}],truncated:false},
    {board_id:7,dependencies:Array.from({length:2001},()=>({card_id:1,required_card_id:2})),truncated:false}];
  for(const payload of payloads){const r=runtime();r.render();await r.reply(0,payload);assert.match(r.html(),/Risposta della timeline non valida/);assert.equal(r.context.state.timeline.edges.length,0);}
});

test('controls and keyboard focus work for observers and never mutate dates',async()=>{
  const r=runtime();r.render();await r.reply(0,{board_id:7,dependencies:[{card_id:1,required_card_id:2}],truncated:false});
  r.click('timeline-card-1');assert.deepEqual(r.opened,[1]);
  const dependency=[...r.nodes.values()].find(node=>node.attributes.class==='timeline-dependency');
  // Real delegated dependency buttons are governed by the same visible map.
  dependency.id='dependency';r.nodes.set(dependency.id,dependency);r.click('dependency');assert.deepEqual(r.opened,[1,2]);
  dependency.dataset.timelineCard='999';r.click('dependency');assert.deepEqual(r.opened,[1,2]);
  assert.equal(r.key('timeline-card-1','ArrowDown').prevented,true);assert.equal(r.focused(),'timeline-card-2');
  r.key('timeline-card-2','Home');assert.equal(r.focused(),'timeline-card-1');r.key('timeline-card-1','End');assert.equal(r.focused(),'timeline-card-2');
  assert.equal(r.key('timeline-card-1','ArrowDown',{isComposing:true}).prevented,undefined);
  const anchor=r.context.state.timelineSettings.anchor;r.change('timeline-anchor','2028-02-31');assert.equal(r.context.state.timelineSettings.anchor,anchor);
  r.context.state.saving=true;r.click('timeline-card-1');r.change('timeline-mode','week');assert.equal(r.context.state.timelineSettings.mode,'month');assert.deepEqual(r.opened,[1,2]);
  assert(r.requests.every(request=>request.init===undefined));
});

test('all timeline sources have six translations with stable interpolation placeholders',()=>{
  const messages=JSON.parse(fs.readFileSync(path.join(__dirname,'../locales/timeline.json'),'utf8'));
  const sources=[...code.matchAll(/\btr\('([^']+)'/g)].map(match=>match[1]);sources.push('Timeline');
  for(const source of new Set(sources)){
    assert(messages[source]||catalog[source],source);const translations=messages[source]||catalog[source];assert.equal(translations.length,6);
    const placeholders=value=>[...value.matchAll(/\{\d+\}/g)].map(match=>match[0]).sort();
    for(const value of translations){assert(value.trim(),source);assert.deepEqual(placeholders(value),placeholders(source));}
  }
  const value=timeline.model(board([card(1,{due_date:'2028-02-10'}),card(2)]),options);
  for(const locale of ['it','en','fr','es','de','zh','ja']){
    const i18n=create({locale,catalog:{...catalog,...messages}}),html=timeline.render(value,{tr:i18n.t,locale});
    assert(!html.includes('undefined'));if(locale!=='it')assert(!html.includes('Timeline della bacheca'),locale);
  }
});
