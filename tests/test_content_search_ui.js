'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
const source=app.slice(app.indexOf('function showGlobalSearch()'),app.indexOf('function showMove()'));
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ui=(parts,...values)=>typeof parts==='string' ? parts:parts.map((part,i)=>part+(values[i]??'')).join('');
function runtime() {
  const nodes=new Map(),requests=[],events=[];
  const document={activeElement:null};
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',dataset:{},open:false,
      setAttribute(){},querySelector(){return null;},focus(){document.activeElement=this;}});
    return nodes.get(id);
  };
  const state={board:{id:7},auth:{user:{id:1}},panelSequence:0,loadSequence:0,loading:false};
  const context={state,document,ui,tr:value=>value,escapeHTML,priorities:{normal:'Normal'},searchTimer:null,
    setTimeout,clearTimeout,$:node,sessionContext:()=>state.auth.user.id,
    sessionCurrent:owner=>state.auth.user.id===owner,
    api:url=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})),
    panel(title,body,kind){state.panel=kind;state.panelSequence++;node('panel-dialog').open=true;node('panel-body').innerHTML=body;},
    closeEditors:()=>true,closeDialog(){node('panel-dialog').open=false;},
    selectBoard:async id=>{state.loadSequence++;state.loading=false;state.board={id};events.push(['board',id]);},
    openCard:async id=>{state.cardEditor={id};events.push(['card',id]);},
    showThread:async id=>events.push(['thread',id]),
    workflows:{showRequest:async id=>events.push(['request',id]),showForm:async id=>events.push(['form',id])},
    toast:(message,error)=>events.push(['toast',message,error])};
  vm.createContext(context);vm.runInContext(source,context);
  return {state,node,requests,events,context,call:code=>vm.runInContext(code,context)};
}
const hit=(kind,id,values={})=>({kind,id,key:({card:0,comment:1,request:2,request_note:3,form:4})[kind]+':'+id,
  board_id:7,board_name:'Board',title:'Result',snippet:'Visible match',context:'List',card_id:42,
  request_id:8,form_id:9,...values});
(async()=>{
  const search=runtime();search.call('showGlobalSearch()');search.node('global-kind').value='all';
  const first=search.call('globalSearch("needle 日本")');
  assert.equal(search.requests[0].url,'/api/search/content?q=needle%20%E6%97%A5%E6%9C%AC&kind=all&limit=30');
  search.requests[0].resolve({items:[hit('card',4),hit('comment',4,{snippet:'<img src=x onerror=attack()>'})],next_cursor:'1:4'});await first;
  assert.equal(search.state.globalSearch.cards.length,2,'Same numeric ID in different sources is not a duplicate');
  assert(search.node('global-results').innerHTML.includes('&lt;img'));assert(!search.node('global-results').innerHTML.includes('<img'));
  const more=search.call('globalSearch("needle 日本",true)');
  assert(search.requests[1].url.endsWith('&cursor=1%3A4'));
  await search.call('globalSearch("needle 日本",true)');assert.equal(search.requests.length,2);
  search.requests[1].resolve({items:[hit('comment',4),hit('request',4)],next_cursor:null});await more;
  assert.equal(search.state.globalSearch.cards.length,3);
  assert(!search.node('global-results').innerHTML.includes('global-more'));
  await search.call('openContentSearchResult("1:4")');
  assert.deepEqual(search.events,[['board',7],['card',42],['thread',4]]);
  search.node('panel-dialog').open=true;await search.call('openContentSearchResult("2:4")');
  assert.deepEqual(search.events.at(-1),['request',8]);

  const race=runtime();race.call('showGlobalSearch()');race.node('global-kind').value='comment';
  const old=race.call('globalSearch("old")');race.node('global-kind').value='request';
  const fresh=race.call('globalSearch("new")');race.requests[1].resolve({items:[hit('request',1,{title:'Fresh'})]});await fresh;
  race.requests[0].resolve({items:[hit('comment',7,{title:'STALE_PRIVATE'})]});await old;
  assert(!race.node('global-results').innerHTML.includes('STALE_PRIVATE'));
  const late=race.call('globalSearch("account")');race.state.auth={user:{id:2}};
  race.requests[2].resolve({items:[hit('request',3,{title:'OTHER_ACCOUNT_PRIVATE'})]});await late;
  assert(!race.node('global-results').innerHTML.includes('OTHER_ACCOUNT_PRIVATE'));

  const panel=runtime();panel.call('showGlobalSearch()');panel.node('global-kind').value='form';
  const pending=panel.call('globalSearch("match")');panel.call('showGlobalSearch()');
  panel.requests[0].reject(new Error('STALE_PANEL_PRIVATE'));await pending;
  assert(!panel.node('global-results').textContent.includes('STALE_PANEL_PRIVATE'));
  panel.node('global-kind').value='form';const form=panel.call('globalSearch("match")');
  panel.requests[1].resolve({items:[hit('form',1)],next_cursor:'not-a-cursor'});await form;
  assert.equal(panel.state.globalSearch.next,null);
  await panel.call('openContentSearchResult("4:1")');assert.deepEqual(panel.events.at(-1),['form',9]);

  const navigation=runtime();navigation.call('showGlobalSearch()');navigation.node('global-kind').value='all';
  const load=navigation.call('globalSearch("match")');navigation.requests[0].resolve({items:[hit('request',1)]});await load;
  let finish;
  navigation.context.selectBoard=()=>new Promise(resolve=>{finish=resolve;});
  const open=navigation.call('openContentSearchResult("2:1")');navigation.state.panelSequence++;finish();await open;
  assert(!navigation.events.some(row=>row[0]==='request'),'Opening another panel prevents a late navigation result');
  navigation.state.auth={user:{id:2}};await navigation.call('openContentSearchResult("2:1")');
  assert(!navigation.events.some(row=>row[0]==='request'));

  const sameBoard=runtime();sameBoard.call('showGlobalSearch()');sameBoard.node('global-kind').value='all';
  const sameLoad=sameBoard.call('globalSearch("match")');sameBoard.requests[0].resolve({items:[hit('request',1)]});await sameLoad;
  let finishOld;
  sameBoard.context.selectBoard=()=>{sameBoard.state.loadSequence++;sameBoard.state.loading=true;return new Promise(resolve=>{finishOld=resolve;});};
  const staleOpen=sameBoard.call('openContentSearchResult("2:1")');
  sameBoard.state.loadSequence++;sameBoard.state.loading=true;finishOld();await staleOpen;
  assert(!sameBoard.events.some(row=>row[0]==='request'),'A later selection of the same board invalidates the old navigation');

  const unsafe=runtime();unsafe.call('showGlobalSearch()');unsafe.node('global-kind').value='all';
  const unsafeLoad=unsafe.call('globalSearch("match")');
  unsafe.requests[0].resolve({items:[hit('card',1,{title:'<script>Title</script>',board_name:'<img>',snippet:'<svg onload=attack()>'}),
    hit('unsupported',3,{key:'1:3'}),hit('form',1,{key:'" onclick=attack()'})]});await unsafeLoad;
  const markup=unsafe.node('global-results').innerHTML;
  assert(markup.includes('&lt;script&gt;'));assert(!markup.includes('<script>'));assert(!markup.includes('<svg'));
  assert(!markup.includes('onclick=attack()'));assert.equal((markup.match(/data-search-content=/g)||[]).length,1);
  console.log('Collaborative search UI: typed cursors, safe snippets, distinct source IDs, navigation and account/panel/query races verified.');
})().catch(error=>{console.error(error);process.exitCode=1;});
