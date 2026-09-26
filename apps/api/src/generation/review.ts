import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ReviewBindingSchema, MAX_CHECK_ARTIFACTS, type ReviewBinding, type ReviewResult, type Handoff } from '@pivloom/contracts';
import { OpenSandboxWorkspace, type SandboxConnector } from '../runtime/workspace.js';
import { RemoteBrowser } from '../runtime/browser.js';
import { sourceHash } from '../runtime/generation.js';
import { runReviewer, assertReviewerResult, type ReviewObservationEvent, type ReviewCheckpoint } from '../runtime/reviewer.js';
import { runScriptedPlan, type RunScriptedPlanInput } from '../runtime/replay-plan.js';
import { preflightCapacity } from '../runtime/capacity.js';
import { admitVerification } from '../runtime/verification-admission.js';
import { createVisualJudgePort } from '../runtime/visual-judge-request.js';
import { RuntimeError, type ModelConfig, type SandboxConfig, type ProbeEventSink, type ProbeEvent } from '../runtime/types.js';
import { SANDBOX_LEASE_RENEW_THRESHOLD_MS, SANDBOX_LEASE_SEGMENT_MS, VERIFICATION_WALL_CLOCK_LIMIT_MS, REVIEW_FINALIZATION_RESERVE_MS } from '../runtime/budgets.js';
import { type TokenUsage, type RunTokenBudget } from '../runtime/token-budget.js';
import { assertVerifiedSourceSnapshot, type SourceStore, type VerifiedSourceSnapshot } from '../storage/source.js';
import type { ArtifactStore, StoredArtifact } from '../storage/artifacts.js';

export interface VerifiedReviewReceipt {
  binding: ReviewBinding; source: VerifiedSourceSnapshot; result: ReviewResult;
  artifacts: StoredArtifact[]; evidence: ReviewObservationEvent[];
  markerVerified: boolean; chromeClosed: true;
  /** Internal, allowlisted browser transport failure. Never inferred from a blocked business verdict. */
  recoverableInfrastructureCode?: 'BROWSER_BLOCKED' | 'BROWSER_TIMEOUT';
  verification?: { startedAt: string; deadlineAt: string; elapsedMs: number; timedOut: boolean; incompleteReason?: string; phasesMs?: { preparation?: number; execution?: number; finalization?: number; persistence?: number } };
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
export async function runReview(input:ReviewInput,boundaries:{sandboxConnector?:SandboxConnector;previewFetch?:typeof fetch;monotonicNow?:()=>number}={}):Promise<{receipt:VerifiedReviewReceipt;usage?:TokenUsage}>{
  const now=boundaries.monotonicNow??(()=>performance.now()),startedAt=now(),startedAtWall=Date.now();
  const deadlineAt=startedAt+VERIFICATION_WALL_CLOCK_LIMIT_MS;
  const workDeadlineAt=deadlineAt-REVIEW_FINALIZATION_RESERVE_MS;
  let preparationCompletedAt:number|undefined,executionCompletedAt:number|undefined,finishing=false;
  const binding=ReviewBindingSchema.parse(input.binding);
  assertVerifiedSourceSnapshot(input.source);
  if(input.source.revisionId!==binding.revisionId||input.source.sourceHash!==binding.sourceHash)
    throw new RuntimeError('INVALID_REVIEW_RECEIPT','检查源码与候选版本不一致');
  const workspace=new OpenSandboxWorkspace(input.sandboxConfig,boundaries.sandboxConnector);
  let handle={sandboxId:binding.sandboxId,expiresAt:input.expiresAt};
  const leaseAbort=new AbortController(),workAbort=new AbortController(),deadlineAbort=new AbortController();
  const finalSignal=AbortSignal.any([input.signal,leaseAbort.signal,deadlineAbort.signal]);
  const signal=AbortSignal.any([finalSignal,workAbort.signal]);
  const browser=new RemoteBrowser(workspace,handle,undefined,binding.browserSessionId,signal,input.sandboxConfig.browserPrograms===true);
  const expire=()=>{
    if(!finishing&&now()>=workDeadlineAt&&!workAbort.signal.aborted)workAbort.abort('REVIEW_TIMEOUT');
    if(now()>=deadlineAt&&!deadlineAbort.signal.aborted)deadlineAbort.abort(new RuntimeError('REVIEW_TIMEOUT','验收收尾超过统一墙钟上限'));
  };
  const workTimer=setTimeout(()=>workAbort.abort('REVIEW_TIMEOUT'),Math.max(0,workDeadlineAt-now()));
  const deadlineTimer=setTimeout(()=>deadlineAbort.abort(new RuntimeError('REVIEW_TIMEOUT','验收收尾超过统一墙钟上限')),Math.max(0,deadlineAt-now()));
  workTimer.unref?.();deadlineTimer.unref?.();
  const artifacts:StoredArtifact[]=[];
  let markerVerified=false,connected=false,reviewerStarted=false,usage:TokenUsage|undefined,leaseFailure:RuntimeError|undefined;
  let recoverableInfrastructureCode:VerifiedReviewReceipt['recoverableInfrastructureCode'];
  let incompleteReason:string|undefined;
  let evidence:ReviewObservationEvent[]=[],result:ReviewResult|undefined;
  async function bounded<T>(operation:()=>Promise<T>,scopeSignal=signal):Promise<T>{
    expire();scopeSignal.throwIfAborted();
    let abort:()=>void=()=>{};
    const stopped=new Promise<never>((_resolve,reject)=>{
      abort=()=>reject(scopeSignal.reason);
      scopeSignal.addEventListener('abort',abort,{once:true});
    });
    try{return await Promise.race([operation(),stopped]);}
    finally{scopeSignal.removeEventListener('abort',abort);}
  }
  const active=async()=>{await bounded(input.assertActive);expire();signal.throwIfAborted();};
  const finalActive=async()=>{await bounded(input.assertActive,finalSignal);expire();finalSignal.throwIfAborted();};
  async function ensureLease(force=false){
    if(!force&&Date.parse(handle.expiresAt)-Date.now()>SANDBOX_LEASE_RENEW_THRESHOLD_MS)return;
    try{
      const renewed=await bounded(()=>workspace.renewLease(handle,SANDBOX_LEASE_SEGMENT_MS,finalSignal),finalSignal);
      await bounded(()=>input.onLeaseRenewed(renewed.expiresAt),finalSignal);
      handle=renewed;
    }catch(error){
      if(finalSignal.aborted)throw error;
      leaseFailure=new RuntimeError('SANDBOX_LEASE_RENEW_FAILED','检查沙箱续租未确认，已停止并清理本轮任务');
      leaseAbort.abort(leaseFailure);
      throw leaseFailure;
    }
  }
  async function verifyVersion(finalizing=false){
    const check=finalizing?finalActive:active,scopeSignal=finalizing?finalSignal:signal;
    await check();
    await bounded(()=>input.sources.verify(input.source),scopeSignal);
    scopeSignal.throwIfAborted();
    if(sourceHash(await bounded(()=>workspace.listSourceFiles(handle,{signal:scopeSignal}),scopeSignal))!==binding.sourceHash)
      throw new RuntimeError('CHECK_VERSION_MISMATCH','检查前后源码版本发生变化');
    scopeSignal.throwIfAborted();
    const endpoint=await bounded(()=>workspace.endpoint(handle,4173),scopeSignal);
    scopeSignal.throwIfAborted();
    const markerSignal=AbortSignal.any([scopeSignal,AbortSignal.timeout(5000)]);
    const response=await bounded(()=>(boundaries.previewFetch??fetch)(endpoint.url+'/pivloom-revision.json',{
      headers:endpoint.headers,redirect:'error',signal:markerSignal}),markerSignal);
    const body=await bounded(()=>response.text(),markerSignal);
    if(!response.ok||Buffer.byteLength(body)>4096)throw new RuntimeError('CHECK_BLOCKED','无法验证候选预览');
    const marker=z.strictObject({revisionId:z.uuid(),sourceHash:z.string()}).parse(JSON.parse(body));
    if(marker.revisionId!==binding.revisionId||marker.sourceHash!==binding.sourceHash)throw new RuntimeError('CHECK_VERSION_MISMATCH','预览标记不匹配当前候选');
    await check();
  }
  try{
    const admission=admitVerification(input.handoff.plan,{remainingMs:Math.max(0,workDeadlineAt-now())});
    await bounded(async()=>input.onEvent?.({id:randomUUID(),at:new Date().toISOString(),type:'tool.output',toolName:'verification_admission',
      message:`脚本检查准入：${admission.stats.behaviors} 项行为，${admission.stats.steps} 步，${admission.stats.expandedKeys} 次按键，显式等待 ${admission.stats.explicitWaitMs}ms；${admission.invalidPrograms.length} 项程序需进一步处理。准入不代表通过。`}));
    if(admission.budgetExceeded.length){
      incompleteReason='VERIFICATION_CAPACITY';
      throw new RuntimeError('VERIFICATION_CAPACITY',`未执行检查：${admission.budgetExceeded.map(item=>`${item.resource} 需要 ${item.required}，剩余上限 ${item.limit}`).join('；')}`);
    }
    await active();await bounded(()=>workspace.connect(handle));connected=true;
    await ensureLease(true);
    await verifyVersion();
    const files=(await bounded(()=>input.sources.load(input.source))).files;
    reviewerStarted=true;preparationCompletedAt=now();
    // Every event either layer emits has to walk the sandbox lease first: a
    // scripted pass performs no model request, so this is the only place that
    // notices the preview lease is close to expiry while the browser works.
    const emitEvent=async(event:ProbeEvent)=>{await ensureLease();await bounded(async()=>input.onEvent?.(event),finalSignal);expire();};
    const saveScreenshot=async(image:{base64:string;mimeType:'image/png';sha256:string})=>{
      if(artifacts.length>=MAX_CHECK_ARTIFACTS)throw new RuntimeError('REVIEW_ARTIFACT_LIMIT','本次截图达到容量上限，此前检查证据已保留');
      await active();const artifact=await bounded(()=>input.artifacts.save(input.source,image,signal));await active();artifacts.push(artifact);
      return artifact;
    };
    const onCheckpoint=input.onCheckpoint?async(checkpoint:ReviewCheckpoint)=>{
      await finalActive();
      const screenshotIds=new Set(checkpoint.item.screenshotIds);
      await bounded(()=>input.onCheckpoint!({...checkpoint,artifacts:artifacts.filter(artifact=>screenshotIds.has(artifact.id))}),finalSignal);
      await finalActive();
    }:undefined;
    const modelPath=()=>runReviewer({binding,sessionId:input.sessionId,handoff:input.handoff,browser,files,bootstrap:true,
      modelConfig:input.modelConfig,signal,tokenBudget:input.tokenBudget,maxToolCalls:input.maxToolCalls,
      onEvent:emitEvent,assertActive:active,onCheckpoint,saveScreenshot,monotonicNow:now,deadlineAt:workDeadlineAt,
      preservePartialOnTimeout:true,preservePartialOnFailure:true});
    // Capacity pre-flight, in shadow mode: it compares this plan's envelope against the limits that
    // will bound the run and reports what it would do, without changing a limit or stopping anything.
    // Wiring it here is what makes those numbers visible on real plans before any of it is enforced.
    const capacity=preflightCapacity(input.handoff.plan.behaviors.length);
    if(capacity.verdict!=='ok'||capacity.near.length>0)console.info(`[review] capacity ${capacity.verdict} for ${capacity.behaviours} behaviors: ${capacity.findings.length} over limit, ${capacity.near.length} near limit`);
    // A layer: behaviors whose sealed plan carries executable steps and
    // script-decidable assertions are driven by the model-free kernel. Nothing
    // below this try is weakened — the model path stays the release gate, and a behavior the plan did
    // not compile is settled by the scripted layer itself: recorded `blocked`, or judged from captured
    // pixels by the appearance layer. Neither can turn an uncompiled behavior into a pass.
    let reviewed:Awaited<ReturnType<typeof runReviewer>>|undefined;
    // A model whose image capability did not pass the platform's vision probe must not be asked to
    // judge pixels. It cannot see them, and the judge accepts any citation that is not a restatement
    // of the expectation, so a blind guess would be admitted as a pass — the exact failure the probe
    // exists to prevent. With no port an uncompiled appearance behaviour is recorded blocked like any
    // other uncompiled behaviour, and when the whole plan is appearance the model path takes over.
    const controlPort=createVisualJudgePort(input.modelConfig,signal,{tokenBudget:input.tokenBudget,deadlineAt:workDeadlineAt,now});
    const visualJudge=input.modelConfig.supportsImages===true?controlPort:undefined;
    // Resolution against the page as it stands, rather than against the name the plan predicted before the
    // page existed. It is deliberately not gated on vision: choosing a control from a list of roles and
    // names is a text task, and a model that cannot see can still answer it - which is why it builds its own
    // port instead of reusing the judge's.
    //
    // Asked only when a step does not resolve to exactly one match, and its answer is taken only if it names
    // a control the observation carries. The kernel enforces that independently, so a wrong or invented
    // answer costs one step rather than becoming a click on something the reviewer never saw.
    const resolveControl:NonNullable<RunScriptedPlanInput['resolveControl']>=async({step,index,candidates})=>{
      if(candidates.length===0)return undefined;
      const answer=await controlPort.request(
        `Choose the control for one automated step on a web page.\n`
        +`The step's ${index+1}th action is "${step.type}" on a control with role ${JSON.stringify(step.role)} and name ${JSON.stringify(step.name)}.\n`
        +`The page currently offers these controls, one per line as ref, role, name:\n`
        +candidates.map((candidate)=>`${candidate.ref}\t${candidate.role??''}\t${JSON.stringify(candidate.name??'')}`).join('\n')
        +`\nReply with the ref of the single control that best matches the step, or NONE if none of them is the one intended. `
        +`Reply with the ref or NONE and nothing else.`,[]);
      const ref=/e[0-9]{1,6}/.exec(answer)?.[0];
      return ref&&candidates.some((candidate)=>candidate.ref===ref)?ref:undefined;
    };
    try{
      const scripted=await runScriptedPlan({binding,handoff:input.handoff,browser,signal,
        saveScreenshot,onEvent:emitEvent,onCheckpoint,
        // The appearance layer's one model call, built from the same configuration the review uses. It
        // is injected here so the replay and judgement modules keep holding no provider client, and it
        // sends no tools: the judge answers about the captured pixels and cannot drive the browser.
        visualJudge,resolveControl,deadlineAt:workDeadlineAt});
      if(scripted.kind==='scripted'){
        reviewed=scripted.result;
        reviewed.usage=controlPort.usage();
      }
      else{
        // This is reached only when nothing was deterministically available: no compiled program and no
        // behaviour the appearance layer could judge. A partially compilable plan no longer lands here —
        // its compiled verdicts are kept and the rest are recorded blocked or judged from pixels — so
        // this event marks the rare plan with no deterministic coverage at all rather than the cost of
        // one uncompilable behaviour. The fallback rate is reported both to the operator log and into
        // the run's own event stream. `replay_fallback` is deliberately not on the progress
        // allowlist: this event records a decision, not reviewer work, and must
        // not renew the inactivity lease by itself.
        const reasons=scripted.uncompilable.reduce<Record<string,number>>((counts,item)=>{
          counts[item.reason]=(counts[item.reason]??0)+1;return counts;},{});
        const behaviors=scripted.uncompilable.map(item=>`${item.behaviorId}:${item.reason}`).join(',');
        console.info(`[review] scripted replay fallback uncompilable=${scripted.uncompilable.length} reasons=${JSON.stringify(reasons)}`);
        await input.onEvent?.({id:randomUUID(),at:new Date().toISOString(),type:'tool.output',toolName:'replay_fallback',
          message:`脚本回放无任何可编译行为，退回模型路径：${scripted.uncompilable.length} 项不可编译（${behaviors}）`});
      }
    }catch(error){
      // The four transport codes the model path already treats as a lost browser
      // are the only ones where falling back is honest: the scripted work is
      // re-done on the same page, rather than reporting a candidate failure for
      // an infrastructure fault. Everything else (a stale ref, a failed
      // assertion, a corrupt plan) is a real result and must travel as one.
      // Record the code before it travels. A measured run aborted the entire replay after the first
      // behaviour and the stream said only that the check had not finished, so the cause was invisible
      // and three rounds went into guessing at it. This adds no decision: the same error is raised
      // either way, and the event is not progress, so it cannot keep a dead run alive. The emit is
      // best-effort because a failing listener must not replace the failure being reported.
      if(error instanceof RuntimeError){
        console.info(`[review] scripted replay failed code=${error.code} message=${error.message.slice(0,120)}`);
        try{
          await input.onEvent?.({id:randomUUID(),at:new Date().toISOString(),type:'tool.output',toolName:'replay_error',
            message:`脚本回放失败（${error.code}）：${error.message.slice(0,180)}`});
        }catch{/* a failing listener must not replace the failure being reported */}

      }
      if(!(error instanceof RuntimeError&&['BROWSER_BLOCKED','BROWSER_TIMEOUT','COMMAND_TIMEOUT','BROWSER_SESSION_LOST'].includes(error.code)))throw error;
      console.info(`[review] scripted replay infrastructure fallback code=${error.code}`);
      await input.onEvent?.({id:randomUUID(),at:new Date().toISOString(),type:'tool.output',toolName:'replay_fallback',
        message:`脚本回放因浏览器基础设施故障退回模型路径（${error.code}）`});
    }
    if(!reviewed)reviewed=await modelPath();
    assertReviewerResult(reviewed);usage=reviewed.usage;evidence=reviewed.evidence;result=reviewed.result;incompleteReason=reviewed.incompleteReason;
    executionCompletedAt=now();finishing=true;clearTimeout(workTimer);
    await verifyVersion(true);markerVerified=true;
  }catch(error){
    if(leaseFailure)throw leaseFailure;
    if(input.signal.aborted)throw error;
    const ownTimeout=workAbort.signal.aborted;
    if(ownTimeout){
      error=new RuntimeError('REVIEW_TIMEOUT','本次检查超过统一验收时间上限');
      incompleteReason='REVIEW_TIMEOUT';
    }
    if(error instanceof RuntimeError && ['AGENT_OUTPUT_INVALID','TOKEN_BUDGET_EXCEEDED','TOOL_BUDGET_EXCEEDED','ROLE_NOT_ACTIVE','MODEL_FAILED','MODEL_REQUEST_TIMEOUT','REVIEW_TIMEOUT'].includes(error.code)&&!ownTimeout)throw error;
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
    const message=code==='VERIFICATION_CAPACITY'&&error instanceof RuntimeError?error.message:versionMismatch?'候选源码或预览版本不一致，未接受检查结果。':reason??'浏览器或检查过程未完成，当前候选尚未通过检查。';
    result={revisionId:binding.revisionId,sourceHash:binding.sourceHash,summary:message,items:input.handoff.plan.behaviors.map(behavior=>({
      behaviorId:behavior.id,verdict:'blocked' as const,expected:behavior.expected,actual:message,observationEventIds:[],screenshotIds:[],reproSteps:[],
    }))};
  }finally{
    if(preparationCompletedAt!==undefined)executionCompletedAt??=now();
    finishing=true;clearTimeout(workTimer);
    try{
      if(connected){
        // Cancellation still closes Chrome; only the absolute cleanup deadline can end this wait.
        const closed=await bounded(()=>browser.close(),deadlineAbort.signal).catch(()=>({confirmed:false}));
        await bounded(()=>workspace.releaseClient(handle),deadlineAbort.signal).catch(()=>{});
        if(!closed.confirmed)throw new RuntimeError('CHECK_BLOCKED','检查会话关闭尚未确认',undefined,usage);
      }
    }finally{clearTimeout(workTimer);clearTimeout(deadlineTimer);}
  }
  await finalActive();
  usage={...(usage??{input:null,output:null,total:null,cachedTokens:null,modelCalls:0,toolCalls:0,source:'unreported' as const}),elapsedMs:Math.max(0,now()-startedAt)};
  const receipt:VerifiedReviewReceipt=freeze({binding,source:input.source,result:result!,artifacts,evidence,markerVerified,chromeClosed:true,
    verification:{startedAt:new Date(startedAtWall).toISOString(),deadlineAt:new Date(startedAtWall+VERIFICATION_WALL_CLOCK_LIMIT_MS).toISOString(),elapsedMs:usage.elapsedMs,timedOut:workAbort.signal.aborted,
      ...(incompleteReason?{incompleteReason}:{}),phasesMs:{
        preparation:Math.max(0,(preparationCompletedAt??now())-startedAt),
        ...(preparationCompletedAt===undefined?{}:{execution:Math.max(0,(executionCompletedAt??now())-preparationCompletedAt)}),
        ...(executionCompletedAt===undefined?{}:{finalization:Math.max(0,now()-executionCompletedAt)}),
      }},
    ...(recoverableInfrastructureCode?{recoverableInfrastructureCode}:{})});
  receipts.add(receipt);
  return {receipt,usage};
}
