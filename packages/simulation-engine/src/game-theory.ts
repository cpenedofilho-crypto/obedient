// SPDX-License-Identifier: AGPL-3.0-only
export type Payoff = readonly [number, number];
export function analyzeGame(matrix: readonly (readonly Payoff[])[]) {
  const rows = matrix.length, cols = matrix[0]?.length ?? 0;
  if (!rows || !cols || rows > 32 || cols > 32) throw new RangeError('invalid dimensions');
  const outcomes: {row:number; col:number; payoff:Payoff}[] = [];
  for (let row=0;row<rows;row++) {
    const line=matrix[row];
    if (!line || line.length!==cols) throw new RangeError('invalid matrix');
    for(let col=0;col<cols;col++){
      const p=line[col];
      if(!p || p.length!==2 || !p.every(Number.isFinite)) throw new RangeError('invalid payoff');
      outcomes.push({row,col,payoff:[p[0],p[1]]});
    }
  }
  const nash=outcomes.filter(x=>!outcomes.some(y=>(y.col===x.col && y.payoff[0]>x.payoff[0]) || (y.row===x.row && y.payoff[1]>x.payoff[1])));
  const pareto=outcomes.filter(x=>!outcomes.some(y=>y.payoff[0]>=x.payoff[0] && y.payoff[1]>=x.payoff[1] && (y.payoff[0]>x.payoff[0] || y.payoff[1]>x.payoff[1])));
  return {synthetic:true as const,nash,pareto};
}
