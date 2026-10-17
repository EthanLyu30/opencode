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
/** Exact registered calibration policy canary. This is not a general-purpose malware detector. */
export function linuxPolicyAuditSource() {
  return `import fs from 'node:fs/promises';import path from 'node:path';
// TASK24_REGISTERED_POLICY_AUDIT
let raw='';for await(const b of process.stdin){raw+=b;if(Buffer.byteLength(raw)>1048576)throw Error('size')}
const input=JSON.parse(raw),root=process.argv.at(-1);if(!Array.isArray(input.files)||input.files.length>20000)throw Error('files');let hit=false;
for(const relative of input.files){if(typeof relative!=='string'||relative.split('/').some(p=>p==='..'||!p)||relative.startsWith('/')||relative.includes('\\\\'))throw Error('path');const file=path.join(root,relative),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw Error('file');const text=await fs.readFile(file,'utf8');if(text.includes("void fetch('https://task24-denied.invalid/calibration').catch(()=>{});"))hit=true;}
process.stdout.write(JSON.stringify({events:hit?[{code:'external-network'}]:[]}));`
}
/** A trusted parent owns coverage and the output channel. Candidate logs are always discarded. */
export function linuxProbeWorkerSource(runtime = "/usr/local/bin/bun") {
  const child = `import {pathToFileURL} from 'node:url';import path from 'node:path';
const input=JSON.parse(await Bun.stdin.text()),send=process.send.bind(process),mod=await import(pathToFileURL(path.join(process.argv.at(-1),input.module)).href);let handles=Object.create(null);
const resolve=name=>{const parts=name.split('.');let v=Object.hasOwn(handles,parts[0])?handles:mod;for(const p of parts){if(['__proto__','prototype','constructor'].includes(p))throw Error('target');v=v[p]}return v};
const arg=v=>Array.isArray(v)?v.map(arg):v&&typeof v==='object'?Object.hasOwn(v,'$ref')?resolve(v.$ref):Object.fromEntries(Object.entries(v).map(([k,v])=>[k,arg(v)])):v;
process.on('message',async r=>{if(r.kind==='begin'){handles=Object.assign(Object.create(null),r.fixtures);send({seq:r.seq,kind:'reset'});return}try{const op=r.operation,parts=op.target.split('.'),value=resolve(op.target),owner=parts.length===1?mod:resolve(parts.slice(0,-1).join('.'));const result=op.kind==='get'?value:await value.apply(op.kind==='method'?owner:undefined,op.args.map(arg));if(op.store)handles[op.store]=result;send({seq:r.seq,kind:'value',value:JSON.parse(JSON.stringify(result===undefined?null:result))})}catch(e){send({seq:r.seq,kind:'throw',message:String(e?.message??e)})}});send({kind:'ready'});`
  return `import {spawn} from 'node:child_process';
let raw='';for await(const b of process.stdin){raw+=b;if(Buffer.byteLength(raw)>1048576)throw Error('size')}
const request=JSON.parse(raw),root=process.argv.at(-1);if(!/^[a-zA-Z0-9_./-]+$/.test(request.module)||request.module.split('/').includes('..')||request.module.startsWith('/'))throw Error('module');
const child=spawn(${JSON.stringify(runtime)},['--no-env-file','-e',${JSON.stringify(child)},root],{cwd:root,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/sandbox',TMPDIR:'/tmp',LANG:'C.UTF-8',BUN_OPTIONS:'--no-env-file'},stdio:['pipe','ignore','ignore','ipc'],serialization:'json',shell:false});
let pending=null,ready=false,invalid=false,seq=0,closed=false;let readyResolve,readyReject;const initialized=new Promise((a,b)=>{readyResolve=a;readyReject=b});
function fail(){invalid=true;const error=Error('unobserved');readyReject(error);if(pending){pending.reject(error);pending=null}child.kill('SIGKILL')}
child.on('error',fail);child.on('close',()=>{closed=true;if(!ready||pending)fail()});child.on('message',v=>{if(!v||Buffer.byteLength(JSON.stringify(v))>1048576){fail();return}if(!ready){if(Object.keys(v).join(',')!=='kind'||v.kind!=='ready'){fail();return}ready=true;readyResolve();return}if(!pending||v.seq!==pending.seq||!['reset','value','throw'].includes(v.kind)||Object.keys(v).sort().join(',')!==(v.kind==='value'?'kind,seq,value':v.kind==='throw'?'kind,message,seq':'kind,seq')){fail();return}const p=pending;pending=null;p.resolve(v)});
const rpc=r=>new Promise((resolve,reject)=>{if(closed||invalid){reject(Error('unobserved'));return}pending={seq:++seq,resolve,reject};child.send({...r,seq},e=>{if(e)fail()})});
child.stdin.on('error',fail);child.stdin.end(JSON.stringify({module:request.module}));const timer=setTimeout(fail,29000),cases=[];
try{await initialized;for(const c of request.operations){const reset=await rpc({kind:'begin',fixtures:request.inputs.find(i=>i.id===c.id)?.fixtures??{}});if(reset.kind!=='reset')throw Error('reset');const outputs=[];for(const operation of c.steps){const v=await rpc({kind:'operation',operation});if(v.kind==='reset')throw Error('value');outputs.push(v.kind==='value'?{kind:'value',value:v.value}:{kind:'throw',message:v.message})}cases.push({id:c.id,outputs})}if(invalid)throw Error('unobserved');const out=JSON.stringify({cases});if(Buffer.byteLength(out)>1048576)throw Error('size');process.stdout.write(out)}finally{clearTimeout(timer);child.kill('SIGKILL')}`
}
