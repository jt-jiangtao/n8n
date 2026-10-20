'use strict';
const { getFlowDeskApi, putWait } = require('./stepBase');
const catalog = require('../../contracts/node-catalog.json');
const genericNodeTypes = catalog.map((entry) => entry.type);
const labels = {start:'开始任务',workspace:'准备工作区',command:'执行命令',service:'管理服务',agent:'执行 Agent',verify:'验证结果',approval:'人工审批','work-item':'管理工单',integrate:'集成提交',subflow:'调用子流程',notify:'发送通知',finish:'结束任务',if:'条件分支'};
function createGenericNode(type) {
 const entry = type==='if'?{n8nType:'flowDeskCondition',inputSchema:'workflow-condition-params'}:catalog.find((item) => item.type === type);
 if (!entry) throw new Error(`Unknown generic node: ${type}`);
 return class {
  constructor() {
   const schema = require(`../../contracts/${entry.inputSchema}.schema.json`);
   const properties = Object.entries(schema.properties).map(([name, spec]) => ({
    displayName:name,name,type:spec.enum?'options':spec.type==='boolean'?'boolean':spec.type==='integer'?'number':spec.type==='array'||spec.type==='object'?'json':'string',
    default:spec.type==='boolean'?false:spec.type==='integer'?1:spec.type==='array'?'[]':spec.type==='object'?'{}':'',
    ...(name==='command'?{typeOptions:{rows:6}}:{}),
    ...(spec.enum?{options:spec.enum.map((value)=>({name:value,value}))}:{}),required:(schema.required||[]).includes(name),
   }));
   if(type==='start')properties.unshift({displayName:'Project',name:'projectId',type:'string',default:'',required:true},{displayName:'Flow',name:'flowId',type:'string',default:'',required:true});
   this.description={displayName:labels[type],name:entry.n8nType,group:[type==='start'?'trigger':'transform'],version:1,description:labels[type],defaults:{name:labels[type]},inputs:type==='start'?[]:['main'],outputs:['main','main','main'],outputNames:type==='if'?['条件成立','条件不成立','失败恢复']:['成功','失败恢复','审批退回'],properties};
  }
  async execute() {
   const input=this.getInputData()[0]?.json??{}, node=this.getNode(), api=this.flowDesk??getFlowDeskApi(this);
   const projectId=input.projectId||(type==='start'?this.getNodeParameter('projectId'):'');
   const flowId=input.flowId||(type==='start'?this.getNodeParameter('flowId'):'');
   const executeData=this.getExecuteData?.();let invocationId;if(executeData){executeData.metadata??={};executeData.metadata.flowDeskInvocation??=require('node:crypto').randomUUID();invocationId=executeData.metadata.flowDeskInvocation;}
   const response=await api.executeNode({executionId:this.getExecutionId(),nodeId:node.id,projectId,flowId,type,input,invocationId});
   if(response.status==='waiting-approval'||response.status==='running'||response.status==='queued'){
    await putWait(this);return [this.getInputData()];
   }
   if(response.status!=='passed'&&!(Number.isInteger(response.outputIndex)&&response.outputIndex>=1&&response.outputIndex<=2))throw new Error(response.error||`Node ${node.name} did not pass: ${response.status}`);
   const context=response.context||{};
   for(const field of ['projectId','runId','configHash'])if(input[field]&&context[field]&&input[field]!==context[field])throw new Error('Immutable execution identity changed');
   const output=[[],[],[]];output[response.outputIndex??0]=[{json:{...input,...context,nodeStatus:response.status,results:{...(input.results||{}),...(context.results||{}),[node.id]:response.result||{}}}}];return output;
  }
 };
}
module.exports={createGenericNode,genericNodeTypes};
