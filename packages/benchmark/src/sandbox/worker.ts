/** Immutable controller-supplied driver; child logs never enter its JSON channel. */
export function buildWorkerSource(): string {
  return `import {spawn} from 'node:child_process';import fs from 'node:fs/promises';import path from 'node:path';
let raw='';for await(const b of process.stdin){raw+=b;if(Buffer.byteLength(raw)>1048576)throw Error('size')}
const input=JSON.parse(raw),root=process.argv.at(-1),commands=[];
if(!Array.isArray(input.commands)||input.commands.length>16)throw Error('commands');
for(const c of input.commands){const cwd=path.resolve(root,c.cwd);if(cwd!==root&&!cwd.startsWith(root+path.sep))throw Error('cwd');await fs.access(cwd);
const exitCode=await new Promise((resolve,reject)=>{const child=spawn(c.argv[0],c.argv.slice(1),{cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/sandbox',TMPDIR:'/tmp',LANG:'C.UTF-8',BUN_OPTIONS:'--no-env-file',NODE_DISABLE_COMPILE_CACHE:'1'},stdio:['ignore','ignore','ignore'],shell:false});const timer=setTimeout(()=>{child.kill('SIGKILL')},c.timeoutMs);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);resolve(code??124)})});commands.push({id:c.id,exitCode});if(exitCode!==0)break;}
process.stdout.write(JSON.stringify({commands}));`
}
