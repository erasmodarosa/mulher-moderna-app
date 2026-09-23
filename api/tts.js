/* Voz em nuvem (Google Cloud TTS, camada WaveNet) -- só usada para as
   respostas faladas gerais do app. Os alarmes de remédio continuam usando a
   voz nativa do celular (offline, sem custo, sem dependência de rede),
   conforme decidido na análise de custo/risco do plano. */

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "missing_api_key" });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const text = (body && body.text ? String(body.text) : "").slice(0, 500);
  const voiceName = (body && body.voice) || "pt-BR-Wavenet-A";
  if (!text) return res.status(400).json({ error: "missing_text" });

  try {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "pt-BR", name: voiceName },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.02 },
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: "google_tts_error", detail: errText.slice(0, 300) });
    }

    const data = await r.json();
    return res.status(200).json({ audioContent: data.audioContent });
  } catch (e) {
    return res.status(500).json({ error: "server_error", detail: String(e).slice(0, 200) });
  }
};
