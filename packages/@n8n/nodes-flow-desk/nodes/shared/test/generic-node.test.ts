import {createRequire} from 'node:module';
import {describe,expect,it,vi} from 'vitest';
const require=createRequire(import.meta.url);
describe('generic runtime nodes',()=>{
 it('registers all twelve capabilities from one implementation',()=>{
  const {genericNodeTypes}=require('../genericNode.js');
  expect(genericNodeTypes).toHaveLength(12);expect(new Set(genericNodeTypes).size).toBe(12);
 });
 it('does not progress failed or blocked results',async()=>{
  const {createGenericNode}=require('../genericNode.js');const Node=createGenericNode('command');
  const context={getNode:()=>({id:'command',name:'Install'}),getExecutionId:()=>'25',getInputData:()=>[{json:{projectId:'p',runId:'r'}}],flowDesk:{executeNode:vi.fn(async()=>({status:'failed',error:'exit 7'}))}};
  await expect(new Node().execute.call(context)).rejects.toThrow('exit 7');
 });
 it('retains immutable input context in successful output',async()=>{
  const {createGenericNode}=require('../genericNode.js');const Node=createGenericNode('command');
  const input={projectId:'p',runId:'r',configHash:'snapshot',workspaceId:'w'};
  const context={getNode:()=>({id:'command',name:'Install'}),getExecutionId:()=>'25',getInputData:()=>[{json:input}],flowDesk:{executeNode:vi.fn(async()=>({status:'passed',result:{stdout:'installed'}}))}};
  expect((await new Node().execute.call(context))[0][0].json).toMatchObject(input);
 });
});

it('loads the actual built package with unique generic and compatibility node names',async()=>{
 const {execFileSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const {dirname,resolve}=await import('node:path');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 execFileSync(process.execPath,[resolve(root,'scripts/build.mjs')],{cwd:root});
 const built=require(resolve(root,'index.js'));const names=built.nodes.map((Node:new()=>{description:{name:string}})=>new Node().description.name);
 expect(names).toHaveLength(18);expect(new Set(names).size).toBe(18);
 const catalog=require(resolve(root,'contracts/node-catalog.json'));for(const entry of catalog)expect(names).toContain(entry.n8nType);
});

it('uses only an explicitly authorized recovery output for a failed result',async()=>{
 const {createGenericNode}=require('../genericNode.js');const Node=createGenericNode('verify');const input={projectId:'p',flowId:'scan',runId:'r'};const context={getNode:()=>({id:'verify',name:'Verify'}),getExecutionId:()=>'1',getInputData:()=>[{json:input}],flowDesk:{executeNode:async()=>({status:'failed',outputIndex:1,error:'tests failed'})}};
 const output=await new Node().execute.call(context);expect(output[0]).toEqual([]);expect(output[1][0].json.nodeStatus).toBe('failed');
});
