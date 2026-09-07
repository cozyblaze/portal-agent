#!/usr/bin/env node
// Produce a text-only derivative. Review the output before publishing it.
// Images, reasoning payloads, prompts injected by the host, and metadata are omitted.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {once} from 'node:events';
import {TIME_ZONE, pacificTimestamp} from './pacific-time.mjs';
const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw new Error('Usage: node tools/export-session.mjs <private-rollout.jsonl> <new-output-directory>');
fs.mkdirSync(destination,{recursive:true});
const output=fs.createWriteStream(path.join(destination,'session.sanitized.jsonl'),{flags:'wx'});
const counts={source_records:0,exported_records:0,omitted_records:0,removed_images:0};
const redactions={};const ids=new Map();const calls=new Map();const models=new Set();const methods=new Map();
let firstTime, lastTime, completionTime, finalUsage, sequence=0;
const replace=(s,re,label,sub)=>s.replace(re,(...args)=>{redactions[label]=(redactions[label]??0)+1;return typeof sub==='function'?sub(...args):sub;});
function cleanText(s){
 s=replace(s,/<environment_context>[\s\S]*?<\/environment_context>/g,'environment','[Host environment omitted]');
 s=replace(s,/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi,'image',()=>{counts.removed_images++;return '[Image omitted]';});
 s=replace(s,/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/gi,'home_path','<USER_HOME>');
 s=replace(s,/\/home\/[^/\s"'<>]+|\/Users\/[^/\s"'<>]+/g,'home_path','<USER_HOME>');
 s=replace(s,/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'identifier','[ID]');
 s=replace(s,/\b(?:call|msg|ctc|ctco|fc|fco|rs|resp)_[A-Za-z0-9_-]{12,}\b/g,'identifier','[ID]');
 s=replace(s,/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'email','[EMAIL]');
 s=replace(s,/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,'credential','[SECRET]');
 s=replace(s,/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'credential','[TOKEN]');
 s=replace(s,/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'credential','Bearer [TOKEN]');
 s=replace(s,/\bS-1-5-21-\d+-\d+-\d+-\d+\b/g,'machine_id','[SID]');
 s=replace(s,/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'ip',v=>['127.0.0.1','0.0.0.0'].includes(v)?v:'[IP]');
 s=replace(s,/https?:\/\/[^\s<>"\\)]+/g,'url',v=>/^https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/]|$)/.test(v)?v:'[URL]');
 return s;
}
function clean(value){
 if(typeof value==='string') {
  // Nested JSON tool outputs can contain separate base64 image objects.
  if(/^[\[{]/.test(value.trim())){try{return JSON.stringify(clean(JSON.parse(value)));}catch{}}
  return cleanText(value);
 }
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object'){
  if(/image/.test(value.type??'')||value.mimeType?.startsWith('image/')){counts.removed_images++;return {type:'image_omitted'};}
  return Object.fromEntries(Object.entries(value).filter(([k])=>!['encrypted_content','internal_chat_message_metadata_passthrough','session_id','thread_id','turn_id','root_turn_id','response_id','rate_limits'].includes(k)).map(([k,v])=>[k,clean(v)]));
 }
 return value;
}
function contentText(content){return (content??[]).filter(c=>typeof c.text==='string').map(c=>c.text).join('\n');}
for await(const line of readline.createInterface({input:fs.createReadStream(input),crlfDelay:Infinity})){
 const row=JSON.parse(line),p=row.payload??{};counts.source_records++;
 firstTime??=row.timestamp;lastTime=row.timestamp;
 if(row.type==='turn_context')models.add(JSON.stringify({model:p.model,reasoning_effort:p.effort}));
 if(row.type==='token_usage_record')finalUsage=p.thread_token_usage;
 if(row.type==='event_msg'&&p.type==='task_complete'&&p.last_agent_message?.startsWith('Reached the end credits'))completionTime=row.timestamp;
 let item;
 if(row.type==='response_item'){
  if(p.type==='message'&&['user','assistant'].includes(p.role)){
   const text=contentText(p.content);
   // The run instructions are published separately, without their environment wrapper.
   if(p.role==='user'&&(text.startsWith('# AGENTS.md instructions')||text.trim().startsWith('<environment_context>'))){}
   else if(text.trim())item={kind:'message',role:p.role,channel:p.channel??null,text:cleanText(text)};
  }else if(p.type==='custom_tool_call'){
   const id='call-'+String(ids.size+1).padStart(5,'0');ids.set(p.call_id,id);calls.set(p.call_id,p.name);
   for(const m of p.input.matchAll(/tools\.([A-Za-z0-9_]+)/g))methods.set(m[1],(methods.get(m[1])??0)+1);
   item={kind:'tool_call',call:id,name:p.name,input:cleanText(p.input)};
  }else if(p.type==='custom_tool_call_output'&&ids.has(p.call_id))item={kind:'tool_result',call:ids.get(p.call_id),output:clean(p.output)};
  else if(p.type==='function_call'&&p.name==='wait'){
   const id='call-'+String(ids.size+1).padStart(5,'0');ids.set(p.call_id,id);
   item={kind:'tool_call',call:id,name:p.name,input:cleanText(p.arguments)};
  }else if(p.type==='function_call_output'&&ids.has(p.call_id))item={kind:'tool_result',call:ids.get(p.call_id),output:clean(p.output)};
 }
 if(item){const result={sequence:++sequence,timestamp:pacificTimestamp(row.timestamp),elapsed_seconds:Math.round((Date.parse(row.timestamp)-Date.parse(firstTime))/1000),...item};if(!output.write(JSON.stringify(result)+'\n'))await once(output,'drain');counts.exported_records++;}
 else counts.omitted_records++;
}
output.end();await once(output,'finish');
const summary={schema_version:2,time_zone:TIME_ZONE,run_dates:`${pacificTimestamp(firstTime).slice(0,10)} to ${pacificTimestamp(lastTime).slice(0,10)}`,started_at:pacificTimestamp(firstTime),completed_at:completionTime?pacificTimestamp(completionTime):null,ended_at:pacificTimestamp(lastTime),models:[...models].map(JSON.parse),...counts,redactions,elapsed_to_completion_seconds:completionTime?Math.round((Date.parse(completionTime)-Date.parse(firstTime))/1000):null,elapsed_including_post_completion_seconds:Math.round((Date.parse(lastTime)-Date.parse(firstTime))/1000),last_reported_thread_token_usage:finalUsage,tool_methods_in_exec:Object.fromEntries(methods),export_notes:['Sanitized text export of run messages, tool calls, and results.','Timestamps use San Francisco time (America/Los_Angeles), with an explicit UTC offset; elapsed seconds are durations.','Host/system/developer context, world state, context-compaction/history/note tool records, reasoning payloads, opaque data and original identifiers are omitted.','Embedded images are omitted from this text release.','Token counts are cumulative reported usage and include cached input.']};
fs.writeFileSync(path.join(destination,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({records:counts,redactions}));
