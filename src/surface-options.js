// Remote callers supply data; only the server operator enables experimental features.
import { own, object, requireAt } from './common.js';
import { validateJevOptions } from './typesafe-request.js';
export const assetInputSchema = {
  type:'object',additionalProperties:{type:'object',properties:{type:{type:'string',const:'image'},format:{type:'string',enum:['png','jpg','jpeg']},data_base64:{type:'string'}},required:['format','data_base64'],additionalProperties:false},
};
export function surfaceOptions(policy, request, permissions = {}) {
  for(const key of ['headers','apiKey','baseUrl','model','provider','compression','typesafe'])requireAt(!own(request,key),`request.${key}`,'upstream controls are configured by the server operator',undefined,'state');
  const allowed={...policy.policy.typesafe?.experimental,...permissions};
  const requested=request.experimental??{};
  validateJevOptions({experimental:requested});
  for(const [k,v] of Object.entries(requested))requireAt(!v||allowed[k]===true,`experimental.${k}`,'experimental feature is disabled by the server operator',undefined,'state');
  requireAt(!request.assets||allowed.images===true,'assets','image uploads are disabled by the server operator',undefined,'state');
  const options={};
  if(request.assets) {requireAt(object(request.assets),'assets','expected asset map',undefined,'state');options.assets=request.assets;}
  if(Object.keys(allowed).length||Object.keys(requested).length)options.experimental={...allowed,...requested};
  return options;
}
