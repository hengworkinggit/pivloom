import { expect, test } from 'vitest';
import { GroupedPlanSchema, type BehaviorTarget } from '@pivloom/contracts';
import { applyVerificationPrograms, verificationProgramHash, verificationRequirementHash, VerificationProgramSpecSchema } from '../../src/runtime/verification-program-contract.js';

const behavior: BehaviorTarget = { id:'B01', title:'运算', precondition:'空计算器', action:'输入6*7并按等号', expected:'结果为42', required:true };
const spec = { initialState:'fresh', evidence:'text', steps:[{type:'open',path:'/'},{type:'key_sequence',keys:['6','*','7','Enter'],repeat:1}],
  assertions:[{kind:'target-text',target:{label:'结果'},text:'42',match:'exact',negated:false}] };

test('a legacy aria-labelled outcome can be checked without pretending it has a different ARIA role',()=>{
  const program=VerificationProgramSpecSchema.parse(spec);
  expect(program.assertions[0]).toMatchObject({target:{label:'结果'},text:'42',match:'exact'});
});
test('a compiled functional program cannot substitute whole-page or console-only facts for the outcome',()=>{
  for(const assertions of [[{kind:'text',text:'42',negated:false}],[{kind:'console-error',negated:true}]])
    expect(VerificationProgramSpecSchema.safeParse({...spec,assertions}).success).toBe(false);
});
test('program reuse keeps canonical criteria and rejects an unrelated requirement or overwriting embedded programs',()=>{
  const program=VerificationProgramSpecSchema.parse(spec);
  const plan=GroupedPlanSchema.parse({schemaVersion:2,goal:'计算器',changeSummary:'新增历史',assumptions:[],outOfScope:[],replacements:[],
    behaviors:Array.from({length:5},(_,i)=>({...behavior,id:`B0${i+1}`})),
    groups:Array.from({length:5},(_,i)=>({id:`G${i+1}`,title:`组${i+1}`,behaviorIds:[`B0${i+1}`]}))});
  const asset={behaviorId:'B01',requirementHash:verificationRequirementHash(behavior),program,programHash:verificationProgramHash(program),sourceHash:'a'.repeat(64)};
  const reused=applyVerificationPrograms(plan,[asset]);
  expect(reused.behaviors[0]).toEqual({...behavior,...program});
  expect(reused.behaviors.slice(1)).toEqual(plan.behaviors.slice(1));
  expect(applyVerificationPrograms(plan,[{...asset,requirementHash:'b'.repeat(64)}])).toEqual(plan);
  const embedded={...plan,behaviors:plan.behaviors.map((b,i)=>i===0?{...b,...program,steps:[{type:'open' as const,path:'/original'}]}:b)};
  expect(applyVerificationPrograms(embedded,[asset])).toEqual(embedded);
});
