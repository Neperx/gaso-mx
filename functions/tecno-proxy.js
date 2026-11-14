import tecno from "../lib/tecno-handler.js";

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;
  return tecno(request, env);
}