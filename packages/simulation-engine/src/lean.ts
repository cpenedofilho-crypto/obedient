// SPDX-License-Identifier: AGPL-3.0-only
import {generate} from './index.js';
export function compareFlow(seed:number,count:number,stageSeconds:readonly number[]){
 const scenarios=generate(seed,count);
 if(stageSeconds.length<2||stageSeconds.length>16||stageSeconds.some(n=>!Number.isSafeInteger(n)||n<1||n>3600)) throw new RangeError('invalid stages');
 return (['serial','pipeline'] as const).map(strategy=>{
  const finish=stageSeconds.map(()=>0);
  let serial=0,work=0;
  for(const s of scenarios){
   for(let i=0;i<stageSeconds.length;i++){
    const duration=stageSeconds[i]!+s.failures;
    work+=duration;
    if(strategy==='serial'){serial+=duration;finish[i]=serial;}
    else finish[i]=Math.max(finish[i]!,i===0?0:finish[i-1]!)+duration;
   }
  }
  const elapsedSeconds=finish[finish.length-1]!;
  return Object.freeze({version:1,synthetic:true,seed,count,strategy,elapsedSeconds,workSeconds:work,unitsPerHour:count*3600/elapsedSeconds,utilization:work/(elapsedSeconds*stageSeconds.length),externalEffects:0,productionAuthorized:false});
 });
}
