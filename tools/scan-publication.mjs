#!/usr/bin/env node
// A focused release guard, not a substitute for reviewing content before sharing.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rules=[
 ['personal home path',/[A-Z]:[\\/]+Users[\\/]+[^\s\\/"'<>]+/i],
 ['private Unix home path',/\/(?:Users|home)\/[A-Za-z0-9._-]+/],
 ['email address',/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
 ['credential',/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
 ['JWT',/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['Windows identity',/\bS-1-5-21-\d+-\d+-\d+-\d+\b/],
 ['session identifier',/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
 ['embedded image',/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{80}/i],
 ['opaque blob',/["'][A-Za-z0-9+/=]{300,}["']/]
];
const blocked=/\.(dll|exe|pdb|sav|dem|vpk|bsp|zip|7z|png|jpe?g|webp|mp4)$/i;
let files=0;const findings=[];
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
 if(['.git','.local','node_modules'].includes(ent.name))continue;
 const absolute=path.join(dir,ent.name),relative=path.relative(root,absolute).replaceAll('\\','/');
 if(ent.isSymbolicLink()){findings.push({file:relative,rule:'symlink'});continue;}
 if(ent.isDirectory()){walk(absolute);continue;}
 files++;
 if(blocked.test(relative)||/^rollout-.*\.jsonl$/i.test(ent.name)){findings.push({file:relative,rule:'excluded artifact'});continue;}
 const text=fs.readFileSync(absolute,'utf8');
 if(text.includes('\0'))findings.push({file:relative,rule:'binary content'});
 for(const [rule,re]of rules){
  // Preserve original public upstream copyright notices, not personal run data.
  const checked=['spt/LICENSE','tools/scan-publication.mjs'].includes(relative)&&rule==='email address' ? text.replaceAll('daniel@haxx.se','[upstream copyright contact]').replaceAll('mikesmiffy128@gmail.com','[upstream copyright contact]') : text;
  if(re.test(checked))findings.push({file:relative,rule});
 }
}}
walk(root);
const log=path.join(root,'evidence/session.sanitized.jsonl');
if(fs.existsSync(log)){
 const lines=fs.readFileSync(log,'utf8').trim().split('\n');const calls=new Set();const results=new Set();
 lines.forEach((line,index)=>{const row=JSON.parse(line);if(row.sequence!==index+1)throw Error('Invalid sequence');if(row.kind==='tool_call'){if(calls.has(row.call))throw Error('Duplicate call');calls.add(row.call);}if(row.kind==='tool_result'){if(!calls.has(row.call))throw Error('Unpaired result');results.add(row.call);}});
 if(calls.size!==results.size)throw Error('Missing tool result');
}
console.log(JSON.stringify({files,findings},null,2));
if(findings.length)process.exitCode=1;
