// Временный Worker пробы: принимает {model, messages, max_tokens}, зовёт Workers AI, возвращает ответ и время.
export default {
  async fetch(req: Request, env: { AI: { run: (m: string, i: unknown) => Promise<unknown> } }): Promise<Response> {
    const { model, messages, max_tokens, temperature, extra } = (await req.json()) as any;
    const t0 = Date.now();
    try {
      const out = await env.AI.run(model, { messages, max_tokens: max_tokens ?? 200, temperature: temperature ?? 0.7, ...(extra ?? {}) });
      return Response.json({ ok: true, ms: Date.now() - t0, out });
    } catch (e) {
      return Response.json({ ok: false, ms: Date.now() - t0, error: String(e) });
    }
  },
};
