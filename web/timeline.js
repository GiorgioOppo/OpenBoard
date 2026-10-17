/* SPDX-License-Identifier: MIT — UTC date geometry and a read-only board timeline.
 * No scheduling guesses, date writes, N+1 requests or virtualization claims.
 * UI bounds: 7/28..31 days, 100 scheduled + 100 undated rows, 2000 edges.
 * The dependency read is separate from the board summary; board.version alone
 * does not version card edits. Cache keys include board object identity/load.
 */
(function(root){
  'use strict';
  const DAY=86400000,ROWS=100,EDGES=2000;
  function ordinal(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'0001-01-01'||value>'9999-12-31')return null;
    const parsed=new Date(value+'T00:00:00Z');
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?Math.floor(parsed.getTime()/DAY):null;
  }
  const MIN=ordinal('0001-01-01'),MAX=ordinal('9999-12-31');
  const clamp=value=>Math.max(MIN,Math.min(MAX,value));
  const iso=value=>Number.isInteger(value)&&value>=MIN&&value<=MAX?new Date(value*DAY).toISOString().slice(0,10):null;
  const today=()=>new Date().toISOString().slice(0,10);
  function period(mode,anchor,shift=0){
    const day=ordinal(anchor);
    if(day===null||!['week','month'].includes(mode)||![-1,0,1].includes(shift))return null;
    let chosen=anchor,start,end;
    if(mode==='week'){
      chosen=iso(clamp(day+shift*7));const current=ordinal(chosen),weekday=(new Date(current*DAY).getUTCDay()+6)%7;
      start=Math.max(MIN,current-weekday);end=Math.min(MAX,start+6);
    }else{
      const year=Number(anchor.slice(0,4)),month=Number(anchor.slice(5,7));
      const offset=Math.max(0,Math.min(9999*12-1,(year-1)*12+month-1+shift));
      const y=Math.floor(offset/12)+1,m=offset%12+1,prefix=String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0');
      start=ordinal(prefix+'-01');
      const next=offset===9999*12-1?MAX+1:ordinal(String(Math.floor((offset+1)/12)+1).padStart(4,'0')+'-'+String((offset+1)%12+1).padStart(2,'0')+'-01');
      end=next-1;chosen=prefix+'-'+String(Math.min(Number(anchor.slice(8)),end-start+1)).padStart(2,'0');
    }
    return {mode,anchor:chosen,start:iso(start),end:iso(end),first:start,last:end,
      days:Array.from({length:end-start+1},(_,index)=>iso(start+index)),previous:start>MIN,next:end<MAX};
  }
  function schedule(card){
    const start=ordinal(card.start_date),due=ordinal(card.due_date);
    if((card.start_date&&start===null)||(card.due_date&&due===null)||(start!==null&&due!==null&&start>due))return {kind:'invalid'};
    if(start===null&&due===null)return {kind:'undated'};
    if(start===null)return {kind:'due',from:due,to:due};
    if(due===null)return {kind:'start',from:start,to:start};
    return {kind:'range',from:start,to:due};
  }
  function page(values,index){
    const pages=Math.max(1,Math.ceil(values.length/ROWS)),current=Math.max(0,Math.min(pages-1,Number.isInteger(index)?index:0));
    return {items:values.slice(current*ROWS,(current+1)*ROWS),index:current,pages,total:values.length};
  }
  function model(board,options={}){
    const window=period(options.mode||'month',options.anchor||today());
    if(!window)throw new RangeError('Invalid timeline period');
    const visible=new Map(),scheduled=[],undated=[];
    for(const column of Array.isArray(board?.columns)?board.columns:[]){
      if(!column||column.deleted_at)continue;
      for(const card of Array.isArray(column.cards)?column.cards:[]){
        if(!card||!Number.isSafeInteger(card.id)||card.id<1||card.deleted_at||visible.has(card.id)||
          (typeof options.matches==='function'&&!options.matches(card)))continue;
        visible.set(card.id,{card,column:String(column.title??''),...schedule(card),requires:[]});
      }
    }
    let outside=0;
    for(const value of visible.values()){
      if(['invalid','undated'].includes(value.kind))undated.push(value);
      else if(value.from<=window.last&&value.to>=window.first){
        const left=Math.max(value.from,window.first)-window.first,right=Math.min(value.to,window.last)-window.first+1;
        value.left=value.kind==='range'?left/window.days.length*100:(left+.5)/window.days.length*100;
        value.width=value.kind==='range'?(right-left)/window.days.length*100:0;
        value.clipped=value.from<window.first||value.to>window.last;scheduled.push(value);
      }else outside++;
    }
    scheduled.sort((a,b)=>a.from-b.from||a.to-b.to||a.card.id-b.card.id);
    const edges=Array.isArray(options.edges)?options.edges:[],known=new Set();
    for(const edge of edges.slice(0,EDGES)){
      if(!edge||!visible.has(edge.card_id)||!visible.has(edge.required_card_id)||edge.card_id===edge.required_card_id)continue;
      const key=edge.card_id+':'+edge.required_card_id;
      if(!known.has(key)){known.add(key);visible.get(edge.card_id).requires.push(visible.get(edge.required_card_id).card);}
    }
    return {window,scheduled:page(scheduled,options.page),undated:page(undated,options.undatedPage),outside,
      truncated:!!options.truncated||edges.length>EDGES,visible};
  }
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const source=(value,...args)=>value.replace(/\{(\d+)\}/g,(_,index)=>String(args[index]??''));
  function render(value,{tr=source,locale='it',loading=false,error=''}={}){
    const h=escape,w=value.window;
    const date=day=>{const number=ordinal(day);return number===null?'—':new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(number*DAY));};
    const label=row=>row.kind==='range'?date(iso(row.from))+' → '+date(iso(row.to)):row.kind==='start'?tr('Solo inizio: {0}',date(iso(row.from))):row.kind==='due'?tr('Solo scadenza: {0}',date(iso(row.from))):row.kind==='invalid'?tr('Date non valide'):tr('Senza date');
    const open=card=>'<button type="button" class="timeline-card-open" id="timeline-card-'+card.id+'" data-timeline-card="'+card.id+'">'+h(card.title)+'</button>';
    const dependencies=row=>loading||error?h(tr('Dipendenze non disponibili.')):row.requires.length?row.requires.slice(0,3).map(card=>'<button type="button" class="timeline-dependency" data-timeline-card="'+card.id+'">'+h(tr('Richiede: {0}',String(card.title??'')))+'</button>').join('')+(row.requires.length>3?'<span>'+h(tr('Altre dipendenze: {0}',row.requires.length-3))+'</span>':''):h(tr('Nessuna dipendenza visibile'));
    const pagination=(group,kind)=>'<div class="timeline-pagination"><span>'+h(tr('Mostrate {0} di {1} schede',group.items.length,group.total))+' · '+h(tr('Pagina {0} di {1}',group.index+1,group.pages))+'</span><button id="timeline-'+kind+'-prev" type="button" data-timeline-page="'+kind+'" data-timeline-offset="-1" '+(group.index===0?'disabled':'')+'>'+h(tr('Pagina precedente'))+'</button><button id="timeline-'+kind+'-next" type="button" data-timeline-page="'+kind+'" data-timeline-offset="1" '+(group.index+1===group.pages?'disabled':'')+'>'+h(tr('Pagina successiva'))+'</button></div>';
    const rows=(group,bars)=>group.items.map(row=>'<tr class="'+(row.card.completed?'timeline-completed':'')+'"><th scope="row">'+open(row.card)+(row.card.archived?'<span class="timeline-status">'+h(tr('Archiviata'))+'</span>':'')+'</th><td>'+h(row.column)+'</td><td>'+h(label(row))+(row.clipped?'<span class="timeline-status">'+h(tr('Intervallo tagliato dalla finestra visibile'))+'</span>':'')+'</td><td>'+dependencies(row)+'</td>'+(bars?'<td class="timeline-chart-cell"><div class="timeline-track" style="--timeline-days:'+w.days.length+'" aria-hidden="true"><span class="'+(row.kind==='range'?'timeline-bar':'timeline-anchor')+'" style="left:'+row.left.toFixed(4)+'%;'+(row.kind==='range'?'width:'+row.width.toFixed(4)+'%;':'')+'"></span></div></td>':'')+'</tr>').join('');
    const table=(group,bars)=>'<div class="timeline-table-scroll" tabindex="0" role="region" aria-label="'+h(bars?tr('Schede nel periodo'):tr('Schede senza date'))+'"><table class="timeline-table"><caption>'+h(bars?tr('Schede nel periodo'):tr('Schede senza date'))+'</caption><thead><tr><th scope="col">'+h(tr('Scheda'))+'</th><th scope="col">'+h(tr('Lista'))+'</th><th scope="col">'+h(tr('Date'))+'</th><th scope="col">'+h(tr('Dipendenze'))+'</th>'+(bars?'<th scope="col" class="timeline-ruler"><div>'+w.days.map(day=>'<span><time datetime="'+day+'">'+new Intl.NumberFormat(locale).format(Number(day.slice(8)))+'</time></span>').join('')+'</div></th>':'')+'</tr></thead><tbody>'+rows(group,bars)+'</tbody></table></div>';
    return '<section class="timeline-view"><h2>'+h(tr('Timeline della bacheca'))+'</h2><div class="timeline-controls"><label for="timeline-mode">'+h(tr('Periodo'))+'</label><select id="timeline-mode"><option value="week" '+(w.mode==='week'?'selected':'')+'>'+h(tr('Settimana'))+'</option><option value="month" '+(w.mode==='month'?'selected':'')+'>'+h(tr('Mese'))+'</option></select><label for="timeline-anchor">'+h(tr('Data di riferimento'))+'</label><input id="timeline-anchor" type="date" min="0001-01-01" max="9999-12-31" value="'+w.anchor+'"><button id="timeline-prev" type="button" data-timeline-shift="-1" '+(!w.previous?'disabled':'')+'>'+h(tr('Periodo precedente'))+'</button><button id="timeline-next" type="button" data-timeline-shift="1" '+(!w.next?'disabled':'')+'>'+h(tr('Periodo successivo'))+'</button><button id="timeline-today" type="button" data-timeline-today>'+h(tr('Oggi'))+'</button><button id="timeline-refresh" type="button" data-timeline-refresh>'+h(tr('Aggiorna dipendenze'))+'</button></div><p>'+h(date(w.start))+' → '+h(date(w.end))+' · UTC</p><p class="timeline-note">'+h(tr('Solo lettura: le date non vengono modificate. Le date singole sono ancore, non durate stimate.'))+'</p><p class="timeline-note">'+h(tr('Le dipendenze sono lette separatamente dalle schede; aggiorna la bacheca per riallineare i dati.'))+'</p>'+(loading?'<p class="timeline-note" role="status">'+h(tr('Caricamento dipendenze…'))+'</p>':'')+(error?'<p class="timeline-error" role="alert">'+h(error)+'</p>':'')+(value.truncated?'<p class="timeline-error" role="status">'+h(tr('Mostrate al massimo 2000 dipendenze; il grafo può essere incompleto.'))+'</p>':'')+'<p>'+h(tr('Schede fuori dal periodo: {0}',value.outside))+'</p>'+(value.scheduled.total?table(value.scheduled,true)+pagination(value.scheduled,'planned'):'<p>'+h(tr('Nessuna scheda nel periodo con questi filtri.'))+'</p>')+'<h3>'+h(tr('Schede senza date'))+'</h3>'+(value.undated.total?table(value.undated,false)+pagination(value.undated,'undated'):'<p>'+h(tr('Nessuna scheda senza date con questi filtri.'))+'</p>')+'</section>';
  }
  const api={ordinal,iso,period,schedule,model,render,today,rows:ROWS,edges:EDGES};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.OpenBoardTimeline=api;
})(typeof globalThis!=='undefined'?globalThis:this);

/* UI bindings deliberately execute only when app.js calls renderTimeline(). */
function timelineReadable(){return !!state.board&&Number.isSafeInteger(Number(state.board.id))&&Number(state.board.id)>0&&(!state.auth?.enabled||!!state.auth.user)&&['admin','member','observer'].includes(state.board.role||'admin');}
function timelineSettings(){if(!state.timelineSettings)state.timelineSettings={mode:'month',anchor:OpenBoardTimeline.today(),page:0,undatedPage:0};return state.timelineSettings;}
function timelineCurrent(record){return !!record&&timelineReadable()&&state.view==='timeline'&&!state.loading&&state.timeline===record&&state.board===record.board&&state.loadSequence===record.load&&state.timelineSequence===record.view&&sessionCurrent(record.session)&&record.archive===!!(state.archived||state.archivedBoards);}
function renderTimeline(){
  const previousFocus=document.activeElement?.id;
  if(previousFocus?.startsWith('timeline-'))state.timelineFocus=previousFocus;
  const settings=timelineSettings(),archive=!!(state.archived||state.archivedBoards);
  let record=state.timeline;
  if(!record||record.board!==state.board||record.load!==state.loadSequence||record.view!==state.timelineSequence||record.archive!==archive||!sessionCurrent(record.session)){
    record=state.timeline={board:state.board,load:state.loadSequence,view:state.timelineSequence,archive,session:sessionContext(),edges:[],loaded:false,loading:false,error:'',truncated:false,forbidden:false};
    settings.page=0;settings.undatedPage=0;
  }
  const value=OpenBoardTimeline.model(record.forbidden?{columns:[]}:state.board,{...settings,matches,edges:record.edges,truncated:record.truncated});
  settings.page=value.scheduled.index;settings.undatedPage=value.undated.index;
  state.timelineVisible=value.visible;state.timelineRendered=record;
  return OpenBoardTimeline.render(value,{tr,locale:OpenBoardI18n.locale,loading:!record.loaded&&!record.error,error:record.error});
}
function timelineAfterRender(){
  const focus=state.timelineFocus;state.timelineFocus=null;
  if(focus&&/^timeline-[a-z0-9-]+$/.test(focus))document.getElementById(focus)?.focus({preventScroll:true});
  const record=state.timeline;
  if(timelineCurrent(record)&&!record.loaded&&!record.loading&&!record.error)void loadTimelineDependencies(record);
}
async function loadTimelineDependencies(record){
  if(!timelineCurrent(record)||record.loading)return;
  record.loading=true;
  try{
    const result=await api(`/api/boards/${Number(record.board.id)}/timeline?include_archived=${record.archive?1:0}`);
    if(!timelineCurrent(record))return;
    if(!result||!Number.isSafeInteger(result.board_id)||result.board_id!==Number(record.board.id)||!Array.isArray(result.dependencies)||result.dependencies.length>2000||typeof result.truncated!=='boolean'||result.dependencies.some(edge=>!edge||!Number.isSafeInteger(edge.card_id)||edge.card_id<1||!Number.isSafeInteger(edge.required_card_id)||edge.required_card_id<1))throw new Error(tr('Risposta della timeline non valida.'));
    record.edges=result.dependencies;record.truncated=result.truncated;record.loaded=true;record.error='';record.forbidden=false;
  }catch(error){if(timelineCurrent(record)&&!error.staleSession){record.edges=[];record.loaded=false;record.error=error.message;record.forbidden=[401,403,404].includes(error.status);}}
  finally{record.loading=false;if(timelineCurrent(record))renderBoard();}
}
if(typeof document!=='undefined'){
  document.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target||target.disabled||state.saving||!timelineCurrent(state.timelineRendered))return;
    const settings=timelineSettings();
    if(target.dataset.timelineCard){const id=Number(target.dataset.timelineCard);if(state.timelineVisible?.has(id))void openCard(id);return;}
    if(target.dataset.timelineShift&&['-1','1'].includes(target.dataset.timelineShift)){settings.anchor=OpenBoardTimeline.period(settings.mode,settings.anchor,Number(target.dataset.timelineShift)).anchor;settings.page=0;}
    else if(target.hasAttribute('data-timeline-today')){settings.anchor=OpenBoardTimeline.today();settings.page=0;}
    else if(target.dataset.timelinePage&&['planned','undated'].includes(target.dataset.timelinePage)&&['-1','1'].includes(target.dataset.timelineOffset)){const key=target.dataset.timelinePage==='planned'?'page':'undatedPage';settings[key]+=Number(target.dataset.timelineOffset);}
    else if(target.hasAttribute('data-timeline-refresh')){state.timeline.loaded=false;state.timeline.error='';state.timeline.edges=[];}
    else return;
    state.timelineFocus=target.id;renderBoard();
  });
  document.addEventListener('change',event=>{
    if(state.saving||!timelineCurrent(state.timelineRendered))return;
    const target=event.target,settings=timelineSettings();
    if(target.id==='timeline-mode'&&['month','week'].includes(target.value))settings.mode=target.value;
    else if(target.id==='timeline-anchor'&&OpenBoardTimeline.ordinal(target.value)!==null)settings.anchor=target.value;
    else return;
    settings.page=0;state.timelineFocus=target.id;renderBoard();
  });
  document.addEventListener('keydown',event=>{
    if(event.isComposing||!timelineCurrent(state.timelineRendered)||!event.target.matches?.('.timeline-card-open')||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    const buttons=Array.from(document.querySelectorAll('.timeline-card-open')),index=buttons.indexOf(event.target);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowDown'?1:-1)));
    if(buttons[next]){event.preventDefault();buttons[next].focus();}
  });
}
