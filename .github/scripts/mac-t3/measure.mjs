import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const [base, candidate, project, output, tools] = process.argv.slice(2).map(p => path.resolve(p));
const arms = {A:base, B:candidate};
const server = path.join(project, 'apps/server');
const flags = ['--noEmit','--incremental','false','--pretty','false'];
const sourceSamples = [path.join(server,'tsconfig.json'),path.join(server,'src/attachmentPaths.ts'),path.join(project,'packages/contracts/src/index.ts')];
const sides = Object.keys(arms);
const modes = ['ordinary','fast'];
const rounds = 16;
fs.mkdirSync(output, {recursive:true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (name, value) => fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const append = (name, value) => fs.appendFileSync(path.join(output,name),JSON.stringify(value)+'\n');
function run(command,args,options={}) {
  const result = spawnSync(command,args,{maxBuffer:128*1024*1024,...options});
  assert.ifError(result.error);
  return result;
}
function observe(side,mode,cwd,args=flags) {
  const prefix=path.join(output,'observed');
  const env={...process.env,LC_ALL:'C',TSRS_FAST:mode==='fast'?'1':'0'};
  const res=run(path.join(tools,'observe'),[prefix+'.stdout',prefix+'.stderr',arms[side],...args],{cwd,env});
  assert.equal(res.status,0,res.stderr.toString());
  const r=JSON.parse(res.stdout);
  assert.equal(r.signal,0,JSON.stringify(r));
  const stdout=fs.readFileSync(prefix+'.stdout'),stderr=fs.readFileSync(prefix+'.stderr');
  return {r,stdout,stderr,signature:[r.status,hash(stdout),hash(stderr)].join(':')};
}
function saveProof(label,side,mode,result) {
  const log=label+'-'+side+'-'+mode;
  fs.writeFileSync(path.join(output,log+'.stdout'),result.stdout);
  fs.writeFileSync(path.join(output,log+'.stderr'),result.stderr);
  append('proof.jsonl',{label,side,mode,...result.r,stdoutBytes:result.stdout.length,stderrBytes:result.stderr.length,signature:result.signature});
}
function proof(label,cwd,args,validate) {
  let expected;
  for (const side of sides) for (const mode of modes) {
    const actual=observe(side,mode,cwd,args);
    saveProof(label,side,mode,actual);
    validate(actual);
    if(expected) assert.equal(actual.signature,expected,label+' ordered output differs');
    expected=actual.signature;
  }
  return expected;
}
const clean=x=>{assert.equal(x.r.status,0,x.stdout.toString().slice(0,3000));assert.equal(x.stdout.length+x.stderr.length,0)};
const ordered=proof('sources',server,[...flags,'--listFilesOnly'],x=>{
  assert.equal(x.r.status,0);assert.equal(x.stderr.length,0);assert.ok(x.stdout.toString().split('\n').length>3000);
});
const actual=proof('project',server,flags,clean);
const fixture=path.join(tools,'clean-fixture');
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(fixture,'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ESNext',module:'ESNext',types:[],strict:true}, files:['index.ts']}));
fs.writeFileSync(path.join(fixture,'index.ts'),'export const checked: string = "ok";\n');
proof('clean-fixture',fixture,flags,clean);
const injected=path.join(server,'src/tsrs-benchmark-diagnostics.ts');
fs.writeFileSync(injected,'export const first: string = 17;\nexport const second: boolean = "bad";\n',{flag:'wx'});
try {
  proof('project-with-errors',server,flags,x=>{
    assert.ok([1,2].includes(x.r.status),String(x.r.status));assert.equal(x.stderr.length,0);
    const lines=x.stdout.toString().trimEnd().split('\n');
    assert.equal(lines.length,2,x.stdout.toString());
    for(let i=0;i<2;i++) assert.match(lines[i],new RegExp('tsrs-benchmark-diagnostics\\.ts\\('+(i+1)+',\\d+\\): error TS2322:'));
  });
} finally { fs.unlinkSync(injected); }
function residency(bin) {
  const status=run(path.join(tools,'resident'),[bin,...sourceSamples]);
  assert.equal(status.status,0,status.stderr.toString());
  return JSON.parse(status.stdout);
}
function purge() {
  const result=run('sudo',['-n','/usr/sbin/purge'],{timeout:45000});
  return {status:result.status,signal:result.signal,stderr:result.stderr.toString().trim().slice(0,2000)};
}
const probe0=purge();
const initial=sides.map(side=>residency(arms[side]));
const initialCold=probe0.status===0 && initial.flat().every(r=>r.pages>0&&r.resident===0);
write('cache-probe.json',{purge:probe0,initial,sources:sourceSamples,initialCold});
write('invocations.json',{arms,modes,fastEnvironment:{ordinary:'0',fast:'1'},flags,cwd:server,rounds,ordered,project:actual});
const trial = (cache,side,mode,pair,order) => {
  const sampled=residency(arms[side]);
  const sampleCold=sampled.every(r=>r.pages>0&&r.resident===0);
  const sampleWarm=sampled.every(r=>r.pages>0&&r.resident===r.pages);
  const observed=observe(side,mode,server);
  const row={name:cache+' '+mode,side,pair,order,cache,mode,coldResidency:sampled,sampleCold,sampleWarm,
    ...observed.r,cpuMs:(observed.r.userSeconds+observed.r.systemSeconds)*1000,rssKiB:observed.r.rssBytes/1024,
    stdoutBytes:observed.stdout.length,stderrBytes:observed.stderr.length,signature:observed.signature,parity:observed.signature===actual};
  append('raw.jsonl',row);
  assert.ok(row.parity, JSON.stringify(row));
};
for (const cache of initialCold ? ['warm','purged'] : ['warm']) {
  if(cache==='warm') {
    for(const side of sides) {
      observe(side,'ordinary',server);
      for(const f of [arms[side],...sourceSamples]) fs.readFileSync(f);
    }
  }
  for(let pair=0;pair<rounds;pair++) {
    for(const mode of pair%2 ? ['fast','ordinary'] : ['ordinary','fast']) {
      const order=(pair+(mode==='fast'?1:0))%2 ? ['B','A'] : ['A','B'];
      for(const side of order) {
        if(cache==='purged') {
          const reset=purge(); append('purges.jsonl',{pair,mode,side,...reset});
          if(reset.status!==0) throw Error('purge stopped succeeding: '+JSON.stringify(reset));
        }
        trial(cache,side,mode,pair,order.join(''));
      }
    }
    console.log(cache+' pair '+(pair+1)+' of '+rounds);
  }
}
