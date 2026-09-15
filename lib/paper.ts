export type Position={symbol:string;qty:number;cost:number;entry:number;opened:string};
export type Trade={id:string;time:string;side:'buy'|'sell';symbol:string;qty:number;price:number;fee:number;pnl:number;reason:string;sourceTime:number};
export type Portfolio={initial:number;cash:number;positions:Position[];trades:Trade[];curve:{time:string;value:number}[];settings:{fee:number;slippage:number;orderSize:number;stopLoss:number;takeProfit:number};lastCycle:string|null};
export function initialPortfolio():Portfolio{return{initial:10000000,cash:10000000,positions:[],trades:[],curve:[{time:new Date().toISOString(),value:10000000}],settings:{fee:0.05,slippage:0.05,orderSize:1000000,stopLoss:3,takeProfit:6},lastCycle:null};}
export function paperTrade(p:Portfolio,input:{side:'buy'|'sell';symbol:string;amount?:number;reason:string;id:string},book:{bids:{price:number;qty:number}[];asks:{price:number;qty:number}[];timestamp:number}){
 if(p.trades.some(t=>t.id===input.id))throw new Error('이미 처리된 모의 주문입니다.');
 const pos=p.positions.find(x=>x.symbol===input.symbol);const feeRate=p.settings.fee/100;const slip=p.settings.slippage/100;let qty=0,gross=0;
 if(input.side==='buy'){
  const budget=input.amount??p.settings.orderSize;if(!Number.isFinite(budget)||budget<5000||budget>p.cash||budget>p.settings.orderSize)throw new Error('가용 잔고와 1회 투자 한도를 확인해 주세요.');if(pos)throw new Error('이미 보유한 종목입니다. 최초 버전은 추가 매수를 제한합니다.');
  let remain=budget/(1+feeRate);for(const level of book.asks){const price=level.price*(1+slip);const take=Math.min(level.qty,remain/price);qty+=take;gross+=take*price;remain-=take*price;if(remain<.01)break;}if(remain>1||qty<=0)throw new Error('호가 잔량이 부족해 전량 체결할 수 없습니다.');const fee=gross*feeRate;p.cash-=gross+fee;p.positions.push({symbol:input.symbol,qty,cost:gross+fee,entry:gross/qty,opened:new Date().toISOString()});p.trades.unshift({id:input.id,time:new Date().toISOString(),side:'buy',symbol:input.symbol,qty,price:gross/qty,fee,pnl:0,reason:input.reason,sourceTime:book.timestamp});
 }else{
  if(!pos)throw new Error('보유하지 않은 종목입니다.');let remain=pos.qty;for(const level of book.bids){const take=Math.min(level.qty,remain);qty+=take;gross+=take*level.price*(1-slip);remain-=take;if(remain<=pos.qty*1e-10)break;}if(remain>pos.qty*1e-8||qty<=0)throw new Error('호가 잔량이 부족해 전량 매도할 수 없습니다.');const fee=gross*feeRate;p.cash+=gross-fee;p.positions=p.positions.filter(x=>x.symbol!==input.symbol);p.trades.unshift({id:input.id,time:new Date().toISOString(),side:'sell',symbol:input.symbol,qty,price:gross/qty,fee,pnl:gross-fee-pos.cost,reason:input.reason,sourceTime:book.timestamp});
 }
 return p;
}
export function validateSettings(v:any){for(const [k,min,max] of [['fee',0,2],['slippage',0,5],['orderSize',5000,10000000],['stopLoss',0.1,50],['takeProfit',0.1,100]] as const){if(typeof v?.[k]!=='number'||!Number.isFinite(v[k])||v[k]<min||v[k]>max)throw new Error('운용 설정의 범위를 확인해 주세요.');}return{fee:v.fee,slippage:v.slippage,orderSize:v.orderSize,stopLoss:v.stopLoss,takeProfit:v.takeProfit};}
