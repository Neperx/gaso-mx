/** Cron diario 15:00 CDMX: dispara /catalog-cron (FX + Syscom + Tecnosinergia). */
export default {
  async scheduled(event, env, ctx) {
    const base = String(env.GASO_BASE_URL || "https://gaso-mx.pages.dev").replace(/\/$/, "");
    const secret = env.CRON_SECRET || "";
    if (!secret) {
      console.error("CRON_SECRET ausente en el worker scheduler");
      return;
    }
    ctx.waitUntil((async () => {
      const r = await fetch(base + "/catalog-cron?async=1", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json"
        },
        body: "{}"
      });
      const text = await r.text();
      console.log("catalog-cron", r.status, text.slice(0, 300));
    })());
  }
};
