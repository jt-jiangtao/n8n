import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const { FlowDeskAgentStep } = require('../../FlowDeskAgentStep/FlowDeskAgentStep.node.js');
const { FlowDeskEndCheck } = require('../../FlowDeskEndCheck/FlowDeskEndCheck.node.js');
const marker = '<promise>COMPLETE</promise>';
const input = {workItem:'parent',flowRunId:'run',area:'target',repo:'/tmp/target',baseRef:'main'};
function ctx(data = input) {
  const parameters = {endMarker:marker,maxAttempts:8,promptId:'ui-scan',step:'ui-scan',adapter:'codex',writes:false,model:'',requiredFields:[]};
  return {
    getNode:()=>({id:'scan',name:'Scan',parameters}),getExecutionId:()=>'execution',
    getNodeParameter:(name:string)=>parameters[name as keyof typeof parameters],
    getInputData:()=>[{json:data}],
    flowDesk:{steps:{register:vi.fn(async()=>({taskId:'task',attempt:1})),savedResult:vi.fn(async()=>null)},tasks:{dispatch:vi.fn()}},
    putExecutionToWait:vi.fn(),
  };
}
describe('runtime JS scan success gates',()=>{
  it('passes Codex through to dispatch',async()=>{
    const context=ctx();await new FlowDeskAgentStep().execute.call(context);
    expect(context.flowDesk.steps.register).toHaveBeenCalledWith(expect.objectContaining({adapter:'codex'}));
  });
  it('keeps original context when the result resumes',async()=>{
    const context={...ctx(),flowDeskResume:{branch:'success',data:{status:'ok',summary:'continue',attempt:1,newIssues:[]}}};
    const output=await new FlowDeskAgentStep().execute.call(context);
    expect(output[0][0].json).toMatchObject({...input,summary:'continue',newIssues:[]});
  });
  it.each(['failed','aborted'])('does not progress a %s result',async status=>{
    await expect(new FlowDeskAgentStep().execute.call({...ctx(),flowDeskResume:{branch:'failure',data:{status,summary:status}}})).rejects.toThrow();
  });
  it('does not return a normal result after reaching the round limit',async()=>{
    await expect(new FlowDeskAgentStep().execute.call(ctx({...input,attempt:8} as typeof input))).rejects.toThrow(/上限|limit/i);
  });
  it('does not treat an end marker plus findings as complete',async()=>{
    await expect(new FlowDeskEndCheck().execute.call({getNodeParameter:()=>marker,getInputData:()=>[{json:{summary:marker,newIssues:[{title:'issue'}]}}]})).rejects.toThrow();
  });
});

describe('subsequent saved round',()=>{
 it('uses a newer saved result instead of dispatching the same round again',async()=>{
  const context=ctx({...input,attempt:1} as typeof input);
  context.flowDesk.steps.savedResult=vi.fn(async()=>({branch:'success',data:{attempt:2,status:'ok',summary:'second',newIssues:[]}})) as never;
  const output=await new FlowDeskAgentStep().execute.call(context);
  expect(output[0][0].json).toMatchObject({...input,attempt:2,summary:'second'});
  expect(context.flowDesk.steps.register).not.toHaveBeenCalled();
 });
});
