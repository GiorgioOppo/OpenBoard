/* Pure, bounded three-way comparison of the full card editor's fields.
 * Array groups remain atomic; custom values are compared one key at a time.
 * Nothing here reads the DOM, sends requests or changes a resource version. */
(function(root) {
  'use strict';
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const fields=Object.freeze(['title','description','column_id','assignee','due_date','cover','completed','start_date','blocked_reason','actual_minutes','reference_url','milestone_key','priority','estimate_minutes','labels','assignee_ids','checklist']);
  const limits={title:300,description:10000,assignee:100,due_date:10,cover:20,start_date:10,blocked_reason:1000,reference_url:2000,milestone_key:40,priority:10,label:30};
  const invalid=()=>{throw new Error('invalid_card_snapshot');};
  const text=(value,maximum)=>{
    if(typeof value!=='string'||Array.from(value).length>maximum||Array.from(value).some(char=>!char.codePointAt(0)||(char.codePointAt(0)>=0xD800&&char.codePointAt(0)<=0xDFFF)))invalid();
    return value;
  };
  const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const canonical=value=>value===undefined?'undefined':JSON.stringify(value,(_,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  const equal=(a,b)=>canonical(a)===canonical(b);
  const customValue=(data,key)=>data?.custom_values&&own(data.custom_values,key)?data.custom_values[key]:undefined;
  function snapshot(card) {
    if(!object(card))invalid();
    const result={};
    for(const [key,maximum]of Object.entries(limits))result[key]=text(card[key]??(key==='priority'?'normal':''),maximum);
    for(const key of ['title','assignee','blocked_reason','reference_url'])result[key]=result[key].trim();
    for(const key of ['column_id','actual_minutes','estimate_minutes']){
      const value=card[key]??0;if(!Number.isSafeInteger(value)||Math.abs(value)>1e12)invalid();result[key]=value;
    }
    if(card.completed!==undefined&&typeof card.completed!=='boolean')invalid();result.completed=!!card.completed;
    const labels=card.labels??[];if(!Array.isArray(labels)||labels.length>30)invalid();
    result.labels=[...new Set([result.label,...labels.map(value=>text(value,30))].filter(Boolean))].sort();
    const ids=card.assignee_ids??[];if(!Array.isArray(ids)||ids.length>100||ids.some(value=>!Number.isSafeInteger(value)||value<1)||new Set(ids).size!==ids.length)invalid();result.assignee_ids=[...ids].sort((a,b)=>a-b);
    const checklist=card.checklist??[];if(!Array.isArray(checklist)||checklist.length>100)invalid();
    result.checklist=checklist.map(item=>{if(!object(item)||typeof item.done!=='boolean')invalid();return {id:text(item.id,100),text:text(item.text,500).trim(),done:item.done};});
    if(result.checklist.some(item=>!item.id||!item.text)||new Set(result.checklist.map(item=>item.id)).size!==result.checklist.length)invalid();
    const custom=card.custom_values??{};if(!object(custom)||Object.keys(custom).length>100)invalid();
    result.custom_values=Object.fromEntries(Object.entries(custom).filter(([key,value])=>{
      if(!/^[a-z][a-z0-9_]{0,39}$/.test(key)||!(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12)||typeof value==='string'))invalid();
      if(typeof value==='string')text(value,2000);return value!==null;
    }));
    return result;
  }
  const value=(data,key)=>key==='labels'?{label:data.label,labels:data.labels}:data[key];
  function compare(base,local,server) {
    const initial=base===null||base===undefined?null:snapshot(base),left=snapshot(local),right=snapshot(server),rows=[];
    const add=(key,custom=false)=>{
      const get=data=>custom?customValue(data,key):value(data,key),a=initial?get(initial):undefined,b=get(left),c=get(right);
      const automatic=equal(b,c)?'same':initial&&equal(b,a)?'server':initial&&equal(c,a)?'local':null;
      rows.push({key,custom,base:clone(a),local:clone(b),server:clone(c),automatic});
    };
    for(const key of fields)add(key);
    const keys=[...new Set([...(initial?Object.keys(initial.custom_values):[]),...Object.keys(left.custom_values),...Object.keys(right.custom_values)])].sort();
    for(const key of keys)add(key,true);
    return {base:initial,local:left,server:right,rows};
  }
  function resolve(plan,choices={}) {
    const merged=clone(plan.server),unresolved=[];
    plan.rows.forEach((row,index)=>{
      const choice=row.automatic==='same'?'server':row.automatic||(own(choices,index)?choices[index]:undefined);
      if(choice!=='local'&&choice!=='server'){unresolved.push(index);return;}
      const selected=clone(row[choice]);
      if(row.custom){if(selected===undefined)delete merged.custom_values[row.key];else Object.defineProperty(merged.custom_values,row.key,{value:selected,writable:true,enumerable:true,configurable:true});}
      else if(row.key==='labels'){merged.label=selected.label;merged.labels=selected.labels;}
      else merged[row.key]=selected;
    });
    return {data:unresolved.length?null:snapshot(merged),unresolved};
  }
  const api=Object.freeze({snapshot,compare,resolve,equal,customValue,fields});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.OpenBoardConflicts=api;
})(typeof globalThis!=='undefined'?globalThis:this);
