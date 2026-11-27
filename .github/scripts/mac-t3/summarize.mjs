import {readFileSync} from 'node:fs';
const median = xs => {
  const s=xs.toSorted((a,b)=>a-b);
  return s.length%2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2;
};
function geometric(logs){return (Math.exp(logs.reduce((a,b)=>a+b,0)/logs.length)-1)*100;}
const groups=new Map();
for (const file of process.argv.slice(2)) {
  const content=readFileSync(file,'utf8').trim();
  if(!content)continue;
  for(const line of content.split('\n')){
    const row=JSON.parse(line);
    if(row.pair<0) continue;
    if(!row.parity) throw Error('parity mismatch '+row.name);
    if(!groups.has(row.name)) groups.set(row.name,new Map());
    const g=groups.get(row.name);
    if(!g.has(row.pair))g.set(row.pair,{});
    const pair=g.get(row.pair);
    if(pair[row.side])throw Error('duplicate arm '+row.name+' '+row.side);
    pair[row.side]=row;
  }
}
const t95=[0,12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.16,2.145,2.131,2.120,2.110,2.101,2.093,2.086,2.080,2.074,2.069,2.064,2.060,2.056,2.052,2.048,2.045,2.042];
function critical95(df) {
  if (df <= 30) return t95[df];
  // Use the next wider interval when the degrees of freedom lie between table entries.
  if (df < 40) return 2.042;
  if (df < 60) return 2.021;
  if (df < 120) return 2.000;
  return 1.980;
}
const f=x=>Number(x.toFixed(2));
for(const [name,rows] of groups){
  const pairs=[...rows.values()];
  if (pairs.some(p=>!p.A || !p.B)) throw Error('incomplete pair in '+name);
  if (pairs.length < 2) throw Error('at least two matched pairs are required for '+name);
  const n=pairs.length;
  const summary={name,n,out:pairs[0].A.stdoutBytes,status:pairs[0].A.status};
  for(const key of ['wallMs','commandSeconds','instructions','rssKiB','cpuMs','fsInputBlocks','majorFaults','minorFaults']){
    const valid=pairs.filter(p=>p.A[key]>0&&p.B[key]>0);if(valid.length!==n)continue;
    const log=valid.map(p=>Math.log(p.B[key]/p.A[key]));
    const avg=log.reduce((a,b)=>a+b)/n;
    const varMean=log.reduce((a,b)=>a+(b-avg)**2,0)/(n*(n-1));
    const half=critical95(n-1)*Math.sqrt(varMean);
    summary[key]={A:f(median(valid.map(p=>p.A[key]))),B:f(median(valid.map(p=>p.B[key]))),
      pct:f(geometric(log)),lo:f(Math.expm1(avg-half)*100),hi:f(Math.expm1(avg+half)*100)};
  }
  console.log(JSON.stringify(summary));
}
