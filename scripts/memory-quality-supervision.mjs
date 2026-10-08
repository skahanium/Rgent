/** Local evaluator control messages are bound to a parent-generated nonce and two ordered slots. */
export function utilitySupervision(token) {
 let index=0
 const seen=new Set()
 return value=>{
  if(!value||value.evaluationBoundary!=='utility-answer'||value.token!==token)return false
  if(value.index!==index||index>=2||!['on','off'].includes(value.condition)||seen.has(value.condition))throw Error('EVALUATION_UTILITY_SUPERVISION_ORDER')
  seen.add(value.condition);index++;return true
 }
}
