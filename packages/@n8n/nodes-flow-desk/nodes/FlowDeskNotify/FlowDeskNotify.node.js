'use strict';
const { getFlowDeskApi } = require('../shared/stepBase');
class FlowDeskNotify {
 constructor() { this.description = { displayName:'发送飞书', name:'flowDeskNotify', group:['transform'], version:1, description:'Send a Feishu card for a work item', defaults:{name:'发送飞书'}, inputs:['main'], outputs:['main'], properties:[{displayName:'Title',name:'title',type:'string',default:''},{displayName:'Buttons',name:'buttons',type:'string',default:''}] }; }
 async execute() {
  const input=this.getInputData()[0]?.json??{},api=getFlowDeskApi(this);
  const buttons=String(this.getNodeParameter('buttons')||'').split(',').map(item=>item.trim()).filter(Boolean);
  const targets=Array.isArray(input.createdWorkItems)?input.createdWorkItems:[];
  for(const item of targets){const workItemId=item.id||item.issueId;if(!workItemId||item.created===false)continue;await api.notify.send({workItemId,title:item.title||this.getNodeParameter('title'),buttons,area:input.area});}
  return [[{json:input}]];
 }
}
module.exports={FlowDeskNotify};
