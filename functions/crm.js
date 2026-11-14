import crm from "../lib/crm-handler.js";

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;
  return crm(request, env);
}