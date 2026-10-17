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
      const parts=typeof source==='string' ? [source]:source;
      const template=parts.map((part,index)=>part+(index<values.length ? `\uE000${index}\uE001`:'')).join('');
      const result=sourcesHTML(template,(part) => {
        const key=keyOf(part.replace(/\uE000(\d+)\uE001/g,'{$1}'));
        if(!/[\p{L}]/u.test(key.replace(/\{\d+\}/g,'')))return part;
        const prefix=part.match(/^\s*/)[0],suffix=part.match(/\s*$/)[0];
        return prefix+escape(translate(key)).replace(/\{(\d+)\}/g,'\uE000$1\uE001')+suffix;
      });
      return result.replace(/\uE000(\d+)\uE001/g,(_,index)=>String(values[index] ?? ''));
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
      if(typeof source==='string' && own(catalog,keyOf(source)))return t(source);
      const messages={400:'Richiesta non valida. Controlla i campi inseriti.',401:'Accedi per continuare.',403:'Non hai il permesso di eseguire questa operazione.',404:'La risorsa non è disponibile.',409:'Operazione in conflitto con lo stato attuale. Aggiorna i dati e riprova.',412:'I dati sono cambiati. Conserva la bozza e ricarica la versione più recente.',413:'Il contenuto supera il limite consentito.',429:'Troppe richieste. Attendi e riprova.'};
      return t(messages[status] || 'Operazione non riuscita. Riprova tra poco.');
    }
    return {t,translate,error,html,extractHTML,normalize,languages,codes,keyOf,
      get locale(){return locale;},setLocale(value){const next=normalize(value);if(!next)throw new RangeError('Unsupported language');locale=next;},
      number(value,options){return new Intl.NumberFormat(locale,options).format(value);},
      count(oneSource,otherSource,value,params={}) {
        const source=new Intl.PluralRules(locale).select(value)==='one' ? oneSource:otherSource;
        return t(source,{...params,count:new Intl.NumberFormat(locale).format(value)});
      },
      date(value,options){return new Intl.DateTimeFormat(locale,options).format(value);},
      isoDate(value){
        if(!value)return '';
        if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return String(value);
        const date=new Date(value+'T12:00:00Z');
        return Number.isNaN(date.getTime()) || date.toISOString().slice(0,10)!==value ? value:new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}).format(date);
      }};
  }
  if(typeof module!=='undefined' && module.exports){module.exports={create,normalize,languages,codes,keyOf};return;}
  let stored;
  try {stored=root.localStorage.getItem('openboard.language');} catch { /* Preferences are optional. */ }
  const requested=new URLSearchParams(root.location.search).get('lang');
  const preferences=root.navigator?.languages?.length ? root.navigator.languages:[root.navigator?.language];
  const api=create({catalog:root.OpenBoardLocales,locale:normalize(requested) || stored,preferences,pseudo:new URLSearchParams(root.location.search).get('pseudo')==='1'});
  root.OpenBoardI18n=api;root.tr=api.t;root.ui=api.html;
  function initialize() {
    const document=root.document;
    document.documentElement.lang=api.locale;
    // Only markup explicitly marked by the author is translated. Never observe
    // or rewrite data rendered into the board, editors or discussions.
    document.querySelectorAll('[data-i18n-static]').forEach(element=>{
      element.innerHTML=api.html(element.innerHTML);
      for(const attribute of ['aria-label','title','placeholder','alt','content'])if(element.hasAttribute(attribute))element.setAttribute(attribute,api.t(element.getAttribute(attribute)));
    });
    document.querySelectorAll('[data-language-selector]').forEach(select=>{
      select.innerHTML=languages.map(item=>`<option value="${item.code}" lang="${item.code}">${item.name}</option>`).join('');select.value=api.locale;
      select.setAttribute('aria-label',api.t('Lingua'));
      select.addEventListener('change',()=>{
        const next=normalize(select.value),event=new CustomEvent('openboard:languagechange',{cancelable:true,detail:{locale:next}});
        if(!next || !document.dispatchEvent(event)){select.value=api.locale;return;}
        const url=new URL(root.location.href);
        try {
          root.localStorage.setItem('openboard.language',next);
          if(url.searchParams.has('lang')){url.searchParams.delete('lang');root.location.assign(url.href);}else root.location.reload();
        } catch {
          // Keep language switching available when the browser blocks storage.
          url.searchParams.set('lang',next);root.location.assign(url.href);
        }
      });
    });
  }
  if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})(typeof globalThis!=='undefined' ? globalThis:this);
