/* Pure local-file converters. No DOM, network, credentials or account creation.
 * Contract: parseTrello(object) / parseCSV(text, options) return
 * {data:{format:'openboard',version:2,board},warnings:[Italian source],counts}.
 * Pass data to the existing authenticated, transactional POST /api/import.
 * File readers must decode UTF-8 with TextDecoder('utf-8',{fatal:true}) before calling
 * these APIs; a string cannot recover invalid bytes already replaced by File.text().
 * CSV options: {name,description?,delimiter:',' or ';',
 * header:true,mapping:{title:0,list:1,description:2,due_date:3,priority:4,
 * assignee:5,estimate_minutes:6},defaultList:'Importate'}; indices are zero-based.
 * inspectCSV(text,{delimiter:',',header:true}) supplies headers/width/rowCount.
 * Field limits match src/server.c: Unicode code points, plus valid UTF-8/NUL
 * checks; both input and serialized output must fit the 2 MiB HTTP body limit.
 * Supported Trello shape: one board with id/name, lists[] and cards[], optional
 * global checklists[] (id/idCard/name/checkItems), members[] and labels[].
 * Cards refer to idList/idChecklists/idMembers/idLabels; expanded labels are
 * accepted too. Positions are sorted stably. Grouped checklist text is flattened;
 * labels become description text, never guesses about OpenBoard's fixed labels.
 * Sources: https://support.atlassian.com/trello/docs/making-sense-of-trellos-json-export/
 * https://developer.atlassian.com/cloud/trello/rest/api-group-cards/
 * https://developer.atlassian.com/cloud/trello/rest/api-group-checklists/
 * CSV quoting follows RFC 4180 with comma/semicolon, BOM, CRLF/LF/CR support.
 * Formula-like strings remain literal strings; nothing is evaluated. */
(function (root) {
  'use strict';
  const LIMITS = Object.freeze({bytes:2*1024*1024,columns:100,cards:10000,checklistItems:100});
  const fields = Object.freeze(['title','list','description','due_date','priority','assignee','estimate_minutes']);
  const priorities = new Set(['low','normal','high','urgent']);
  const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const fail = message => { throw new Error(message); };
  const invalid = () => fail('Dati Trello non validi o esportazione incompleta.');
  const reference = () => fail('Identificativi Trello duplicati o riferimenti mancanti.');
  function unicode(value) {
    for (const char of value) {
      const point = char.codePointAt(0);
      if (!point || (point >= 0xD800 && point <= 0xDFFF)) fail('Il file contiene caratteri Unicode non validi.');
    }
    return value;
  }
  function text(value, maximum, required = false) {
    if (typeof value !== 'string') fail('Un campo importato non è valido o supera i limiti consentiti.');
    unicode(value);
    if (Array.from(value).length > maximum || (required && !value.trim())) fail('Un campo importato non è valido o supera i limiti consentiti.');
    return value;
  }
  function serialized(value) {
    let data;
    try { data = JSON.stringify(value); } catch { invalid(); }
    if (typeof data !== 'string' || new TextEncoder().encode(data).length > LIMITS.bytes)
      fail('Il file supera il limite di 2 MiB.');
    return data;
  }
  function list(value, required = false) {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value)) invalid();
    return value;
  }
  function id(value) { return text(value,100,true); }
  function entities(values) {
    const result = new Map();
    for (const value of values) {
      if (!object(value)) invalid();
      const key = id(value.id);
      if (result.has(key)) reference();
      result.set(key,value);
    }
    return result;
  }
  function refs(value) {
    const result = list(value).map(id);
    if (new Set(result).size !== result.length) reference();
    return result;
  }
  function flag(value) {
    if (value === undefined) return false;
    if (typeof value !== 'boolean') invalid();
    return value;
  }
  function ordered(values) {
    for (const value of values) if (value.pos !== undefined && (typeof value.pos !== 'number' || !Number.isFinite(value.pos))) invalid();
    // If positions are absent, retain the source array order for every item.
    if (values.some(value => value.pos === undefined)) return [...values];
    return values.map((value,index) => ({value,index})).sort((a,b) => a.value.pos-b.value.pos || a.index-b.index).map(item => item.value);
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year,month,day] = value.split('-').map(Number);
    const days = [0,31,(year%4===0 && (year%100!==0 || year%400===0)) ? 29:28,31,30,31,30,31,31,30,31,30,31];
    return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month];
  }
  function trelloDate(value, warnings) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') fail('Data importata non valida.');
    if (validDate(value)) return value;
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
    if (!match || !validDate(match[1]) || Number(match[2])>23 || Number(match[3])>59 || Number(match[4])>59)
      fail('Data importata non valida.');
    if (match[5] !== 'Z' && (Number(match[5].slice(1,3))>23 || Number(match[5].slice(4))>59)) fail('Data importata non valida.');
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) fail('Data importata non valida.');
    const result = parsed.toISOString().slice(0,10);
    if (!validDate(result)) fail('Data importata non valida.');
    warnings.add('La data Trello conserva il giorno UTC; orario e promemoria non vengono importati.');
    return result;
  }
  function finish(board, warnings) {
    if (board.columns.length > LIMITS.columns) fail('La conversione richiede al massimo 100 liste e 10000 schede.');
    const cards = board.columns.flatMap(column => column.cards);
    if (cards.length > LIMITS.cards) fail('La conversione richiede al massimo 100 liste e 10000 schede.');
    const data = {format:'openboard',version:2,board};
    serialized(data);
    return {data,warnings:[...warnings],counts:{columns:board.columns.length,cards:cards.length,
      checklistItems:cards.reduce((sum,card)=>sum+(card.checklist?.length || 0),0),
      archivedCards:cards.filter(card=>card.archived).length,completedCards:cards.filter(card=>card.completed).length}};
  }
  function parseTrello(source) {
    if (!object(source)) invalid();
    serialized(source);
    const boardID = id(source.id), sourceLists = list(source.lists,true), sourceCards = list(source.cards,true);
    if (sourceLists.length>LIMITS.columns || sourceCards.length>LIMITS.cards) fail('La conversione richiede al massimo 100 liste e 10000 schede.');
    const lists = entities(sourceLists), cards = entities(sourceCards), checklists = entities(list(source.checklists));
    const members = entities(list(source.members)), labels = entities(list(source.labels));
    const warnings = new Set();
    // Explicitly describe omissions even when an export hides those arrays.
    warnings.add('Commenti, attività e cronologia Trello non vengono importati.');
    warnings.add('Gli allegati Trello non vengono scaricati né importati.');
    warnings.add('Campi personalizzati, copertine, integrazioni e impostazioni Trello non vengono importati.');
    if (members.size || list(source.memberships).length) warnings.add('I nomi dei membri sono testo descrittivo: account, ruoli e assegnazioni non vengono creati.');
    const board = {name:text(source.name,200,true),description:text(source.desc ?? '',2000),archived:flag(source.closed),columns:[]};
    const columns = new Map();
    for (const value of ordered(sourceLists)) {
      if (value.idBoard !== undefined && value.idBoard !== boardID) reference();
      const column = {title:text(value.name,200,true),cards:[]};
      columns.set(value.id,column);
      board.columns.push(column);
      if (flag(value.closed)) warnings.add('Le liste Trello archiviate restano presenti; le loro schede sono importate come archiviate.');
    }
    const byCard = new Map(), itemIDs = new Set();
    for (const value of checklists.values()) {
      if (!cards.has(value.idCard) || (value.idBoard !== undefined && value.idBoard !== boardID)) reference();
      text(value.name,500,true);
      list(value.checkItems,true);
      if (!byCard.has(value.idCard)) byCard.set(value.idCard,[]);
      byCard.get(value.idCard).push(value);
      for (const item of value.checkItems) {
        if (!object(item)) invalid();
        const key = id(item.id);
        if (itemIDs.has(key)) reference();
        itemIDs.add(key);
        if (item.idChecklist !== undefined && item.idChecklist !== value.id) reference();
      }
    }
    for (const value of ordered(sourceCards)) {
      if (!columns.has(value.idList) || (value.idBoard !== undefined && value.idBoard !== boardID)) reference();
      if (value.checklists !== undefined) invalid(); // expanded nested API responses are not board exports
      const owned = byCard.get(value.id) || [];
      if (own(value,'idChecklists')) {
        const references = refs(value.idChecklists);
        if (references.length !== owned.length || references.some(key => !checklists.has(key) || checklists.get(key).idCard !== value.id)) reference();
      }
      let description = text(value.desc ?? '',10000);
      const checklist = [];
      for (const group of ordered(owned)) {
        for (const item of ordered(group.checkItems)) {
          if (!['complete','incomplete'].includes(item.state)) invalid();
          checklist.push({id:item.id,text:text('['+group.name+'] '+text(item.name,500,true),500,true),done:item.state==='complete'});
        }
      }
      if (checklist.length > LIMITS.checklistItems) fail('La checklist richiede al massimo 100 elementi per scheda.');
      if (owned.length) {
        description += '\n\nTrello checklists: '+ordered(owned).map(group=>group.name).join('; ');
        warnings.add('Le checklist Trello sono unite in una checklist; i nomi sono conservati nel testo.');
      }
      const expanded = new Map();
      for (const label of list(value.labels)) {
        if (typeof label === 'string') {
          const key = id(label);
          if (!labels.has(key) || expanded.has(key)) reference();
          expanded.set(key,labels.get(key));
        } else {
          if (!object(label)) invalid();
          const key = id(label.id);
          if (expanded.has(key)) reference();
          if (labels.has(key) && (labels.get(key).name !== label.name || (labels.get(key).color ?? null) !== (label.color ?? null))) reference();
          expanded.set(key,label);
        }
      }
      const labelRefs = own(value,'idLabels') ? refs(value.idLabels):[...expanded.keys()];
      if ([...expanded.keys()].some(key=>!labelRefs.includes(key))) reference();
      const labelNames = labelRefs.map(key => {
        const label = expanded.get(key) || labels.get(key);
        if (!label) reference();
        const name = text(label.name ?? '',10000), color = text(label.color ?? '',100);
        return name || (color ? '['+color+']':key);
      });
      if (labelNames.length) {
        description += '\n\nTrello labels: '+labelNames.join('; ');
        warnings.add('Le etichette Trello sono conservate nella descrizione; colori e filtri delle etichette non vengono ricreati.');
      }
      const display = refs(value.idMembers).map(key => {
        const member = members.get(key);
        return member ? text(member.fullName || member.username || key,100,true):key;
      });
      const assignee = text(display.join(', '),100);
      if (display.length) warnings.add('I nomi dei membri sono testo descrittivo: account, ruoli e assegnazioni non vengono creati.');
      const card = {title:text(value.name,300,true),description:text(description,10000),assignee,
        due_date:trelloDate(value.due,warnings),start_date:trelloDate(value.start,warnings),
        completed:flag(value.dueComplete),archived:flag(value.closed)||flag(lists.get(value.idList).closed),checklist};
      if (card.start_date && card.due_date && card.start_date>card.due_date) fail('Data importata non valida.');
      columns.get(value.idList).cards.push(card);
    }
    if (sourceLists.length !== lists.size) reference();
    return finish(board,warnings);
  }
  function readCSV(input, options) {
    if (typeof input !== 'string') fail('CSV non valido: controlla virgolette, righe e separatore.');
    unicode(input);
    if (new TextEncoder().encode(input).length > LIMITS.bytes) fail('Il file supera il limite di 2 MiB.');
    const delimiter = options.delimiter ?? ',';
    if (![',',';'].includes(delimiter) || (options.header !== undefined && typeof options.header !== 'boolean')) fail('CSV non valido: controlla virgolette, righe e separatore.');
    const source = input.replace(/^\uFEFF/,''), rows = [];
    let row = [], field = '', quoted = false, closed = false, pending = false;
    const fieldDone = () => { row.push(field); field=''; closed=false; if (row.length>100) fail('CSV non valido: controlla virgolette, righe e separatore.'); };
    const rowDone = () => { fieldDone(); rows.push(row); row=[]; pending=false; if(rows.length>LIMITS.cards+1) fail('La conversione richiede al massimo 100 liste e 10000 schede.'); };
    for (let index=0; index<source.length; index++) {
      const char = source[index]; pending=true;
      if (quoted) {
        if (char === '"') { if(source[index+1]==='"') { field+='"'; index++; } else { quoted=false; closed=true; } }
        else field+=char;
      } else if (char === delimiter) fieldDone();
      else if (char === '\r' || char === '\n') { if(char==='\r' && source[index+1]==='\n') index++; rowDone(); }
      else if (char === '"' && !field && !closed) quoted=true;
      else { if(closed || char==='"') fail('CSV non valido: controlla virgolette, righe e separatore.'); field+=char; }
    }
    if (quoted) fail('CSV non valido: controlla virgolette, righe e separatore.');
    if (pending || row.length) rowDone();
    if (!rows.length) fail('Il CSV non contiene schede da importare.');
    const width = rows[0].length, header = options.header !== false;
    if (rows.some(value=>value.length!==width)) fail('CSV non valido: controlla virgolette, righe e separatore.');
    const headers = header ? rows.shift():Array.from({length:width},(_,index)=>String(index+1));
    if (rows.length>LIMITS.cards) fail('La conversione richiede al massimo 100 liste e 10000 schede.');
    if (header) {
      headers.forEach(value=>text(value,200,true));
      if (new Set(headers.map(value=>value.trim().toLowerCase())).size!==width) fail('Le intestazioni CSV devono essere non vuote e univoche.');
    }
    return {headers,rows,width,delimiter};
  }
  function inspectCSV(input, options = {}) {
    if (!object(options)) fail('CSV non valido: controlla virgolette, righe e separatore.');
    const {headers,rows,width,delimiter} = readCSV(input,options);
    return {headers,width,rowCount:rows.length,delimiter};
  }
  function parseCSV(input, options = {}) {
    if (!object(options) || !object(options.mapping)) fail('Mappatura CSV non valida: seleziona il titolo e indici distinti.');
    const parsed = readCSV(input,options), mapping = {}, mapped = new Set();
    for (const [key,index] of Object.entries(options.mapping)) {
      if (!fields.includes(key)) fail('Mappatura CSV non valida: seleziona il titolo e indici distinti.');
      if (index === null || index === undefined) continue;
      if (!Number.isInteger(index) || index<0 || index>=parsed.width || mapped.has(index)) fail('Mappatura CSV non valida: seleziona il titolo e indici distinti.');
      mapping[key]=index; mapped.add(index);
    }
    if (!own(mapping,'title')) fail('Mappatura CSV non valida: seleziona il titolo e indici distinti.');
    if (!parsed.rows.length) fail('Il CSV non contiene schede da importare.');
    const warnings = new Set(), columns = new Map();
    if (mapped.size<parsed.width) warnings.add('Le colonne CSV non mappate non vengono importate.');
    if (own(mapping,'assignee')) warnings.add('I responsabili CSV sono testo descrittivo e non creano assegnazioni o account.');
    const board = {name:text(options.name ?? 'Importazione CSV',200,true),description:text(options.description ?? '',2000),columns:[]};
    const fallback = text(options.defaultList ?? 'Importate',200,true);
    for (const row of parsed.rows) {
      const value = key => own(mapping,key) ? row[mapping[key]]:'';
      const columnName = text(value('list') || fallback,200,true);
      if (!columns.has(columnName)) { const column={title:columnName,cards:[]}; columns.set(columnName,column); board.columns.push(column); }
      if (columns.size>LIMITS.columns) fail('La conversione richiede al massimo 100 liste e 10000 schede.');
      const due_date = value('due_date').trim(), priority = value('priority').trim() || 'normal', estimate = value('estimate_minutes').trim();
      if (due_date && !validDate(due_date)) fail('Data importata non valida.');
      if (!priorities.has(priority) || (estimate && (!/^\d+$/.test(estimate) || Number(estimate)>100000))) fail('Valore CSV non valido per priorità o stima.');
      const card = {title:text(value('title'),300,true),description:text(value('description'),10000),
        due_date,priority,assignee:text(value('assignee'),100),estimate_minutes:estimate ? Number(estimate):0};
      if (row.some(cell=>/^[\s\uFEFF]*[=+@-]/u.test(cell))) warnings.add('Il CSV viene importato come testo: le formule non vengono eseguite.');
      columns.get(columnName).cards.push(card);
    }
    return finish(board,warnings);
  }
  const api = {parseTrello,parseCSV,inspectCSV,limits:LIMITS,fields};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  root.OpenBoardImporters=api;
})(typeof globalThis !== 'undefined' ? globalThis:this);
