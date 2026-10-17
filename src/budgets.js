import { requireAt, own } from './common.js';
// Conservative decimal ceilings; upstream documentation publishes rounded k values.
export const modelLimits = experimental => experimental?.longContext ? {question:262000,request:262000} : {question:32000,request:64000};
const size = value => [...JSON.stringify(value)].length;
export function checkRequestBudget(state,questions={},options={}) {
  const limits=modelLimits(options.experimental);
  const questionLimit=own(options,'tokenLimit')&&options.tokenLimit!==null?Math.min(options.tokenLimit,limits.question):limits.question;
  const requestLimit=own(options,'requestTokenLimit')&&options.requestTokenLimit!==null?Math.min(options.requestTokenLimit,limits.request):limits.request;
  const stateChars=size(state);
  const longest=Math.max(0,...Object.values(questions).map(size));
  const perQuestion=Math.ceil((stateChars+longest)/4),perRequest=Math.ceil((stateChars+size(questions))/4);
  requireAt(perQuestion<=questionLimit,'state','state plus one question is about '+perQuestion+' tokens, above the '+questionLimit+' per-question limit (~4 chars/token, rough estimate)','Cap the state or explicitly enable long context.','state');
  requireAt(perRequest<=requestLimit,'questions','whole request is about '+perRequest+' tokens, above the '+requestLimit+' per-request limit (~4 chars/token, rough estimate)','Send fewer questions or explicitly enable long context.','state');
  return {perQuestion,perRequest,limits:{question:questionLimit,request:requestLimit}};
}
