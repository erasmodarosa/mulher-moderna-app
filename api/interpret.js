/* Fallback de IA de verdade (Claude Haiku), só chamado quando o parser
   local (app.js) não reconhece o comando. Mantém o custo baixo:
   - modelo pequeno (Haiku)
   - prompt curto e sempre igual -> prompt caching reduz o custo do input
   - max_tokens pequeno, resposta sempre em JSON compacto
   A chave da API fica só aqui no servidor (variável de ambiente
   ANTHROPIC_API_KEY), nunca é exposta ao navegador. */

const SYSTEM_PROMPT = `Você é o motor de interpretação de voz do app "Mulher Moderna", uma secretária doméstica por voz.
O usuário fala uma frase em português (às vezes informal, com gírias, frases incompletas, ou VÁRIAS tarefas diferentes na mesma frase) e você deve extrair a(s) intenção(ões) e devolver APENAS um JSON ARRAY, sem nenhum texto antes ou depois -- um item no array para CADA tarefa distinta mencionada, mesmo que a frase tenha só uma. Cada item segue um dos formatos abaixo:

{"type":"lista_add","items":["item1","item2"]}
{"type":"lista_marcar","item":"nome do item"}
{"type":"remedio_add","child":"Nome","time":"HH:MM"}
{"type":"remedio_confirmar","child":"Nome"}
{"type":"compromisso_add","title":"Título curto","dateLabel":"hoje|amanhã|dia N","time":"HH:MM"}
{"type":"desconhecido","reply":"uma frase curta e simpática em português pedindo pra repetir de outro jeito"}

Regras:
- Se a frase menciona várias tarefas (ex: "trocar o pneu, pagar um boleto e ir à reunião às 14h"), devolva um array com um objeto por tarefa -- NUNCA misture várias tarefas em um só objeto.
- Cada tarefa usa só o horário/data que foi dito especificamente para ELA, nunca reaproveita o horário de outra tarefa da mesma frase. Compromisso ou remédio sem horário nenhum dito não deve virar "compromisso_add"/"remedio_add" -- classifique como "desconhecido" pedindo o horário, ou ignore se for algo como "pagar um boleto" sem lista/remédio/compromisso claro (nesse caso vire "desconhecido" com reply pedindo mais detalhe, não invente).
- "type":"desconhecido" só quando aquela tarefa específica realmente não tiver nenhuma das 5 intenções acima ou faltar informação essencial (ex: horário).
- Nomes de criança: capitalize a primeira letra.
- Horários: sempre formato 24h "HH:MM".
- Nunca invente item, nome ou horário que não foi dito.
- Responda só o JSON array, nunca markdown, nunca explicação. Exemplo de resposta para frase com 2 tarefas: [{"type":"lista_add","items":["arroz"]},{"type":"compromisso_add","title":"Dentista","dateLabel":"amanhã","time":"10:00"}]`;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "missing_api_key" });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const text = (body && body.text ? String(body.text) : "").slice(0, 300);
  if (!text) return res.status(400).json({ error: "missing_text" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: "anthropic_error", detail: errText.slice(0, 300) });
    }

    const data = await r.json();
    const raw = (data.content && data.content[0] && data.content[0].text) || "";
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const fallback = [{ type: "desconhecido", reply: "Não entendi bem, pode falar de outro jeito?" }];
    if (!jsonMatch) return res.status(200).json(fallback);

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(200).json(fallback);
    }
    if (!Array.isArray(parsed)) parsed = [parsed];
    return res.status(200).json(parsed.length ? parsed : fallback);
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e).slice(0, 200) });
  }
};
