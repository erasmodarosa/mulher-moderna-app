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
{"type":"remedio_tratamento","child":"Nome","medName":"Nome do remédio","time":"HH:MM","dateLabel":"hoje|amanhã|dia N","intervalHours":N,"days":D}
{"type":"remedio_confirmar","child":"Nome"}
{"type":"compromisso_add","title":"Título curto","dateLabel":"hoje|amanhã|dia N","time":"HH:MM"}
{"type":"desconhecido","reply":"uma frase curta e simpática em português pedindo pra repetir de outro jeito, ou o que falta"}

Regras:
- Se a frase menciona várias tarefas (ex: "trocar o pneu, pagar um boleto e ir à reunião às 14h"), devolva um array com um objeto por tarefa -- NUNCA misture várias tarefas em um só objeto.
- Cada tarefa usa só o horário/data que foi dito especificamente para ELA, nunca reaproveita o horário de outra tarefa da mesma frase.
- Assim que uma atividade tiver um TÍTULO e um HORÁRIO (mesmo que pareça uma tarefa doméstica comum, tipo "trocar o pneu às 15h"), classifique direto como "compromisso_add" -- decida sozinho, NUNCA pergunte de volta "isso é um compromisso?" ou "quer que eu agende?". Se não vier nenhuma data, use "dateLabel":"hoje".
- REMÉDIO é sempre um "remedio_tratamento" (nunca um lembrete avulso) e SÓ deve ser criado quando você já souber TODOS os 5 dados: nome da criança, nome do remédio, horário da primeira dose, de quantas em quantas horas (intervalHours) e por quantos dias (days). A mensagem do usuário pode conter várias falas suas separadas por ponto final, cada uma respondendo a uma pergunta sua anterior -- junte tudo que já foi dito até aqui. Se AINDA faltar algum dado, devolva "desconhecido" perguntando SÓ UM dado de cada vez (nunca duas coisas na mesma pergunta), nesta ordem de prioridade: 1º nome do remédio, 2º horário da primeira dose, 3º de quantas em quantas horas, 4º por quantos dias. Pergunta curta e direta, ex: "Qual o nome do remédio?" ou "De quantas em quantas horas ela deve tomar?". Se não disser a data da primeira dose, assuma "hoje" (não precisa perguntar isso).
- "type":"desconhecido" também quando faltar informação de qualquer outra tarefa (o mais comum: falta o horário de um compromisso) -- pergunte só o que falta, direto.
- "pagar um boleto" ou tarefa sem lista/remédio/compromisso/horário claro: "desconhecido" pedindo mais detalhe, sem inventar.
- Nomes de criança e de remédio: capitalize a primeira letra.
- Horários: sempre formato 24h "HH:MM". intervalHours e days: sempre números inteiros.
- Nunca invente item, nome, remédio, intervalo, duração ou horário que não foi dito.
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
