'use strict';

/* Translate authored interface text before inserting dynamic values. Board
 * titles, comments, field names and other user data never enter the catalogue. */
(function (root) {
  const languages = [
    {code:'en',name:'English'}, {code:'it',name:'Italiano'},
    {code:'fr',name:'Français'}, {code:'es',name:'Español'},
    {code:'de',name:'Deutsch'}, {code:'zh-CN',name:'简体中文'},
    {code:'ja',name:'日本語'}
  ];
  const codes = ['en','fr','es','de','zh-CN','ja'];
  const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
  const normalize = (value) => {
    if(typeof value !== 'string')return null;
    const base=value.trim().replace(/_/g,'-').toLowerCase().split('-')[0];
    return base==='zh' ? 'zh-CN':languages.find(item=>item.code===base)?.code || null;
  };
  const decode = (value) => value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#\d+|#x[\da-f]+);/gi,entity => {
    const names={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':'\u00a0'};
    if(own(names,entity))return names[entity];
    const code=entity[2]?.toLowerCase()==='x' ? parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);
    return Number.isInteger(code) && code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code):entity;
  });
  const escape = (value) => String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const keyOf = (value) => decode(value).trim().replace(/\s+/g,' ');
  function pseudoText(value) {
    const accents={a:'à',e:'ë',i:'ï',o:'ô',u:'ü',A:'À',E:'Ë',I:'Ï',O:'Ô',U:'Ü'};
    const text=String(value);
    return '⟦'+text.split(/(\{[\w]+\})/g).map(part=>/^\{[\w]+\}$/.test(part) ? part:part.replace(/[aeiouAEIOU]/g,char=>accents[char])).join('')+' ···⟧';
  }
  function create(options={}) {
    const catalog=options.catalog || {};
    // Only the browser runtime opts into provenance. The public create() API
    // continues to return plain strings for existing integrations and exports.
    const live=options.live === true, provenance=new WeakMap();
    let bindingSequence=0;
    const nonce=live ? (root.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi,''):'';
    const marker=(kind,id,index='')=>`ob-i18n:${nonce}:${kind}:${id}${index==='' ? '':':'+index}`;
    const encode=value=>encodeURIComponent(JSON.stringify(value)).replace(/-/g,'%2D');
    const unpack=value=>{try{return JSON.parse(decodeURIComponent(value));}catch{return null;}};
    class LocalizedValue extends String {
      constructor(spec,escaped=false){super(renderSpec(spec));provenance.set(this,{spec,escaped});}
      toString(){const value=provenance.get(this);return value.escaped ? escape(renderSpec(value.spec)):renderSpec(value.spec);}
      [Symbol.toPrimitive](){return this.toString();}
    }
    const specOf=value=>value && typeof value==='object' ? provenance.get(value)?.spec:null;
    const valueSpec=value=>specOf(value) || {kind:'literal',value:String(value ?? '')};
    function renderSpec(spec) {
      if(spec.kind==='literal')return spec.value;
      if(spec.kind==='join')return spec.values.map(renderSpec).join(spec.separator);
      if(spec.kind==='number')return new Intl.NumberFormat(locale,spec.options).format(spec.value);
      if(spec.kind==='date')return new Intl.DateTimeFormat(locale,spec.options).format(new Date(spec.value));
      if(spec.kind==='count'){
        const source=new Intl.PluralRules(locale).select(spec.value)==='one' ? spec.one:spec.other;
        const params={...spec.params,count:{kind:'number',value:spec.value}};
        return translate(source).replace(/\{([\w]+)\}/g,(token,key)=>own(params,key) ? renderSpec(params[key]):token);
      }
      return translate(spec.source).replace(/\{([\w]+)\}/g,(token,key)=>own(spec.params,key) ? renderSpec(spec.params[key]):token);
    }
    function message(source,...values) {
      if(!live)return t(source,...values);
      if(Array.isArray(source) && own(source,'raw'))return new LocalizedValue({kind:'message',source:source.map((part,index)=>part+(index<values.length ? `{${index}}`:'')).join(''),params:Object.fromEntries(values.map((value,index)=>[index,valueSpec(value)]))});
      if(specOf(source) && !values.length)return source;
      const params=values.length===1 && values[0] && typeof values[0]==='object' && !specOf(values[0]) && !Array.isArray(values[0]) ? values[0]:Object.fromEntries(values.map((value,index)=>[index,value]));
      return new LocalizedValue({kind:'message',source:String(source),params:Object.fromEntries(Object.entries(params).map(([key,value])=>[key,valueSpec(value)]))});
    }
    function textMarkup(source,values) {
      const id=++bindingSequence;
      const translated=translate(source);
      const slots=new Set([...translated.matchAll(/\{(\d+)\}/g)].map(match=>Number(match[1])));
      // Invalid catalogue substitutions must never silently drop a DOM slot.
      if(Object.keys(values).some(index=>!slots.has(Number(index))))return escape(translated).replace(/\{(\d+)\}/g,(token,index)=>own(values,index) ? values[index]:token);
      return `<!--${marker('start',id)}:${encode({source,indices:Object.keys(values).map(Number)})}-->`+escape(translated).replace(/\{(\d+)\}/g,(token,index)=>own(values,index) ? `<!--${marker('slot',id,index)}-->${values[index]}<!--${marker('slotend',id,index)}-->`:token)+`<!--${marker('end',id)}-->`;
    }
    function valueMarkup(value) {
      const spec=specOf(value);
      if(!spec)return String(value ?? '');
      // Keep formatting provenance too: a date or count can change without
      // replacing the card, option, input or panel that contains it.
      const id=++bindingSequence;
      return `<!--${marker('value',id)}:${encode(spec)}-->${escape(renderSpec(spec))}<!--${marker('end',id)}-->`;
    }
    function attributeSpec(part,values) {
      return {kind:'message',source:keyOf(part.replace(/\uE000(\d+)\uE001/g,'{$1}')),params:Object.fromEntries([...new Set([...part.matchAll(/\uE000(\d+)\uE001/g)].map(match=>Number(match[1])))].map(index=>[index,specOf(values[index]) || {kind:'literal',value:decode(String(values[index] ?? ''))}]))};
    }
    let locale=normalize(options.locale);
    if(!locale)locale=(options.preferences || []).map(normalize).find(Boolean) || 'en';
    const translate = (source) => {
      source=String(source);
      const key=keyOf(source);
      if(!key)return source;
      const entry=own(catalog,key) ? catalog[key]:null;
      const translated=locale==='it' ? key:entry?.[codes.indexOf(locale)] || entry?.[0] || key;
      return source.match(/^\s*/)[0]+(options.pseudo ? pseudoText(translated):translated)+source.match(/\s*$/)[0];
    };
    function t(source,...values) {
      if(Array.isArray(source) && own(source,'raw')) {
        const text=source.map((part,index)=>part+(index<values.length ? `{${index}}`:'')).join('');
        return translate(text).replace(/\{(\d+)\}/g,(token,index)=>Number(index)<values.length ? String(values[index] ?? ''):token);
      }
      const params=values[0] || {};
      return translate(source).replace(/\{([\w]+)\}/g,(token,key)=>own(params,key) ? String(params[key] ?? ''):token);
    }
    const sourcesHTML = (template,visit) => template.replace(/(<[^>]*>)|([^<]+)/g,(part,tag,text) => {
      if(tag)return tag.replace(/\b(aria-label|title|placeholder|alt|content)=(['"])(.*?)\2/gi,(attribute,name,quote,value) => {
        if(name.toLowerCase()==='content' && !/\bname=['"]description['"]/i.test(tag))return attribute;
        return `${name}=${quote}${visit(value,true)}${quote}`;
      });
      return visit(text,false);
    });
    function html(source,...values) {
      if(live)pruneBindings();
      const parts=typeof source==='string' ? [source]:source;
      const template=parts.map((part,index)=>part+(index<values.length ? `\uE000${index}\uE001`:'')).join('');
      if(!live) {
        const result=sourcesHTML(template,(part) => {
          const key=keyOf(part.replace(/\uE000(\d+)\uE001/g,'{$1}'));
          if(!/[\p{L}]/u.test(key.replace(/\{\d+\}/g,'')))return part;
          const prefix=part.match(/^\s*/)[0],suffix=part.match(/\s*$/)[0];
          return prefix+escape(translate(key)).replace(/\{(\d+)\}/g,'\uE000$1\uE001')+suffix;
        });
        return result.replace(/\uE000(\d+)\uE001/g,(_,index)=>String(values[index] ?? ''));
      }
      return template.replace(/(<[^>]*>)|([^<]+)/g,(part,tag,text)=>{
        if(tag) {
          const bindings=[];
          const rendered=tag.replace(/\b(aria-label|title|placeholder|alt|content)=(['"])(.*?)\2/gi,(attribute,name,quote,value)=>{
            if(name.toLowerCase()==='content' && !/\bname=['"]description['"]/i.test(tag))return attribute;
            const spec=attributeSpec(value,values),authored=/[\p{L}]/u.test(spec.source.replace(/\{\d+\}/g,''));
            const localized=[...value.matchAll(/\uE000(\d+)\uE001/g)].some(match=>specOf(values[Number(match[1])]));
            if(!authored && !localized)return attribute;
            bindings.push([name,spec]);
            return `${name}=${quote}${escape(renderSpec(spec))}${quote}`;
          }).replace(/\uE000(\d+)\uE001/g,(_,index)=>String(values[index] ?? ''));
          return bindings.length ? rendered.replace(/(\/?>)$/,(ending)=>` data-ob-i18n-${nonce}="${escape(encode(bindings))}"${ending}`):rendered;
        }
        const key=keyOf(text.replace(/\uE000(\d+)\uE001/g,'{$1}'));
        if(!/[\p{L}]/u.test(key.replace(/\{\d+\}/g,'')))return text.replace(/\uE000(\d+)\uE001/g,(_,index)=>valueMarkup(values[index]));
        const used=Object.fromEntries([...text.matchAll(/\uE000(\d+)\uE001/g)].map(match=>[match[1],valueMarkup(values[Number(match[1])])]));
        const prefix=text.match(/^\s*/)[0],suffix=text.match(/\s*$/)[0];
        return prefix+textMarkup(key,used)+suffix;
      });
    }
    function extractHTML(template) {
      const sources=[];
      sourcesHTML(template,part=>{
        const key=keyOf(part.replace(/\uE000(\d+)\uE001/g,'{$1}'));
        if(/[\p{L}]/u.test(key.replace(/\{\d+\}/g,'')))sources.push(key);
        return part;
      });
      return [...new Set(sources)];
    }
    function error(source,status) {
      if(typeof source==='string' && own(catalog,keyOf(source)))return message(source);
      const messages={400:'Richiesta non valida. Controlla i campi inseriti.',401:'Accedi per continuare.',403:'Non hai il permesso di eseguire questa operazione.',404:'La risorsa non è disponibile.',409:'Operazione in conflitto con lo stato attuale. Aggiorna i dati e riprova.',412:'I dati sono cambiati. Conserva la bozza e ricarica la versione più recente.',413:'Il contenuto supera il limite consentito.',429:'Troppe richieste. Attendi e riprova.'};
      return message(messages[status] || 'Operazione non riuscita. Riprova tra poco.');
    }
    const textBindings=new Map(),attributeBindings=new Map(),staticBindings=new Map();
    let titleBinding=null;
    function pruneBindings(){for(const bindings of [textBindings,attributeBindings,staticBindings])for(const node of bindings.keys())if(!node.isConnected)bindings.delete(node);}
    const format=(kind,value,settings)=>live ? new LocalizedValue({kind,value,options:settings}):kind==='date' ? new Intl.DateTimeFormat(locale,settings).format(new Date(value)):new Intl.NumberFormat(locale,settings).format(value);
    function setText(element,value) {
      if(!element)return;
      if(live)pruneBindings();
      textBindings.delete(element);
      element.textContent=String(value ?? '');
      const spec=specOf(value);
      if(live && spec)textBindings.set(element,{spec,last:element.textContent});
    }
    function setAttribute(element,name,value) {
      if(!element)return;
      if(live)pruneBindings();
      const key=element,bindings=attributeBindings.get(key) || new Map();
      // An explicit assignment supersedes an earlier template attribute, even
      // when literal user data happens to equal its previous translation.
      if(live){const attribute=`data-ob-i18n-${nonce}`,recorded=unpack(element.getAttribute(attribute) || '');if(Array.isArray(recorded)){const remaining=recorded.filter(binding=>binding[0]!==name);if(remaining.length)element.setAttribute(attribute,encode(remaining));else element.removeAttribute(attribute);}}
      bindings.delete(name);element.setAttribute(name,String(value ?? ''));
      const spec=specOf(value);
      if(live && spec)bindings.set(name,{spec,last:element.getAttribute(name)});
      if(bindings.size)attributeBindings.set(key,bindings);else attributeBindings.delete(key);
    }
    function captureStatic(document) {
      if(!live)return;
      const visit=(node)=>{
        if(node.nodeType===3) {
          const source=node.data;
          if(/[\p{L}]/u.test(keyOf(source))){const last=translate(source);node.data=last;staticBindings.set(node,{source,last});}
          return;
        }
        if(node.nodeType!==1 || /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE)$/.test(node.tagName) || node.isContentEditable || node.hasAttribute('data-language-selector'))return;
        for(const name of ['aria-label','title','placeholder','alt','content'])if(node.hasAttribute(name) && (name!=='content' || node.getAttribute('name')==='description'))setAttribute(node,name,message(node.getAttribute(name)));
        for(const child of [...node.childNodes])visit(child);
      };
      document.querySelectorAll('[data-i18n-static]').forEach(visit);
    }
    function restoreRange(start,end,source,expected,document) {
      const slots=new Map();
      for(let node=start.nextSibling;node && node!==end;node=node.nextSibling)if(node.nodeType===8) {
        const match=node.data.match(new RegExp('^'+marker('slot',start.obI18nId)+':(\\d+)$'));
        if(!match)continue;
        const index=Number(match[1]),finish=marker('slotend',start.obI18nId,index);
        let last=node.nextSibling;while(last && last!==end && !(last.nodeType===8 && last.data===finish))last=last.nextSibling;
        if(last && last!==end)slots.set(index,{start:node,end:last});
      }
      const translated=translate(source),indices=[...translated.matchAll(/\{(\d+)\}/g)].map(match=>Number(match[1]));
      if(!Array.isArray(expected) || slots.size!==expected.length || indices.length!==expected.length || new Set(indices).size!==expected.length || indices.some(index=>!slots.has(index) || !expected.includes(index)))return;
      let cursor=start.nextSibling;
      for(const part of translated.split(/(\{\d+\})/g)) {
        const match=part.match(/^\{(\d+)\}$/);
        if(match) {
          const slot=slots.get(Number(match[1]));
          if(cursor!==slot.start){const fragment=document.createDocumentFragment();let node=slot.start;while(node){const next=node.nextSibling;fragment.appendChild(node);if(node===slot.end)break;node=next;}start.parentNode.insertBefore(fragment,cursor || end);}
          cursor=slot.end.nextSibling;
        } else if(part) {
          if(cursor && cursor!==end && cursor.nodeType===3){cursor.data=part;cursor=cursor.nextSibling;}
          else {start.parentNode.insertBefore(document.createTextNode(part),cursor || end);}
        }
      }
      while(cursor && cursor!==end){const next=cursor.nextSibling;cursor.remove();cursor=next;}
    }
    function refresh(document) {
      if(!live)return;
      if(titleBinding && document.title===titleBinding.last){document.title=renderSpec(titleBinding.spec);titleBinding.last=document.title;}
      const active=document.activeElement;
      let selection;
      try{if(active && typeof active.selectionStart==='number')selection=[active.selectionStart,active.selectionEnd,active.selectionDirection];}catch{ /* Numeric/date fields have no text selection. */ }
      for(const [node,binding] of staticBindings){if(!node.isConnected){staticBindings.delete(node);continue;}if(node.data!==binding.last){staticBindings.delete(node);continue;}node.data=translate(binding.source);binding.last=node.data;}
      for(const [node,binding] of textBindings){if(!node.isConnected){textBindings.delete(node);continue;}if(node.textContent!==binding.last){textBindings.delete(node);continue;}node.textContent=renderSpec(binding.spec);binding.last=node.textContent;}
      for(const [node,bindings] of attributeBindings){if(!node.isConnected){attributeBindings.delete(node);continue;}for(const [name,binding] of bindings){if(node.getAttribute(name)!==binding.last){bindings.delete(name);continue;}node.setAttribute(name,renderSpec(binding.spec));binding.last=node.getAttribute(name);}}
      document.querySelectorAll(`[data-ob-i18n-${nonce}]`).forEach(node=>{
        const bindings=unpack(node.getAttribute(`data-ob-i18n-${nonce}`));
        if(!Array.isArray(bindings))return;
        for(const [name,spec] of bindings)if(['aria-label','title','placeholder','alt','content'].includes(name))node.setAttribute(name,renderSpec(spec));
      });
      const walker=document.createTreeWalker(document.documentElement,128),comments=[];
      let comment;while((comment=walker.nextNode()))comments.push(comment);
      for(const start of comments) {
        const match=start.data.match(new RegExp('^ob-i18n:'+nonce+':(start|value):(\\d+):(.+)$'));
        if(!match || !start.isConnected)continue;
        const id=Number(match[2]),spec=unpack(match[3]);if(!spec)continue;
        let end=start.nextSibling;while(end && !(end.nodeType===8 && end.data===marker('end',id)))end=end.nextSibling;
        if(!end)continue;
        if(match[1]==='value') {
          // Value groups contain only authored text, never elements or controls.
          const text=start.nextSibling;
          if(text?.nodeType===3 && text.nextSibling===end)text.data=renderSpec(spec);
        } else {start.obI18nId=id;restoreRange(start,end,spec.source,spec.indices,document);}
      }
      if(active?.isConnected && document.activeElement!==active)active.focus({preventScroll:true});
      if(selection && active?.isConnected)try{active.setSelectionRange(...selection);}catch{ /* An input may have changed its type independently. */ }
    }
    return {t,translate,error,html,extractHTML,normalize,languages,codes,keyOf,message,text:setText,attribute:setAttribute,captureStatic,refresh,
      markup:value=>live && specOf(value) ? valueMarkup(value):escape(value ?? ''),
      title(document,value){document.title=String(value ?? '');titleBinding=specOf(value) ? {spec:specOf(value),last:document.title}:null;},
      join(values,separator=''){return live ? new LocalizedValue({kind:'join',values:values.map(valueSpec),separator}):values.join(separator);},
      attributeHTML(name,value){return `${name}="${escape(String(value ?? ''))}"`+(live && specOf(value) ? ` data-ob-i18n-${nonce}="${escape(encode([[name,specOf(value)]]))}"`:'');},
      LocalizedError:class extends Error {constructor(value){super(String(value));this.localizedMessage=value;}},
      escape(value){const spec=specOf(value);return live && spec ? new LocalizedValue(spec,true):escape(value ?? '');},
      get locale(){return locale;},setLocale(value){const next=normalize(value);if(!next)throw new RangeError('Unsupported language');locale=next;},
      number(value,options){return format('number',value,options);},
      count(oneSource,otherSource,value,params={}) {
        const source=new Intl.PluralRules(locale).select(value)==='one' ? oneSource:otherSource;
        return live ? new LocalizedValue({kind:'count',one:oneSource,other:otherSource,value,params:Object.fromEntries(Object.entries(params).map(([key,item])=>[key,valueSpec(item)]))}):t(source,{...params,count:new Intl.NumberFormat(locale).format(value)});
      },
      date(value,options){return format('date',new Date(value).toISOString(),options);},
      isoDate(value){
        if(!value)return '';
        if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return String(value);
        const date=new Date(value+'T12:00:00Z');
        return Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==value ? value:format('date',date.toISOString(),{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});
      }};
  }
  if(typeof module!=='undefined' && module.exports){module.exports={create,normalize,languages,codes,keyOf};return;}
  let stored;
  try {stored=root.localStorage.getItem('openboard.language');} catch { /* Preferences are optional. */ }
  const requested=new URLSearchParams(root.location.search).get('lang');
  const preferences=root.navigator?.languages?.length ? root.navigator.languages:[root.navigator?.language];
  const api=create({catalog:root.OpenBoardLocales,locale:normalize(requested) || stored,preferences,pseudo:new URLSearchParams(root.location.search).get('pseudo')==='1',live:true});
  root.OpenBoardI18n=api;root.tr=api.message;root.ui=api.html;
  function initialize() {
    const document=root.document;
    document.documentElement.lang=api.locale;
    api.captureStatic(document);
    document.querySelectorAll('[data-language-selector]').forEach(select=>{
      select.innerHTML=languages.map(item=>`<option value="${item.code}" lang="${item.code}"${item.code===api.locale ? ' selected':''}>${item.name}</option>`).join('');select.value=api.locale;
      select.setAttribute('aria-label',api.t('Lingua'));
      select.addEventListener('change',()=>{
        const next=normalize(select.value),event=new CustomEvent('openboard:languagechange',{cancelable:true,detail:{locale:next}});
        if(!next || !document.dispatchEvent(event)){select.value=api.locale;return;}
        const previous=api.locale;
        api.setLocale(next);document.documentElement.lang=next;
        api.refresh(document);
        document.querySelectorAll('[data-language-selector]').forEach(item=>{item.querySelectorAll('option').forEach(option=>{option.defaultSelected=option.value===next;});item.value=next;item.setAttribute('aria-label',api.t('Lingua'));});
        try {root.localStorage.setItem('openboard.language',next);} catch { /* Switching remains local when storage is blocked. */ }
        // Replace only an existing language override; keep routes, query values
        // and the current history entry. No navigation or server mutation.
        try {const url=new URL(root.location.href);if(url.searchParams.has('lang')){url.searchParams.set('lang',next);root.history?.replaceState(root.history.state,'',url.href);}}catch{ /* History access is optional. */ }
        document.dispatchEvent(new CustomEvent('openboard:languagechanged',{detail:{locale:next,previous}}));
      });
    });
  }
  if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})(typeof globalThis!=='undefined' ? globalThis:this);
