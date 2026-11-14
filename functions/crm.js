import crm from "../lib/crm-handler.js";

export async function onRequestGet(context) {
  return crm(context.request, context.env);
}

export async function onRequestPost(context) {
  return crm(context.request, context.env);
}
