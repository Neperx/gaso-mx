import vaultHandler from "../lib/vault-handler.js";

export async function onRequestGet(context) {
  return vaultHandler(context.request, context.env);
}

export async function onRequestPost(context) {
  return vaultHandler(context.request, context.env);
}
