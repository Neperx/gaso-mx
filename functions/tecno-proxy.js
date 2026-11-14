import tecno from "../lib/tecno-handler.js";

export async function onRequestGet(context) {
  return tecno(context.request, context.env);
}

export async function onRequestPost(context) {
  return tecno(context.request, context.env);
}
