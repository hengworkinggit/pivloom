import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ReviewBindingSchema, type ReviewBinding, type ReviewResult, type Handoff } from '@pivloom/contracts';
import { OpenSandboxWorkspace, type SandboxConnector } from '../runtime/workspace.js';
import { RemoteBrowser } from '../runtime/browser.js';
import { sourceHash } from '../runtime/generation.js';
import { runReviewer, assertReviewerResult, type ReviewObservationEvent, type ReviewCheckpoint } from '../runtime/reviewer.js';
import { runScriptedPlan } from '../runtime/replay-plan.js';
import { RuntimeError, type ModelConfig, type SandboxConfig, type ProbeEventSink, type ProbeEvent } from '../runtime/types.js';
import { SANDBOX_LEASE_RENEW_THRESHOLD_MS, SANDBOX_LEASE_SEGMENT_MS } from '../runtime/budgets.js';
import { type TokenUsage, type RunTokenBudget } from '../runtime/token-budget.js';
import { assertVerifiedSourceSnapshot, type SourceStore, type VerifiedSourceSnapshot } from '../storage/source.js';
import type { ArtifactStore, StoredArtifact } from '../storage/artifacts.js';

export interface VerifiedReviewReceipt {
  binding: ReviewBinding; source: VerifiedSourceSnapshot; result: ReviewResult;
  artifacts: StoredArtifact[]; evidence: ReviewObservationEvent[];
  markerVerified: boolean; chromeClosed: true;
  /** Internal, allowlisted browser transport failure. Never inferred from a blocked business verdict. */
  recoverableInfrastructureCode?: 'BROWSER_BLOCKED' | 'BROWSER_TIMEOUT';
}
const receipts=new WeakSet<object>();
const blockedReasons=new Map([
  ['FORM_TARGET_CHANGED','表单控件发生变化或无法唯一定位，已停止后续操作，当前候选尚未通过检查。'],
  ['INVALID_BROWSER_ACTION','浏览器无法执行受控操作，已停止后续操作，当前候选尚未通过检查。'],
  ['BROWSER_TIMEOUT','浏览器操作超时，已停止后续操作，当前候选尚未通过检查。'],
  ['COMMAND_TIMEOUT','浏览器操作超时，已停止后续操作，当前候选尚未通过检查。'],
  ['BROWSER_ORIGIN_REJECTED','浏览器离开了绑定的候选预览，已停止检查。'],
  ['BROWSER_SESSION_LOST','检查浏览器丢失了候选页面，需在新浏览器会话重新检查。'],
  // These four used to abort a check with a bare CHECK_BLOCKED, which rendered as
  // the same generic sentence no matter which one fired. Naming them is what makes
  // an aborted check actionable.
  ['REVIEW_OBSERVATION_UNBOUND','检查浏览器返回了不属于本次候选会话的观察，已停止检查。'],
  ['REVIEW_EVIDENCE_TOO_LARGE','本次检查的证据记录达到容量上限，已停止检查；这是检查侧的限制，不是作品行为不通过。'],
  ['REVIEW_PREVIEW_ORIGIN','检查浏览器离开了绑定的候选预览，已停止检查。'],
  ['REVIEW_BROWSER_UNCLOSED','检查浏览器未能确认关闭，为避免影响后续检查已停止。'],
  // A budget stop is not an unexplained failure: without this entry the run is
  // classified CHECK_BLOCKED with the generic sentence, and the persisted
  // error_code no longer says that the check ran out of its own wall clock.
  ['REVIEW_TIMEOUT','本次检查超过验收时间上限，已停止并保留未完成状态；这不代表候选通过。'],
  ['BROWSER_BLOCKED','浏览器无法访问或完成页面操作，当前候选尚未通过检查。'],
  ['REVIEWER_TOOL_FAILED','浏览器无法访问或完成页面操作，当前候选尚未通过检查。'],
  ['VISION_NOT_VERIFIED','当前模型的图像能力未通过实际图片测试，请在模型设置中验证支持图像的配置；当前候选尚未完成视觉检查。'],
]);
export function assertVerifiedReviewReceipt(receipt:VerifiedReviewReceipt){
  if(!receipts.has(receipt))throw new RuntimeError('INVALID_REVIEW_RECEIPT','检查结果未经版本和浏览器证据校验');
  assertVerifiedSourceSnapshot(receipt.source);
}
export interface DurableReviewCheckpoint extends Omit<ReviewCheckpoint,'artifacts'> {
  artifacts:StoredArtifact[];
}
export interface ReviewInput {
  binding:ReviewBinding;sessionId:string;handoff:Handoff;expiresAt:string;
  source:VerifiedSourceSnapshot;sources:SourceStore;artifacts:ArtifactStore;
  sandboxConfig:SandboxConfig;modelConfig:ModelConfig;signal:AbortSignal;
  tokenBudget?:RunTokenBudget;maxToolCalls?:number;onEvent?:ProbeEventSink;assertActive():Promise<void>;
  onCheckpoint?(checkpoint:DurableReviewCheckpoint):Promise<void>;
  onLeaseRenewed(expiresAt:string):Promise<void>;
}
function freeze<T>(value:T):T{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Object.freeze(value);for(const child of Object.values(value))freeze(child);
  }return value;
}
/** The only receipt issuer verifies immutable objects, remote source + marker,
 * actual browser evidence and closing. Test injection is external sandbox/HTTP. */
export async function runReview(input:ReviewInput,boundaries:{sandboxConnector?:SandboxConnector;previewFetch?:typeof fetch}={}):Promise<{receipt:VerifiedReviewReceipt;usage?:TokenUsage}>{
  const binding=ReviewBindingSchema.parse(input.binding);
  assertVerifiedSourceSnapshot(input.source);
  if(input.source.revisionId!==binding.revisionId||input.source.sourceHash!==binding.sourceHash)
    throw new RuntimeError('INVALID_REVIEW_RECEIPT','检查源码与候选版本不一致');
  const workspace=new OpenSandboxWorkspace(input.sandboxConfig,boundaries.sandboxConnector);
  let handle={sandboxId:binding.sandboxId,expiresAt:input.expiresAt};
  const browser=new RemoteBrowser(workspace,handle,undefined,binding.browserSessionId);
  const leaseAbort=new AbortController(),signal=AbortSignal.any([input.signal,leaseAbort.signal]);
  const artifacts:StoredArtifact[]=[];
  let markerVerified=false,connected=false,reviewerStarted=false,usage:TokenUsage|undefined,leaseFailure:RuntimeError|undefined;
  let recoverableInfrastructureCode:VerifiedReviewReceipt['recoverableInfrastructureCode'];
  let evidence:ReviewObservationEvent[]=[],result:ReviewResult|undefined;
  const active=async()=>{signal.throwIfAborted();await input.assertActive();signal.throwIfAborted();};
  async function ensureLease(force=false){
    if(!force&&Date.parse(handle.expiresAt)-Date.now()>SANDBOX_LEASE_RENEW_THRESHOLD_MS)return;
    try{
      const renewed=await workspace.renewLease(handle,SANDBOX_LEASE_SEGMENT_MS,signal);
      await input.onLeaseRenewed(renewed.expiresAt);
      handle=renewed;
    }catch{
      leaseFailure=new RuntimeError('SANDBOX_LEASE_RENEW_FAILED','检查沙箱续租未确认，已停止并清理本轮任务');
      leaseAbort.abort(leaseFailure);
      throw leaseFailure;
    }
  }
  async function verifyVersion(){
    await active();
    await input.sources.verify(input.source);
    signal.throwIfAborted();
    if(sourceHash(await workspace.listSourceFiles(handle,{signal}))!==binding.sourceHash)
      throw new RuntimeError('CHECK_VERSION_MISMATCH','检查前后源码版本发生变化');
    signal.throwIfAborted();
    const endpoint=await workspace.endpoint(handle,4173);
    signal.throwIfAborted();
    const response=await (boundaries.previewFetch??fetch)(endpoint.url+'/pivloom-revision.json',{
      headers:endpoint.headers,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
    const body=await response.text();
    if(!response.ok||Buffer.byteLength(body)>4096)throw new RuntimeError('CHECK_BLOCKED','无法验证候选预览');
    const marker=z.strictObject({revisionId:z.uuid(),sourceHash:z.string()}).parse(JSON.parse(body));
    if(marker.revisionId!==binding.revisionId||marker.sourceHash!==binding.sourceHash)throw new RuntimeError('CHECK_VERSION_MISMATCH','预览标记不匹配当前候选');
    await active();
  }
  try{
    await active();await workspace.connect(handle);connected=true;
    await ensureLease(true);
    await verifyVersion();
    const files=(await input.sources.load(input.source)).files;
    reviewerStarted=true;
    // Every event either layer emits has to walk the sandbox lease first: a
    // scripted pass performs no model request, so this is the only place that
    // notices the preview lease is close to expiry while the browser works.
    const emitEvent=async(event:ProbeEvent)=>{await ensureLease();await input.onEvent?.(event);};
    const saveScreenshot=async(image:{base64:string;mimeType:'image/png';sha256:string})=>{
      await active();const artifact=await input.artifacts.save(input.source,image,signal);await active();artifacts.push(artifact);
      return artifact;
    };
    const onCheckpoint=input.onCheckpoint?async(checkpoint:ReviewCheckpoint)=>{
      await active();
      const screenshotIds=new Set(checkpoint.item.screenshotIds);
      await input.onCheckpoint!({...checkpoint,artifacts:artifacts.filter(artifact=>screenshotIds.has(artifact.id))});
      await active();
    }:undefined;
    const modelPath=()=>runReviewer({binding,sessionId:input.sessionId,handoff:input.handoff,browser,files,bootstrap:true,
      modelConfig:input.modelConfig,signal,tokenBudget:input.tokenBudget,maxToolCalls:input.maxToolCalls,
      onEvent:emitEvent,assertActive:active,onCheckpoint,saveScreenshot});
    // A layer: behaviors whose sealed plan carries executable steps and
    // script-decidable assertions are driven by the model-free kernel. Nothing
    // below this try is weakened — the model path is still the only reporter for
    // any behavior the plan did not compile, and it remains the release gate.
    let reviewed:Awaited<ReturnType<typeof runReviewer>>|undefined;
    try{
      const scripted=await runScriptedPlan({binding,handoff:input.handoff,browser,signal,
        saveScreenshot,onEvent:emitEvent,onCheckpoint});
      if(scripted.kind==='scripted')reviewed=scripted.result;
      else{
        // The fallback rate is the measured cost of unexecutable planning, so it
        // is reported both to the operator log and into the run's own event
        // stream. `replay_fallback` is deliberately not on the progress
        // allowlist: this event records a decision, not reviewer work, and must
        // not renew the inactivity lease by itself.
        const reasons=scripted.uncompilable.reduce<Record<string,number>>((counts,item)=>{
          counts[item.reason]=(counts[item.reason]??0)+1;return counts;},{});
        const behaviors=scripted.uncompilable.map(item=>`${item.behaviorId}:${item.reason}`).join(',');
        console.info(`[review] scripted replay fallback compiled=${scripted.compiled.length} uncompilable=${scripted.uncompilable.length} reasons=${JSON.stringify(reasons)}`);
        await input.onEvent?.({id:randomUUID(),at:new Date().toISOString(),type:'tool.output',toolName:'replay_fallback',
          message:`脚本回放退回模型路径：${scripted.compiled.length} 项已编译，${scripted.uncompilable.length} 项不可编译（${behaviors}）`});
      }
    }catch(error){
      // The four transport codes the model path already treats as a lost browser
      // are the only ones where falling back is honest: the scripted work is
      // re-done on the same page, rather than reporting a candidate failure for
      // an infrastructure fault. Everything else (a stale ref, a failed
      // assertion, a corrupt plan) is a real result and must travel as one.
      if(!(error instanceof RuntimeError&&['BROWSER_BLOCKED','BROWSER_TIMEOUT','COMMAND_TIMEOUT','BROWSER_SESSION_LOST'].includes(error.code)))throw error;
      console.info(`[review] scripted replay infrastructure fallback code=${error.code}`);
      await input.onEvent?.({id:randomUUID(),at:new Date().toISOString(),type:'tool.output',toolName:'replay_fallback',
        message:`脚本回放因浏览器基础设施故障退回模型路径（${error.code}）`});
    }
    if(!reviewed)reviewed=await modelPath();
    assertReviewerResult(reviewed);usage=reviewed.usage;evidence=reviewed.evidence;result=reviewed.result;
    await verifyVersion();markerVerified=true;
  }catch(error){
    if(leaseFailure)throw leaseFailure;
    if(input.signal.aborted)throw error;
    if(error instanceof RuntimeError && ['AGENT_OUTPUT_INVALID','TOKEN_BUDGET_EXCEEDED','TOOL_BUDGET_EXCEEDED','ROLE_NOT_ACTIVE','MODEL_FAILED','MODEL_REQUEST_TIMEOUT','REVIEW_TIMEOUT'].includes(error.code))throw error;
    if(error instanceof RuntimeError&&error.usage)usage=error.usage;
    // Declared once: the code classifies an infrastructure failure and also feeds
    // the redacted diagnostic below.
    const code=error instanceof RuntimeError?(error.diagnosticCode??error.code):undefined;
    if(reviewerStarted && error instanceof RuntimeError){
      const code=error.diagnosticCode??error.code;
      if(code==='BROWSER_BLOCKED'||code==='BROWSER_TIMEOUT'||code==='COMMAND_TIMEOUT'||code==='BROWSER_SESSION_LOST')
        recoverableInfrastructureCode=code==='BROWSER_SESSION_LOST'?'BROWSER_BLOCKED':code==='COMMAND_TIMEOUT'?'BROWSER_TIMEOUT':code;
    }
    const versionMismatch=error instanceof RuntimeError&&error.code==='CHECK_VERSION_MISMATCH';
    const reason=error instanceof RuntimeError?blockedReasons.get(error.code)??blockedReasons.get(error.diagnosticCode??''):undefined;
    if(!reason&&!versionMismatch){
      // An unclassified code must not reach the user: it can itself carry raw
      // provider data, which review.test.ts pins with a deliberately hostile code.
      // It must not be logged verbatim for the same reason, so the diagnostic is a
      // fingerprint that lets repeats be correlated without revealing the code. It
      // is also the only record that this failure happened at all, because this
      // path previously left no trace anywhere.
      const fingerprint=code===undefined?'none':createHash('sha256').update(code).digest('hex').slice(0,12);
      console.error(`[review] unclassified failure code=${fingerprint} length=${code?.length??0} reviewerStarted=${reviewerStarted}`);
    }
    const message=versionMismatch?'候选源码或预览版本不一致，未接受检查结果。':reason??'浏览器或检查过程未完成，当前候选尚未通过检查。';
    result={revisionId:binding.revisionId,sourceHash:binding.sourceHash,summary:message,items:input.handoff.plan.behaviors.map(behavior=>({
      behaviorId:behavior.id,verdict:'blocked' as const,expected:behavior.expected,actual:message,observationEventIds:[],screenshotIds:[],reproSteps:[],
    }))};
  }finally{
    if(connected){
      const closed=await browser.close().catch(()=>({confirmed:false}));
      await workspace.releaseClient(handle).catch(()=>{});
      if(!closed.confirmed)throw new RuntimeError('CHECK_BLOCKED','检查会话关闭尚未确认',undefined,usage);
    }
  }
  input.signal.throwIfAborted();await input.assertActive();input.signal.throwIfAborted();
  const receipt:VerifiedReviewReceipt=freeze({binding,source:input.source,result:result!,artifacts,evidence,markerVerified,chromeClosed:true,
    ...(recoverableInfrastructureCode?{recoverableInfrastructureCode}:{})});
  receipts.add(receipt);
  return {receipt,usage};
}
