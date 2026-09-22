import { z } from 'zod';
import { ReviewBindingSchema, type ReviewBinding, type ReviewResult, type Handoff } from '@pivloom/contracts';
import { OpenSandboxWorkspace, type SandboxConnector } from '../runtime/workspace.js';
import { RemoteBrowser } from '../runtime/browser.js';
import { sourceHash } from '../runtime/generation.js';
import { runReviewer, assertReviewerResult, REVIEW_ATTEMPT_TIMEOUT_MS, type ReviewObservationEvent } from '../runtime/reviewer.js';
import { RuntimeError, type ModelConfig, type SandboxConfig, type ProbeEventSink } from '../runtime/types.js';
import { type TokenUsage, type RunTokenBudget } from '../runtime/token-budget.js';
import { assertVerifiedSourceSnapshot, type SourceStore, type VerifiedSourceSnapshot } from '../storage/source.js';
import type { ArtifactStore, StoredArtifact } from '../storage/artifacts.js';

export interface VerifiedReviewReceipt {
  binding: ReviewBinding; source: VerifiedSourceSnapshot; result: ReviewResult;
  artifacts: StoredArtifact[]; evidence: ReviewObservationEvent[];
  markerVerified: boolean; chromeClosed: true;
}
const receipts=new WeakSet<object>();
const blockedReasons=new Map([
  ['FORM_TARGET_CHANGED','表单控件发生变化或无法唯一定位，已停止后续操作，当前候选尚未通过检查。'],
  ['INVALID_BROWSER_ACTION','浏览器无法执行受控操作，已停止后续操作，当前候选尚未通过检查。'],
  ['BROWSER_TIMEOUT','浏览器操作超时，已停止后续操作，当前候选尚未通过检查。'],
  ['COMMAND_TIMEOUT','浏览器操作超时，已停止后续操作，当前候选尚未通过检查。'],
  ['BROWSER_ORIGIN_REJECTED','浏览器离开了绑定的候选预览，已停止检查。'],
  ['BROWSER_BLOCKED','浏览器无法访问或完成页面操作，当前候选尚未通过检查。'],
]);
export function assertVerifiedReviewReceipt(receipt:VerifiedReviewReceipt){
  if(!receipts.has(receipt))throw new RuntimeError('INVALID_REVIEW_RECEIPT','检查结果未经版本和浏览器证据校验');
  assertVerifiedSourceSnapshot(receipt.source);
}
export interface ReviewInput {
  binding:ReviewBinding;sessionId:string;handoff:Handoff;expiresAt:string;
  source:VerifiedSourceSnapshot;sources:SourceStore;artifacts:ArtifactStore;
  sandboxConfig:SandboxConfig;modelConfig:ModelConfig;signal:AbortSignal;
  tokenBudget?:RunTokenBudget;maxToolCalls?:number;onEvent?:ProbeEventSink;assertActive():Promise<void>;
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
  const handle={sandboxId:binding.sandboxId,expiresAt:input.expiresAt};
  const browser=new RemoteBrowser(workspace,handle,undefined,binding.browserSessionId);
  const deadline=new AbortController(), signal=AbortSignal.any([input.signal,deadline.signal]);
  const timer=setTimeout(()=>deadline.abort("REVIEW_TIMEOUT"),REVIEW_ATTEMPT_TIMEOUT_MS);
  const artifacts:StoredArtifact[]=[];
  let markerVerified=false,connected=false,usage:TokenUsage|undefined;
  let evidence:ReviewObservationEvent[]=[],result:ReviewResult|undefined;
  const active=async()=>{signal.throwIfAborted();await input.assertActive();signal.throwIfAborted();};
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
    await verifyVersion();
    const files=(await input.sources.load(input.source)).files;
    const reviewed=await runReviewer({binding,sessionId:input.sessionId,handoff:input.handoff,browser,files,
      modelConfig:input.modelConfig,signal,tokenBudget:input.tokenBudget,maxToolCalls:input.maxToolCalls,
      onEvent:input.onEvent,assertActive:active,
      async saveScreenshot(image){
        await active();const artifact=await input.artifacts.save(input.source,image,signal);await active();artifacts.push(artifact);
        return {id:artifact.id,mimeType:artifact.mimeType,sha256:artifact.sha256};
      }});
    assertReviewerResult(reviewed);usage=reviewed.usage;evidence=reviewed.evidence;result=reviewed.result;
    await verifyVersion();markerVerified=true;
  }catch(error){
    if(input.signal.aborted)throw error;
    if(error instanceof RuntimeError && ['AGENT_OUTPUT_INVALID','TOKEN_BUDGET_EXCEEDED','TOOL_BUDGET_EXCEEDED','ROLE_NOT_ACTIVE','MODEL_FAILED','MODEL_REQUEST_TIMEOUT'].includes(error.code))throw error;
    if(error instanceof RuntimeError&&error.usage)usage=error.usage;
    const versionMismatch=error instanceof RuntimeError&&error.code==='CHECK_VERSION_MISMATCH';
    const reason=error instanceof RuntimeError?blockedReasons.get(error.diagnosticCode??''):undefined;
    const message=versionMismatch?'候选源码或预览版本不一致，未接受检查结果。':deadline.signal.aborted?`检查超过本轮 ${Math.round(REVIEW_ATTEMPT_TIMEOUT_MS/60000)} 分钟时限，候选尚未通过检查。`:reason??'浏览器或检查过程未完成，当前候选尚未通过检查。';
    result={revisionId:binding.revisionId,sourceHash:binding.sourceHash,summary:message,items:input.handoff.plan.behaviors.map(behavior=>({
      behaviorId:behavior.id,verdict:'blocked' as const,expected:behavior.expected,actual:message,observationEventIds:[],screenshotIds:[],reproSteps:[],
    }))};
  }finally{
    clearTimeout(timer);
    if(connected){
      const closed=await browser.close().catch(()=>({confirmed:false}));
      await workspace.releaseClient(handle).catch(()=>{});
      if(!closed.confirmed)throw new RuntimeError('CHECK_BLOCKED','检查会话关闭尚未确认',undefined,usage);
    }
  }
  input.signal.throwIfAborted();await input.assertActive();input.signal.throwIfAborted();
  const receipt:VerifiedReviewReceipt=freeze({binding,source:input.source,result:result!,artifacts,evidence,markerVerified,chromeClosed:true});
  receipts.add(receipt);
  return {receipt,usage};
}
