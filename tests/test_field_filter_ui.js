'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const productivity=require('../web/productivity.js'),i18n=require('./i18n-runtime.cjs');
const planning=fs.readFileSync(require.resolve('../web/planning.js'),'utf8'),app=fs.readFileSync(require.resolve('../web/app.js'),'utf8');
const html=fs.readFileSync(require.resolve('../web/index.html'),'utf8');
const fields=[{key:'cost',name:'Cost',type:'number',position:0},{key:'flag',name:'Flag',type:'boolean',position:1},{key:'launch',name:'Launch',type:'date',position:2},{key:'note',name:'<script>name</script>',type:'text',position:3},{key:'region',name:'Region',type:'select',options:['España','<script>value</script>'],position:4},{key:'constructor',name:'Constructor',type:'text',position:5},{key:'prototype',name:'Prototype',type:'text',position:6}];
function runtime() {
 const nodes=new Map(),listeners=new Map();let renders=0,replacements=0;
 const element=id=>({id,dataset:{},value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,tagName:'SELECT',attributes:{},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},focus(){context.document.activeElement=this;}});
 for(const id of ['milestone-filter','custom-filter-key','custom-filter-op','custom-filter-value-label','custom-filter-error','custom-filter-hint','search-input','label-filter','assignee-filter','priority-filter','status-filter','sort-filter'])nodes.set(id,element(id));
 const holder=element('custom-filter-value-holder');let holderHTML='';
 Object.defineProperty(holder,'innerHTML',{get(){return holderHTML;},set(value){holderHTML=value;replacements++;const input=element('custom-filter-value');input.tagName=value.startsWith('<select')?'SELECT':'INPUT';input.type=(value.match(/type="([^"]*)"/)||[])[1]||'';input.markup=value;nodes.set(input.id,input);}});nodes.set(holder.id,holder);
 const context={...i18n,productivity,Number,Object,Array,JSON,state:{board:{id:7,custom_fields:structuredClone(fields),milestones:[]},query:'',label:'',assignee:'',priority:'',status:'',sort:'manual',milestone:'',customKey:'',customQuery:'',customOp:'',auth:{enabled:true,user:{id:8,role:'observer'}}},
  escapeHTML:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
  document:{activeElement:null,querySelectorAll:()=>[],addEventListener(name,listener){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(listener);}},
  $:id=>nodes.get(id)||null,renderBoard(){renders++;},assignmentNames:()=>[],cardLabels:()=>[],overdue:()=>false};
 vm.createContext(context);vm.runInContext(planning,context);
 vm.runInContext(app.slice(app.indexOf('function matches(card) {'),app.indexOf('function sorted(cards) {')),context);
 vm.runInContext(app.slice(app.indexOf('function clearFilters(render = true) {'),app.indexOf('function closeMenus() {')),context);
 const run=source=>vm.runInContext(source,context),fire=(type,id,value)=>{const target=nodes.get(id);if(value!==undefined)target.value=value;for(const listener of listeners.get(type)||[])listener({target});};
 return {context,nodes,run,fire,get renders(){return renders;},get replacements(){return replacements;}};
}
const r=runtime(),state=r.context.state,card=values=>({title:'Card',custom_values:values});
const choose=(key,op='',value='')=>{state.customKey=key;state.customOp=op;state.customQuery=value;r.run('renderPlanningFilters()');};
const matches=values=>{r.context.card=card(values);return r.run('matches(card)');};
choose('cost','gte','10');assert(matches({cost:10}));assert(!matches({cost:9}));assert(!matches({cost:'10'}));assert(!matches({}));
for(const invalid of ['+1','01','0x10',' 10','10 ','','NaN','Infinity','1e13','1_000','.5','1.']) {choose('cost','gte',invalid);assert(!matches({cost:10}),invalid);assert(!r.nodes.get('custom-filter-error').hidden,invalid);assert.equal(r.nodes.get('custom-filter-value').attributes['aria-invalid'],'true');}
for(const valid of ['0','-0','-1.25','1e2','1E+2']) {choose('cost','gte',valid);assert(r.nodes.get('custom-filter-error').hidden,valid);}
choose('flag','eq','false');assert.equal(r.nodes.get('custom-filter-value').tagName,'SELECT');assert(matches({flag:false}));assert(!matches({flag:0}));assert(!matches({flag:true}));
r.fire('change','custom-filter-value','true');assert(matches({flag:true}));assert.equal(state.customQuery,'true');
for(const invalid of ['1','FALSE','']) {choose('flag','eq',invalid);assert(!matches({flag:false}));}
choose('launch','gte','2028-02-29');assert.equal(r.nodes.get('custom-filter-value').type,'date');assert(matches({launch:'2028-03-01'}));assert(!matches({launch:'2028-02-28'}));
choose('launch','gte','2027-02-29');assert(!matches({launch:'2028-01-01'}));choose('launch','gte','0000-01-01');assert(!matches({launch:'0001-01-01'}));
choose('region','eq','España');assert.equal(r.nodes.get('custom-filter-value').tagName,'SELECT');assert(matches({region:'España'}));assert(!r.nodes.get('custom-filter-value-holder').innerHTML.includes('<script>'));
choose('region','contains','paña');assert.equal(r.nodes.get('custom-filter-value').type,'text');assert(matches({region:'España'}));
choose('note','contains','Caffè');assert(matches({note:'Caffè ☕'}));assert(!matches({note:'CAFFÈ ☕'}));assert(!r.nodes.get('custom-filter-hint').hidden);
choose('note','','CAFFÈ');assert(matches({note:'Caffè ☕'}));assert.equal(r.nodes.get('custom-filter-value').type,'search');
choose('flag','','no');assert(matches({flag:false}));assert(!matches({flag:true}));
choose('cost','is_unset','retained');assert(matches({}));assert(matches({cost:null}));assert(!matches({cost:0}));assert(r.nodes.get('custom-filter-value-label').hidden);assert(r.nodes.get('custom-filter-value').disabled);
choose('constructor','is_set');assert(!matches({}));assert(!matches(Object.create({constructor:'inherited'})));assert(matches(JSON.parse('{"constructor":"owned"}')));
choose('constructor','is_unset');assert(matches({}));choose('prototype','is_set');assert(!matches({}));assert(matches({prototype:''}));
choose('note','eq','');assert(matches({note:''}));assert(!matches({}));
choose('note','eq','x\0');assert(!matches({note:'x'}));choose('note','eq','\uD800');assert(!matches({note:'x'}));
choose('cost','gte','10');const input=r.nodes.get('custom-filter-value'),before=r.replacements;input.focus();input.selectionStart=1;input.selectionEnd=1;
r.fire('input','custom-filter-value','12');assert.equal(state.customQuery,'12');assert.equal(r.nodes.get('custom-filter-value'),input);assert.equal(r.replacements,before);assert.equal(r.context.document.activeElement,input);assert.equal(input.selectionStart,1);
state.board.custom_fields=structuredClone(fields);state.board.custom_fields[0].name='Renamed';r.run('renderPlanningFilters()');assert.equal(r.nodes.get('custom-filter-value'),input);assert.equal(r.replacements,before);
state.board.custom_fields[0].type='date';r.run('renderPlanningFilters()');assert.notEqual(r.nodes.get('custom-filter-value'),input);assert.equal(r.nodes.get('custom-filter-value').type,'date');
choose('region','eq','España');const oldSelect=r.nodes.get('custom-filter-value');state.board.custom_fields.find(field=>field.key==='region').options=['Italia'];r.run('renderPlanningFilters()');assert.notEqual(r.nodes.get('custom-filter-value'),oldSelect);assert(!matches({region:'España'}));
choose('cost','gte','25');r.fire('change','custom-filter-key','note');assert.equal(state.customOp,'');assert.equal(state.customQuery,'25');assert.equal(r.nodes.get('custom-filter-value').type,'search');
r.fire('change','custom-filter-op','eq');assert.equal(state.customOp,'eq');assert(matches({note:'25'}));
state.board.custom_fields.find(field=>field.key==='note').deleted_at='now';r.run('renderPlanningFilters()');assert(!matches({note:'25'}));assert(!r.nodes.get('custom-filter-error').hidden);assert(r.nodes.get('custom-filter-op').disabled);
choose('flag','eq','false');r.run('clearFilters(false)');assert.equal(state.customKey,'');assert.equal(state.customQuery,'');assert.equal(state.customOp,'');assert(r.nodes.get('custom-filter-error').hidden);assert(r.nodes.get('custom-filter-op').disabled);assert(matches({}));
state.board=null;state.auth={enabled:true,user:{id:9,role:'observer'}};r.run('clearFilters(false)');assert.equal(r.nodes.get('custom-filter-value').value,'');assert.equal(state.customOp,'');
assert(!r.nodes.get('custom-filter-key').innerHTML.includes('<script>'));assert(r.renders>0);
for(const id of ['custom-filter-op','custom-filter-value-holder','custom-filter-value-label','custom-filter-error','custom-filter-hint'])assert(html.includes(`id="${id}"`));
assert(html.includes('aria-describedby="custom-filter-error custom-filter-hint"'));assert(html.includes('aria-live="polite"'));
console.log('Typed field filter toolbar, safe lookups, handlers, polling focus and reset verified.');
