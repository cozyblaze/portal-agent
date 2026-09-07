#!/usr/bin/env node
// A local MCP smoke test. No model request, account credentials, or npm packages.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let run = path.join(root, '.local/run');
let exercise = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exercise') exercise = true;
  else if (args[i] === '--run-dir' && args[i + 1]) run = path.resolve(args[++i]);
  else throw new Error('Usage: node tools/check-connection.mjs [--run-dir <directory>] [--exercise]');
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node.js 24 or later.');
if (!fs.existsSync(path.join(run, '.codex/config.toml'))) throw new Error('Run tools/configure-run.mjs first (use the same --run-dir for both helpers).');

const controller = path.join(root, 'controller');
const child = spawn(process.execPath, [
  '--permission', `--allow-fs-read=${controller}`, `--allow-fs-write=${run}`,
  path.join(controller, 'mcp/portal-mcp-server.mjs'),
], {cwd: run, env: {...process.env, PORTAL_SPT_HOST: '127.0.0.1', PORTAL_SPT_PORT: '27182'}, stdio: ['pipe', 'pipe', 'pipe']});
let buffer = '', stderr = '', nextId = 0, exited = false;
const pending = new Map();
function failAll(error) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear();
}
child.stderr.setEncoding('utf8');
child.stderr.on('data', text => { stderr = (stderr + text).slice(-8000); });
child.on('error', failAll);
child.on('exit', (code, signal) => { exited = true; failAll(new Error(`MCP server exited (${code ?? signal}). ${stderr}`)); });
child.stdin.on('error', failAll);
child.stdout.setEncoding('utf8');
child.stdout.on('data', text => {
  buffer += text;
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n'), line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line), p = pending.get(message.id);
      if (!p) continue;
      clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message));
      else p.resolve(message.result);
    } catch (error) { failAll(new Error(`Invalid MCP response: ${error.message}`)); }
  }
});
function request(method, params) {
  if (exited) return Promise.reject(new Error(`MCP server is no longer running. ${stderr}`));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for ${method}. ${stderr}`)); }, 180000);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
}
async function call(name, args = {}) {
  const result = await request('tools/call', {name, arguments: args});
  if (result.isError) throw new Error(result.content.map(c => c.text ?? '').join('\n'));
  return result;
}
try {
  const init = await request('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'portal-connection-check', version: '1.0'}});
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  console.log(`PASS: MCP handshake (${init.serverInfo.name} ${init.serverInfo.version})`);
  const names = (await request('tools/list')).tools.map(t => t.name);
  for (const name of ['portal_documentation', 'portal_exec', 'portal_screenshot']) {
    if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
  }
  await call('portal_documentation');
  console.log('PASS: tool discovery and API documentation');
  const observation = await call('portal_exec', {code: 'return await portal.observe(["facing", "position"]);'});
  const state = JSON.parse(observation.content[0].text);
  if (!['x', 'y', 'z'].every(key => Number.isFinite(state.position?.[key])) ||
      !['pitch', 'yaw', 'roll'].every(key => Number.isFinite(state.facing?.[key]))) {
    throw new Error('Observation is missing position or facing values.');
  }
  console.log('PASS: game observation\n' + observation.content[0].text);
  const image = (await call('portal_screenshot')).content.find(c => c.type === 'image');
  if (!image || image.mimeType !== 'image/jpeg') throw new Error('No JPEG screenshot returned.');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Screenshot has an invalid JPEG header.');
  const savePath = `connection-check-${Date.now()}.jpg`;
  await call('portal_screenshot', {savePath});
  if (fs.statSync(path.join(run, savePath)).size < 4) throw new Error('Saved screenshot is empty.');
  console.log(`PASS: screenshot capture and permitted file save: ${path.join(run, savePath)}`);
  if (exercise) {
    const turn = await call('portal_exec', {code: 'const before = await portal.facing(); await portal.look.right(15); let turned; try { turned = await portal.facing(); } finally { await portal.look.left(15); } return {before, turned, restored: await portal.facing()};'});
    const angles = JSON.parse(turn.content[0].text);
    const angleDifference = (a, b) => ((a - b + 540) % 360) - 180;
    if (Math.abs(angleDifference(angles.turned.yaw, angles.before.yaw) + 15) > 0.1 ||
        Math.abs(angleDifference(angles.restored.yaw, angles.before.yaw)) > 0.1) {
      throw new Error('Camera did not turn 15 degrees and restore its original yaw.');
    }
    const playback = await call('portal_exec', {code: 'return await portal.tas().wait(10).run({screenshot:false});'});
    const value = JSON.parse(playback.content.find(c => c.type === 'text').text);
    if (value.ticks !== 10 || value.aborted) throw new Error('Ten-tick playback did not complete normally.');
    console.log('PASS: camera turn/restore and ten simulation ticks');
  }
  console.log('Connection check passed. The check closes its SPT connection on exit; you can now start Codex.');
} catch (error) {
  console.error(`FAIL: ${error.message}\nCheck the game console for "Agent run ready", plugin loading, and port 27182. Close any other Portal MCP client before retrying.`);
  process.exitCode = 1;
} finally {
  failAll(new Error('Connection check finished.'));
  child.stdin.end();
  setTimeout(() => { if (!exited) child.kill(); }, 1000).unref();
}
