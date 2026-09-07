#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--run-dir'))throw new Error('Usage: node tools/configure-run.mjs [--run-dir <new-directory>]');
if(Number(process.versions.node.split('.')[0])<24)throw new Error('Use Node.js 24 or later.');
const run=path.resolve(args[1]??path.join(root,'.local/run'));
const config=path.join(run,'.codex/config.toml');const instructions=path.join(run,'AGENTS.md');
for(const f of [config,instructions])if(fs.existsSync(f))throw new Error('Refusing to overwrite '+f);
const tomlPath=p=>{const v=p.replaceAll('\\','/');if(/[\r\n']/.test(v))throw new Error('Choose a path without quotes or newlines.');return v;};
const template=fs.readFileSync(path.join(root,'run/config.template.toml'),'utf8').replaceAll('__RUN_DIR__',tomlPath(run)).replaceAll('__CONTROLLER_DIR__',tomlPath(path.join(root,'controller')));
fs.mkdirSync(path.dirname(config),{recursive:true});
fs.writeFileSync(config,template,{flag:'wx'});
fs.copyFileSync(path.join(root,'run/AGENTS.md'),instructions,fs.constants.COPYFILE_EXCL);
console.log('Open this dedicated folder as your Codex project: '+run);
