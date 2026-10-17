'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseTrello,parseCSV,inspectCSV,limits} = require('../web/importers.js');
const csv = (input,mapping={title:0},options={}) => parseCSV(input,{name:'Synthetic import',mapping,...options});
const card = result => result.data.board.columns[0].cards[0];
const clone = value => JSON.parse(JSON.stringify(value));
function trello() {
  return {id:'board-1',name:'Synthetic board',desc:'A synthetic description',closed:false,
    lists:[{id:'list-b',idBoard:'board-1',name:'Later',pos:20,closed:true},
           {id:'list-a',idBoard:'board-1',name:'Now',pos:10,closed:false}],
    cards:[{id:'card-b',idList:'list-b',name:'Archived list card',pos:1,closed:false},
      {id:'card-a',idBoard:'board-1',idList:'list-a',name:'Caffè ☕ 日本語',desc:'First\nSecond',pos:20,
       due:'2028-02-29T23:00:00.000Z',start:'2028-02-28T12:00:00Z',dueComplete:true,closed:false,
       idChecklists:['checklist-a'],idMembers:['member-a'],idLabels:['label-a'],
       labels:[{id:'label-a',name:'External label',color:'red'}],
       attachments:[{url:'https://example.invalid/synthetic.txt'}]},
      {id:'card-c',idList:'list-a',name:'Before',pos:10,closed:true}],
    checklists:[{id:'checklist-a',idBoard:'board-1',idCard:'card-a',name:'Release',pos:1,
      checkItems:[{id:'item-b',idChecklist:'checklist-a',name:'Second item',pos:20,state:'incomplete'},
                  {id:'item-a',name:'First item',pos:10,state:'complete'}]}],
    members:[{id:'member-a',fullName:'Synthetic Member',username:'synthetic.member'}],
    labels:[{id:'label-a',name:'External label',color:'red'}],
    actions:[{type:'commentCard',data:{text:'Synthetic comment'}}]};
}

test('Trello preserves supported fields and stable list/card/checklist ordering without mutation',()=>{
  const input=trello(), before=clone(input), output=parseTrello(input);
  assert.deepEqual(input,before);
  assert.equal(output.data.format,'openboard'); assert.equal(output.data.version,2);
  assert.equal(output.data.board.name,input.name);
  assert.deepEqual(output.data.board.columns.map(value=>value.title),['Now','Later']);
  assert.deepEqual(output.data.board.columns[0].cards.map(value=>value.title),['Before','Caffè ☕ 日本語']);
  const converted=output.data.board.columns[0].cards[1];
  assert.equal(converted.assignee,'Synthetic Member'); assert.equal(converted.completed,true);
  assert.equal(converted.due_date,'2028-02-29'); assert.equal(converted.start_date,'2028-02-28');
  assert.deepEqual(converted.checklist,[{id:'item-a',text:'[Release] First item',done:true},{id:'item-b',text:'[Release] Second item',done:false}]);
  assert(converted.description.startsWith('First\nSecond')); assert(converted.description.includes('External label'));
  assert(!Object.hasOwn(converted,'labels')); assert(!Object.hasOwn(converted,'assignee_ids'));
  assert(!JSON.stringify(output.data).includes('example.invalid'));
  assert.deepEqual(output.counts,{columns:2,cards:3,checklistItems:2,archivedCards:2,completedCards:1});
  for(const part of ['Commenti','allegati','etichette','nomi dei membri','checklist','giorno UTC'])
    assert(output.warnings.some(value=>value.includes(part)),part);
});

test('Trello optional references derive owned checklists, member username and label color text',()=>{
  const input=trello(), value=input.cards[1];
  delete value.idChecklists; delete input.members[0].fullName;
  input.labels[0].name=''; value.labels[0].name='';
  const output=parseTrello(input).data.board.columns[0].cards[1];
  assert.equal(output.assignee,'synthetic.member'); assert.equal(output.checklist.length,2);
  assert(output.description.includes('[red]'));
});

test('Trello can use label references from the board catalogue only',()=>{
  const input=trello(); delete input.cards[1].labels;
  assert(parseTrello(input).data.board.columns[0].cards[1].description.includes('External label'));
});

test('Trello preserves empty checklist names in description and board archive state',()=>{
  const input=trello(); input.closed=true; input.checklists[0].checkItems=[];
  const output=parseTrello(input);
  assert.equal(output.data.board.archived,true);
  assert(output.data.board.columns[0].cards[1].description.includes('Trello checklists: Release'));
});

test('Trello unknown former member IDs remain display text without invented accounts',()=>{
  const input=trello(); input.members=[];
  assert.equal(parseTrello(input).data.board.columns[0].cards[1].assignee,'member-a');
});

test('Trello lists/cards/checklists reject duplicate IDs and orphan relationships',()=>{
  const changes=[
    x=>x.lists.push(clone(x.lists[0])),x=>x.cards.push(clone(x.cards[0])),
    x=>x.checklists.push(clone(x.checklists[0])),x=>x.cards[0].idList='missing',
    x=>x.cards[0].idBoard='other-board',x=>x.lists[0].idBoard='other-board',
    x=>x.checklists[0].idCard='missing',x=>x.checklists[0].idBoard='other-board',
    x=>x.cards[1].idChecklists=['missing'],x=>x.cards[1].idChecklists=[],
    x=>x.cards[1].idChecklists=['checklist-a','checklist-a'],
    x=>x.cards[0].idChecklists=['checklist-a'],
    x=>x.checklists[0].checkItems[0].idChecklist='other',
    x=>x.checklists[0].checkItems[1].id=x.checklists[0].checkItems[0].id,
    x=>x.cards[1].idMembers=['member-a','member-a'],
    x=>x.cards[1].idLabels=['missing'],x=>x.cards[1].idLabels=[],
    x=>x.cards[1].labels[0].name='conflicting name'
  ];
  for(const change of changes) { const input=trello(); change(input); assert.throws(()=>parseTrello(input),/duplicati|riferimenti/); }
});

test('Trello validates supported shapes, booleans, positions and checklist state',()=>{
  for(const change of [x=>delete x.lists,x=>delete x.cards,x=>x.cards[0].closed='false',
    x=>x.lists[0].pos=NaN,x=>x.cards[1].checklists=[],x=>x.checklists[0].checkItems[0].state='done']) {
    const input=trello(); change(input); assert.throws(()=>parseTrello(input));
  }
  for(const input of [null,[],{},'board']) assert.throws(()=>parseTrello(input));
  const input=trello(); input.self=input; assert.throws(()=>parseTrello(input));
});

test('Trello strict calendar validation and UTC-day conversion',()=>{
  for(const value of ['2025-02-29T12:00:00Z','2028-02-30T12:00:00Z','2028-02-29T24:00:00Z',
    '2028-02-29T12:60:00Z','2028-02-29T12:00:60Z','2028-02-29T12:00:00+25:00','yesterday','0000-01-01']) {
    const input=trello(); input.cards[1].due=value; assert.throws(()=>parseTrello(input),/Data importata/);
  }
  const input=trello(); input.cards[1].due='2028-03-01T00:30:00+02:00';
  assert.equal(parseTrello(input).data.board.columns[0].cards[1].due_date,'2028-02-29');
  input.cards[1].start='2028-03-02T00:00:00Z';
  assert.throws(()=>parseTrello(input),/Data importata/);
});

test('Trello enforces real Unicode field limits without truncation',()=>{
  const input=trello(); input.cards[1].name='😀'.repeat(300);
  assert.equal(parseTrello(input).data.board.columns[0].cards[1].title,input.cards[1].name);
  input.cards[1].name+='😀'; assert.throws(()=>parseTrello(input),/limiti/);
  for(const change of [x=>x.name='n'.repeat(201),x=>x.desc='d'.repeat(2001),
    x=>x.lists[0].name='l'.repeat(201),x=>x.cards[1].desc='d'.repeat(10001),
    x=>x.members[0].fullName='m'.repeat(101),x=>x.checklists[0].checkItems[0].name='i'.repeat(500)]) {
    const value=trello(); change(value); assert.throws(()=>parseTrello(value),/limiti/);
  }
});

test('Trello rejects checklist overflow and oversized input or converted payload',()=>{
  const input=trello(); input.checklists[0].checkItems=Array.from({length:101},(_,i)=>({id:'item-'+i,name:'x',state:'incomplete'}));
  assert.throws(()=>parseTrello(input),/100 elementi/);
  const large=trello(); large.unmapped='x'.repeat(limits.bytes); assert.throws(()=>parseTrello(large),/2 MiB/);
  const expanded={id:'board',name:'Board',lists:[{id:'list',name:'List'}],labels:[{id:'label',name:'x'.repeat(1000)}],
    cards:Array.from({length:2000},(_,index)=>({id:'card'+index,idList:'list',name:'x',idLabels:['label']}))};
  assert.throws(()=>parseTrello(expanded),/2 MiB/);
});

test('Trello supports empty boards and exactly 100 lists/10000 cards',()=>{
  assert.equal(parseTrello({id:'empty',name:'Empty',lists:[],cards:[]}).counts.cards,0);
  const input={id:'board',name:'Board',lists:Array.from({length:100},(_,index)=>({id:'list'+index,name:'List '+index})),
    cards:Array.from({length:10000},(_,index)=>({id:'card'+index,idList:'list'+(index%100),name:'x'}))};
  assert.equal(parseTrello(input).counts.cards,10000);
  input.cards.push({id:'extra',idList:'list0',name:'x'}); assert.throws(()=>parseTrello(input),/10000/);
});

test('CSV handles BOM, RFC quoted separators, doubled quotes and embedded CRLF',()=>{
  const input='\uFEFFtitle,list,description,due,priority,assignee,minutes\r\n"A, B","To do","First\r\n\"\"Second\"\"",2028-02-29,high,Synthetic Member,45\r\n';
  assert.deepEqual(inspectCSV(input),{headers:['title','list','description','due','priority','assignee','minutes'],width:7,rowCount:1,delimiter:','});
  const output=csv(input,{title:0,list:1,description:2,due_date:3,priority:4,assignee:5,estimate_minutes:6});
  assert.equal(card(output).title,'A, B'); assert.equal(card(output).description,'First\r\n"Second"');
  assert.equal(card(output).due_date,'2028-02-29'); assert.equal(card(output).priority,'high');
  assert.equal(card(output).estimate_minutes,45); assert.equal(card(output).assignee,'Synthetic Member');
});

test('CSV semicolon/no-header modes preserve explicit index mappings and first-seen list order',()=>{
  const input='first;Later\nsecond;Now\nthird;Later';
  assert.deepEqual(inspectCSV(input,{delimiter:';',header:false}).headers,['1','2']);
  const output=csv(input,{title:0,list:1},{delimiter:';',header:false});
  assert.deepEqual(output.data.board.columns.map(value=>value.title),['Later','Now']);
  assert.deepEqual(output.data.board.columns[0].cards.map(value=>value.title),['first','third']);
});

test('CSV blank optional cells use defaults and blank list uses the explicit fallback',()=>{
  const output=csv('title,list,description,due,priority,assignee,minutes\nFirst,,,,,,',
    {title:0,list:1,description:2,due_date:3,priority:4,assignee:5,estimate_minutes:6},{defaultList:'Inbox'});
  assert.equal(output.data.board.columns[0].title,'Inbox');
  assert.deepEqual(card(output),{title:'First',description:'',due_date:'',priority:'normal',assignee:'',estimate_minutes:0});
});

test('CSV refuses malformed quotes, inconsistent widths and invalid delimiters',()=>{
  for(const input of ['title\n"unfinished','title\nabc"def','title\n"x" trailing','a,b\nvalue','a\nvalue,extra','title\n\n'])
    assert.throws(()=>csv(input),/CSV|limiti/);
  for(const delimiter of ['\t','|','',',;']) assert.throws(()=>csv('title\nx',{title:0},{delimiter}),/CSV/);
  assert.throws(()=>inspectCSV(1)); assert.throws(()=>inspectCSV('title\nx',null));
});

test('CSV headers must be bounded, nonempty and unique after whitespace/case normalization',()=>{
  for(const input of ['title,title\nx,y','Title, title \nx,y','title,\nx,y',' ,title\nx,y']) assert.throws(()=>csv(input));
  assert.throws(()=>csv('x'.repeat(201)+'\nvalue'),/limiti/);
});

test('CSV explicit mappings reject duplicates, unknown fields and invalid indices',()=>{
  for(const mapping of [{},{title:null},{title:-1},{title:2},{title:0.5},{title:'0'},{title:0,list:0},{title:0,unknown:1}])
    assert.throws(()=>csv('title,list\nx,y',mapping),/Mappatura/);
  assert.throws(()=>parseCSV('title\nx'),/Mappatura/);
  assert.equal(csv('title,list\nx,y',{title:0,list:null}).counts.cards,1);
});

test('CSV validates calendar dates, canonical priorities and bounded integer estimates',()=>{
  for(const value of ['2025-02-29','2028-02-30','29/02/2028','0000-01-01','2028-02-29T00:00:00Z'])
    assert.throws(()=>csv('title,due\nx,'+value,{title:0,due_date:1}),/Data importata/);
  for(const value of ['-1','1.5','1e3','+1','100001','Infinity'])
    assert.throws(()=>csv('title,minutes\nx,'+value,{title:0,estimate_minutes:1}),/priorità o stima/);
  for(const priority of ['HIGH','critical','1']) assert.throws(()=>csv('title,priority\nx,'+priority,{title:0,priority:1}),/priorità o stima/);
  assert.equal(card(csv('title,minutes\nx,100000',{title:0,estimate_minutes:1})).estimate_minutes,100000);
  assert.equal(card(csv('title,due\nx,0001-01-01',{title:0,due_date:1})).due_date,'0001-01-01');
});

test('CSV formula-like values and HTML remain literal text; unmapped columns are explicit',()=>{
  const output=csv('title,description,ignored\n=globalThis.importFormulaExecuted=true,<script>synthetic</script>,unmapped',{title:0,description:1});
  assert.equal(globalThis.importFormulaExecuted,undefined);
  assert.equal(card(output).title,'=globalThis.importFormulaExecuted=true');
  assert.equal(card(output).description,'<script>synthetic</script>');
  assert(output.warnings.some(value=>value.includes('formule')));
  assert(output.warnings.some(value=>value.includes('non mappate')));
  assert(!JSON.stringify(output.data).includes('unmapped'));
});

test('CSV respects list/card/source/output limits and does not silently skip blank records',()=>{
  assert.throws(()=>csv('title\n'),/non contiene/);
  assert.throws(()=>csv('title\n   '),/limiti/);
  assert.throws(()=>csv('title\n'+ 'x'.repeat(limits.bytes)),/2 MiB/);
  assert.throws(()=>csv('title,list\n'+Array.from({length:101},(_,i)=>'x,list'+i).join('\n'),{title:0,list:1}),/100 liste/);
  const input='title\n'+Array.from({length:10000},()=> 'x').join('\n');
  assert.equal(csv(input).counts.cards,10000);
  assert.throws(()=>csv(input+'\nx'),/10000/);
  assert.throws(()=>inspectCSV(Array.from({length:10001},()=> 'x').join('\n'),{header:false}),/10000/);
  const expanded='title,description\n'+Array.from({length:10000},()=> 'x,'+'d'.repeat(120)).join('\n');
  assert.throws(()=>csv(expanded,{title:0,description:1}),/2 MiB/);
});

test('Converters reject NUL/unpaired surrogate text and enforce all output field lengths',()=>{
  for(const value of ['NUL\0name','unpaired\uD800']) {
    assert.throws(()=>csv('title\n'+value),/Unicode/);
    const input=trello(); input.name=value; assert.throws(()=>parseTrello(input),/Unicode/);
  }
  for(const [field,limit] of [['title',300],['description',10000],['assignee',100]])
    assert.throws(()=>csv('title,other\nx,'+'日'.repeat(limit+1),{title:0,[field]:1}),/limiti/);
  assert.throws(()=>csv(Array.from({length:101},(_,i)=>'c'+i).join(',')+'\n'+Array.from({length:101},()=> 'x').join(',')),/CSV/);
});

test('Browser build exposes the same pure APIs without DOM, fetch or dependencies',()=>{
  const context={TextEncoder,Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/importers.js'),'utf8'),context);
  assert.equal(typeof context.OpenBoardImporters.parseTrello,'function');
  assert.equal(context.OpenBoardImporters.parseCSV('title\nx',{mapping:{title:0}}).counts.cards,1);
  assert.equal(context.document,undefined); assert.equal(context.fetch,undefined);
});

test('Every converter warning/error has canonical source and six translations',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/importers.js'),'utf8');
  const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../locales/importers.json'),'utf8'));
  const messages=[...source.matchAll(/(?:fail|warnings\.add)\('([^']+)'\)/g)].map(match=>match[1]);
  assert(messages.length>20);
  for(const message of new Set(messages)) {
    assert(Object.hasOwn(catalog,message),message);
    assert.equal(catalog[message].length,6);
    assert(catalog[message].every(value=>typeof value==='string' && value.trim()));
    assert.equal(message,message.trim().split(/\s+/).join(' '));
  }
});
