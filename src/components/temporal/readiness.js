// BUG-250 / FEAT-19.14 / FEAT-19.16: why a definition cannot run on this portal.
// Shared by the editor «Готовность» panel, the version list and the start form.
import { t } from "../../lib/i18n.js";
const LABELS=new Set(["model","approval","timer","condition","parallel","artifact"]);
export const RUNNABLE_TYPES=["model","approval","timer","parallel","condition","artifact"];
export function unsupportedReasons(definition,subscriptionModels){
  const out=[];
  for(const s of definition.steps??[]){
    const name=t("temporal.quote",{text:s.name||s.id});
    if(!RUNNABLE_TYPES.includes(s.type))out.push(t("temporal.ready.notRunnable",{name,type:LABELS.has(s.type)?t("temporal.type."+s.type):s.type}));
    else if(s.when)out.push(t("temporal.ready.oldWhen",{name}));
    else if(Object.keys(s.mapping??{}).length)out.push(t("temporal.ready.oldMapping",{name}));
    else if(s.type==="condition"&&!s.check)out.push(t("temporal.ready.noCheck",{name}));
    else if(s.type==="parallel"&&s.join!=="all-success")out.push(t("temporal.ready.joinAll",{name}));
    else if(s.type==="model"&&subscriptionModels&&!subscriptionModels[s.engine]?.includes(s.model))out.push(t("temporal.ready.noModel",{name}));
  }
  return out;
}
