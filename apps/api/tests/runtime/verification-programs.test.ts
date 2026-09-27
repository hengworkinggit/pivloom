import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { GroupedPlanSchema, type Plan } from '@pivloom/contracts';
import { prepareVerificationPrograms } from '../../src/runtime/verification-programs.js';
import { VerificationProgramSpecSchema, type VerificationProgramAsset } from '../../src/runtime/verification-program-contract.js';

const program=VerificationProgramSpecSchema.parse({initialState:'fresh',evidence:'text',steps:[{type:'open'},{type:'key_sequence',keys:['6','*','7','Enter']}],
  assertions:[{kind:'target-text',target:{label:'结果'},text:'42'}]});
const plan=GroupedPlanSchema.parse({schemaVersion:2,verificationMode:'programs',goal:'计算器',changeSummary:'保留旧功能',assumptions:[],outOfScope:[],replacements:[],
  behaviors:Array.from({length:5},(_,i)=>({id:`B0${i+1}`,title:'计算',precondition:'空计算器',action:'输入6*7并提交',expected:'结果42',required:true})),
  groups:Array.from({length:5},(_,i)=>({id:`G${i+1}`,title:`组${i+1}`,behaviorIds:[`B0${i+1}`]}))});
const response=(ids:string[])=>({programs:ids.map(behaviorId=>({behaviorId,program:structuredClone(program)}))});
function fixture(responses: unknown[]) {
  const controller=new AbortController();const saved=new Map<string,VerificationProgramAsset>();
  const cache={load:vi.fn(async()=>[...saved.values()]),save:vi.fn(async(assets:VerificationProgramAsset[])=>{
    for(const asset of assets)saved.set(asset.behaviorId+asset.requirementHash,asset);return assets;
  })};
  const request=vi.fn(async()=>responses.shift());
  const observe=vi.fn(async()=>({id:randomUUID(),sessionId:'fixture',url:'http://127.0.0.1:4173/',tree:'button 6',text:'0',truncated:false,refs:{}}));
  const input={plan,sourceHash:'a'.repeat(64),files:[{path:'src/App.tsx',content:'<div aria-label="结果">0</div>'}],cache,
    compiler:{maxOutputTokens:16384,request,usage:()=>({modelCalls:request.mock.calls.length,toolCalls:request.mock.calls.length,input:null,output:null,total:null,cachedTokens:null,elapsedMs:0,source:'unreported' as const})},
    observe,signal:controller.signal,assertActive:async()=>{}};
  return {input,cache,request,observe,controller,saved};
}

test('compile legacy requirements once, retain their exact criteria, then reuse without another model or browser setup',async()=>{
  const f=fixture([response(plan.behaviors.map(b=>b.id))]);const original=structuredClone(plan);
  const first=await prepareVerificationPrograms(f.input);
  expect(first).toMatchObject({compiled:5,reused:0,failures:[]});expect(f.request).toHaveBeenCalledTimes(1);
  for(const [index,behavior] of first.plan.behaviors.entries())expect(behavior).toMatchObject(original.behaviors[index]);
  expect(f.input.plan).toEqual(original);expect(f.saved.size).toBe(5);
  const reused=await prepareVerificationPrograms(f.input);
  expect(reused).toMatchObject({compiled:0,reused:5,failures:[]});expect(f.request).toHaveBeenCalledTimes(1);expect(f.observe).toHaveBeenCalledTimes(1);
});
test('one malformed program is corrected alone with its full field path; the other four saved programs are not regenerated',async()=>{
  const first=response(plan.behaviors.map(b=>b.id));const broken:unknown={...first.programs[2],program:{...program,steps:[{type:'open'},{type:'key_sequence',repeat:21}]}};
  const f=fixture([{programs:[...first.programs.slice(0,2),broken,...first.programs.slice(3)]},response(['B03'])]);
  const result=await prepareVerificationPrograms(f.input);
  expect(result).toMatchObject({compiled:5,reused:0,failures:[]});expect(f.cache.save.mock.calls.map(call=>call[0].length)).toEqual([4,1]);
  const second=JSON.stringify(f.request.mock.calls[1]);
  expect(second).toContain('B03.program.steps.[1].keys');expect(second).toContain('B03');
  expect(second).not.toContain('"id":"B01"');
});
test('after bounded compiler corrections, unsupported requirements remain present and explicitly uncompiled',async()=>{
  const bad={programs:[{behaviorId:'B01',program:{}}]};const f=fixture([bad,bad,bad]);
  const result=await prepareVerificationPrograms(f.input);
  expect(result.plan).toEqual(plan);expect(result.failures.map(x=>x.behaviorId)).toEqual(plan.behaviors.map(x=>x.id));
  expect(f.request).toHaveBeenCalledTimes(3);expect(f.cache.save).not.toHaveBeenCalled();
});
test('cancellation after the model response cannot save a program or claim compilation completed',async()=>{
  const f=fixture([]);f.request.mockImplementation(async()=>{f.controller.abort('CANCELLED');return response(plan.behaviors.map(b=>b.id));});
  await expect(prepareVerificationPrograms(f.input)).rejects.toBe('CANCELLED');expect(f.cache.save).not.toHaveBeenCalled();
});
test('interactive requirements do not go through the scripted compiler or reinterpret stored assets',async()=>{
  const f=fixture([]);const interactive:Plan={...plan,verificationMode:'interactive'};
  expect(await prepareVerificationPrograms({...f.input,plan:interactive})).toEqual({plan:interactive,compiled:0,reused:0,failures:[]});
  expect(f.cache.load).not.toHaveBeenCalled();expect(f.observe).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
});
