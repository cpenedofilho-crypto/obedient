// SPDX-License-Identifier: AGPL-3.0-only
export type Strategy = 'cooperate' | 'compete';
export type Agent = Readonly<{strategy: Strategy; demand: number}>;
export function simulateAgents(agents: readonly Agent[], capacity: number, rounds: number) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000 || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1000 || agents.length < 2 || agents.length > 32) throw new RangeError('invalid limits');
  for (const a of agents) if (!Number.isSafeInteger(a.demand) || a.demand < 1 || a.demand > 10000 || (a.strategy !== 'cooperate' && a.strategy !== 'compete')) throw new RangeError('invalid agent');
  const served = agents.map(()=>0);
  let unused = 0;
  for(let round=0;round<rounds;round++){
    let remaining=capacity;
    const order=agents.map((_,i)=>(i+round)%agents.length);
    const requests=agents.map(a=>a.strategy==='cooperate'?Math.min(a.demand,Math.max(1,Math.floor(capacity/agents.length))):a.demand);
    for(const i of order){
      const grant=Math.min(remaining,requests[i]!);
      served[i]=served[i]!+grant;
      remaining-=grant;
    }
    unused+=remaining;
  }
  const total=served.reduce((a,b)=>a+b,0);
  const squares=served.reduce((a,b)=>a+b*b,0);
  return {synthetic:true as const,served,total,unused,utilization:total/(capacity*rounds),fairness:squares===0?0:total*total/(agents.length*squares),externalEffects:0};
}
