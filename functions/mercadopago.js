import mercadopagoHandler from "../lib/mercadopago-handler.js";

export async function onRequestGet(context) {
  return mercadopagoHandler(context.request, context.env);
}

export async function onRequestPost(context) {
  return mercadopagoHandler(context.request, context.env);
}
