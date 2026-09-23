/* ==========================================================================
   Mulher Moderna — protótipo funcional
   Arquitetura alinhada à análise de custo do plano:
   - STT/TTS: Web Speech API do navegador (equivalente a STT/TTS nativo do
     celular no app real) -> custo zero.
   - Parser local por regras (regex) cobre os 4 fluxos do MVP.
   - Quando o parser não entende, simulamos o fallback para um LLM barato
     (Claude Haiku) -- aqui é só uma resposta simulada, o ponto de integração
     real está marcado no código (callAIFallback).
   ========================================================================== */

/* Bump a cada publicação -- aparece no topo do app para confirmar que a
   versão nova entrou no ar (o service worker cacheia agressivamente, então
   sem isso não dá para saber se o celular já atualizou). */
const APP_VERSION = "3.1.0";
const BUILD_TIME = "2026-09-24 03:00";

const STORAGE_KEY = "mulher-moderna-data-v2";

const state = load() || {
  lista: [],
  tratamentos: [],
  compromissos: [],
};

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function uid() {
  return Math.random().toString(36).slice(2, 9);
}

/* ---------------------------- Categorização --------------------------- */
const CATEGORY_MAP = {
  mercado: ["arroz", "feijão", "leite", "pão", "ovo", "fralda", "carne", "fruta", "verdura", "café", "açúcar", "óleo"],
  farmácia: ["remédio", "antialérgico", "vitamina", "curativo", "álcool"],
  papelaria: ["caderno", "caneta", "lápis", "cola", "papel"],
};
function categorize(text) {
  const t = text.toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_MAP)) {
    if (words.some((w) => t.includes(w))) return cat;
  }
  return "geral";
}

/* ------------------------------ Parser local ---------------------------
   Cobre os 4 fluxos do MVP com regras determinísticas (custo zero).
   Retorna { type, ...dados } ou null se não reconhecer (cai no fallback).

   O parser é tolerante de propósito: fala real vem com palavras de sobra
   ("moderna", "por favor", "então"), então em vez de casar a frase toda
   (regex ancorada ^...$), procuramos o padrão em qualquer parte do texto
   já normalizado.
------------------------------------------------------------------------- */
function normalize(raw) {
  let t = raw.trim().toLowerCase();
  t = t.replace(/[.,!?]+$/g, "");
  // remove palavra de ativação e frases de cortesia que não carregam intenção
  t = t.replace(/^(ei|oi|olá|al[ôo])[, ]+moderna[, ]*/i, "");
  t = t.replace(/^moderna[, ]+/i, "");
  t = t.replace(/\bpor favor\b/gi, "");
  t = t.replace(/^(lembra(?:r)?(?: de| que)?|n[ãa]o (?:me )?deixa(?:r)? eu esquecer(?: de)?)\s+/i, "");
  t = t.replace(/^(pode|voc[êe] pode)\s+/i, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

function parseTime(text) {
  const m =
    text.match(/(?:[àa]s?|pras?|para\s+as?)\s*(\d{1,2})(?::(\d{2}))?\s*h(?:oras?)?\b/i) ||
    text.match(/(\d{1,2}):(\d{2})\b/) ||
    text.match(/(\d{1,2})\s*h(?:oras?)?\b/i);
  if (!m) return null;
  const hh = m[1].padStart(2, "0");
  const mm = (m[2] || "00").padStart(2, "0");
  return `${hh}:${mm}`;
}

function stripArticle(s) {
  return s.trim().replace(/^(o|a|os|as|um|uma)\s+/i, "").trim();
}

/* O parser local casa por posição (primeiro horário, primeiro "remédio de
   X" que encontra) -- ótimo pra frase com UMA tarefa, mas perigoso numa
   frase composta ("remédio da Sofia às 14h e reunião amanhã às 10h"): ele
   pegaria só o primeiro pedaço e IGNORARIA o resto, sem nunca cair na IA.
   Por isso, ao detectar sinais de mais de uma tarefa na mesma frase,
   devolvemos null de propósito para forçar o fallback de IA (que já lida
   com várias tarefas corretamente, ver api/interpret.js). */
function looksCompound(text) {
  const timeMatches = text.match(/(?:[àa]s?|pras?|para\s+as?)\s*\d{1,2}(?::\d{2})?\s*h(?:oras?)?\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*h(?:oras?)?\b/gi) || [];
  const remedioCount = (text.match(/rem[ée]dio/gi) || []).length;
  const dateWordCount = (text.match(/\b(hoje|amanh[ãa]|dia\s+\d{1,2})\b/gi) || []).length;
  if (timeMatches.length > 1) return true;
  if (remedioCount > 1) return true;
  if (dateWordCount > 1) return true;
  if (remedioCount >= 1 && dateWordCount >= 1) return true;
  return false;
}

function parseCommand(raw) {
  const text = normalize(raw);
  if (looksCompound(text)) return null;

  // 1) Marcar item da lista como comprado
  let m =
    text.match(/^j[áa]\s+compre[i]?\s+(.+)$/) ||
    text.match(/^comprei\s+(.+)$/) ||
    text.match(/^(?:tira|remove)\s+(.+?)\s+da lista/);
  if (m) return { type: "lista_marcar", item: stripArticle(m[1]) };

  // 2) Confirmar remédio dado (checar antes de "cadastrar remédio")
  m = text.match(/(?:^|\s)(?:j[áa]\s+)?(?:dei|deu|dado|tomou)\s+(?:o|a)?\s*rem[ée]dio\s+d[aoe]s?\s+([a-zçãõáéíóúâêô]+)/i);
  if (m) return { type: "remedio_confirmar", child: capitalize(m[1]) };
  m = text.match(/rem[ée]dio\s+d[aoe]s?\s+([a-zçãõáéíóúâêô]+)\s+(?:j[áa]\s+)?(?:foi\s+)?(?:dado|tomado)/i);
  if (m) return { type: "remedio_confirmar", child: capitalize(m[1]) };

  // 3) Cadastrar remédio (tratamento) -- sempre via IA, que faz as perguntas
  // de nome do remédio / intervalo / duração antes de criar (ver interpret.js)
  if (/rem[ée]dio/.test(text)) return null;
  const time = parseTime(text);

  // 4) Adicionar item(ns) na lista de compras
  m = text.match(/^(?:adicion\w*|coloc\w*|p[õo][eê]\w*|inser\w*|compr\w*|precisa de|falta)\s+(.+?)\s+(?:n?[aà]s?|pras?|para\s+a)\s+(?:minha\s+)?lista(?:\s+de\s+compras)?$/);
  if (m) {
    const items = m[1].split(/,| e /).map((s) => stripArticle(s)).filter(Boolean);
    return { type: "lista_add", items };
  }
  // variação sem verbo explícito: "arroz e leite na lista"
  m = text.match(/^(.+?)\s+(?:n?[aà]s?|pras?|para\s+a)\s+(?:minha\s+)?lista(?:\s+de\s+compras)?$/);
  if (m && !/rem[ée]dio/.test(text)) {
    const items = m[1].split(/,| e /).map((s) => stripArticle(s)).filter(Boolean);
    return { type: "lista_add", items };
  }

  // 5) Compromisso: "<algo> hoje/amanhã/dia N às HHh"
  if (time) {
    m = text.match(/^(?:marca|marcar|agenda|agendar|tem|vai ter)?\s*(.+?)\s+(hoje|amanh[ãa]|dia\s+\d{1,2})(?=\s|$)/i);
    if (m) {
      const title = capitalize(m[1].trim());
      const dateLabel = m[2];
      return { type: "compromisso_add", title, dateLabel, time };
    }
  }

  return null;
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* -------------------------- Fallback de IA real --------------------------
   Claude Haiku via função serverless (api/interpret.js), só chamado quando
   o parser local (acima) não reconhece o comando -- é o que mantém o custo
   de IA baixo (ver seção "Estratégia de Custo de IA" do plano): a imensa
   maioria dos comandos nunca chega até aqui.
------------------------------------------------------------------------- */
async function callAIFallback(text) {
  try {
    const r = await fetch("/api/interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error("bad_status");
    return await r.json();
  } catch {
    return [{ type: "desconhecido", reply: "Não consegui falar com a IA agora. Tente de novo em um instante." }];
  }
}

/* -------------------------------- UI refs ------------------------------- */
const micBtn = document.getElementById("micBtn");
const micHint = document.getElementById("micHint");
const transcriptEl = document.getElementById("transcript");
const toastEl = document.getElementById("toast");
const briefText = document.getElementById("briefText");

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

/* ------------------------------- Renderers ------------------------------ */
function renderLista() {
  const ul = document.getElementById("listaItems");
  const empty = document.getElementById("listaEmpty");
  document.getElementById("listaCount").textContent = `${state.lista.filter((i) => !i.done).length} itens`;
  ul.innerHTML = "";
  empty.style.display = state.lista.length ? "none" : "block";
  state.lista
    .slice()
    .sort((a, b) => a.done - b.done)
    .forEach((item) => {
      const li = document.createElement("li");
      li.className = "item-row";
      li.innerHTML = `
        <div class="check ${item.done ? "checked" : ""}" data-id="${item.id}" data-action="toggle-lista">${item.done ? "✓" : ""}</div>
        <div class="item-main">
          <div class="item-title ${item.done ? "done" : ""}">${item.text}</div>
          <div class="item-sub">${item.category}</div>
        </div>
        <button class="del-btn" data-id="${item.id}" data-action="del-lista">✕</button>
      `;
      ul.appendChild(li);
    });
}

function formatDoseWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `hoje ${hhmm}`;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hhmm}`;
}

function renderRemedios() {
  const ul = document.getElementById("remediosItems");
  const empty = document.getElementById("remediosEmpty");
  document.getElementById("remediosCount").textContent = `${state.tratamentos.length} cadastrados`;
  ul.innerHTML = "";
  empty.style.display = state.tratamentos.length ? "none" : "block";
  state.tratamentos.forEach((t) => {
    const givenCount = t.doses.filter((d) => d.given).length;
    const next = nextPendingDose(t);
    const li = document.createElement("li");
    li.className = "item-row";
    const tagClass = next ? "warn" : "";
    li.innerHTML = `
      <div class="check ${!next ? "checked" : ""}">${!next ? "✓" : ""}</div>
      <div class="item-main">
        <div class="item-title">${t.child} · ${t.medName}</div>
        <div class="item-sub">${next ? `Próxima dose: ${formatDoseWhen(next.at)}` : "Tratamento concluído"} · ${givenCount}/${t.doses.length} doses · de ${t.intervalHours} em ${t.intervalHours}h por ${t.days} dia${t.days > 1 ? "s" : ""}</div>
      </div>
      ${next ? `<span class="tag ${tagClass}" data-id="${t.id}" data-action="test-alarm" style="cursor:pointer">🔔 testar</span>` : ""}
    `;
    ul.appendChild(li);
  });
}

function renderCompromissos() {
  const ul = document.getElementById("compromissosItems");
  const empty = document.getElementById("compromissosEmpty");
  document.getElementById("compromissosCount").textContent = `${state.compromissos.length} agendados`;
  ul.innerHTML = "";
  empty.style.display = state.compromissos.length ? "none" : "block";
  state.compromissos.forEach((c) => {
    const li = document.createElement("li");
    li.className = "item-row";
    li.innerHTML = `
      <div class="item-main">
        <div class="item-title">${c.title}</div>
        <div class="item-sub">${c.dateLabel} · ${c.time}</div>
      </div>
      <button class="del-btn" data-id="${c.id}" data-action="del-compromisso">✕</button>
    `;
    ul.appendChild(li);
  });
}

function renderBrief() {
  const parts = [];
  const pendentes = state.tratamentos.map((t) => ({ t, next: nextPendingDose(t) })).filter((x) => x.next);
  if (pendentes.length) {
    parts.push(
      `${pendentes.length === 1 ? "o remédio de" : "os remédios de"} ${pendentes.map((x) => `${x.t.child} às ${formatDoseWhen(x.next.at).replace("hoje ", "")}`).join(", ")}`
    );
  }
  if (state.compromissos.length) {
    const first = state.compromissos[0];
    parts.push(`${first.title} ${first.dateLabel} às ${first.time}`);
  }
  const pendingItems = state.lista.filter((i) => !i.done).length;
  if (pendingItems) parts.push(`${pendingItems} ${pendingItems === 1 ? "item" : "itens"} na lista de compras`);

  briefText.textContent = parts.length
    ? `Hoje você tem: ${parts.join(" e ")}.`
    : "Nada pendente por enquanto — dia livre!";
}

function renderAll() {
  renderLista();
  renderRemedios();
  renderCompromissos();
  renderBrief();
  save();
}

/* ------------------------------- Ações ---------------------------------- */
function addListaItems(items) {
  items.forEach((text) => {
    state.lista.push({ id: uid(), text: capitalize(text), category: categorize(text), done: false });
  });
}
function marcarListaComprado(itemText) {
  const t = itemText.toLowerCase();
  const found = state.lista.find((i) => !i.done && i.text.toLowerCase().includes(t));
  return found ? ((found.done = true), true) : false;
}
/* ------------------------- Tratamentos de remédio -------------------------
   Um "tratamento" gera todas as doses de uma vez (nome do remédio + de
   quantas em quantas horas + por quantos dias), em vez de um lembrete
   avulso -- é o que a IA pede antes de criar (ver interpret.js). */
function resolveDateTime(dateLabel, hhmm) {
  const [hh, mm] = (hhmm || "00:00").split(":").map(Number);
  const d = new Date();
  d.setHours(hh || 0, mm || 0, 0, 0);
  const diaMatch = /dia\s+(\d{1,2})/i.exec(dateLabel || "");
  if (diaMatch) d.setDate(parseInt(diaMatch[1], 10));
  else if (/amanh[ãa]/i.test(dateLabel || "")) d.setDate(d.getDate() + 1);
  return d;
}

function criarTratamento({ child, medName, time, dateLabel, intervalHours, days }) {
  const interval = Number(intervalHours) > 0 ? Number(intervalHours) : 24;
  const totalDays = Number(days) > 0 ? Number(days) : 1;
  const start = resolveDateTime(dateLabel, time);
  const doses = [];
  const totalMs = totalDays * 24 * 60 * 60 * 1000;
  const intervalMs = interval * 60 * 60 * 1000;
  for (let t = start.getTime(); t < start.getTime() + totalMs; t += intervalMs) {
    doses.push({ id: uid(), at: new Date(t).toISOString(), given: false });
  }
  const tratamento = {
    id: uid(),
    child,
    medName: medName || "Remédio",
    intervalHours: interval,
    days: totalDays,
    doses,
  };
  state.tratamentos.push(tratamento);
  return tratamento;
}

function nextPendingDose(tratamento) {
  return tratamento.doses.find((d) => !d.given) || null;
}

function confirmarDose(child) {
  const candidatos = state.tratamentos
    .map((t) => ({ t, dose: nextPendingDose(t) }))
    .filter((x) => x.dose && x.t.child === child)
    .sort((a, b) => new Date(a.dose.at) - new Date(b.dose.at));
  if (!candidatos.length) return false;
  candidatos[0].dose.given = true;
  hideAlarm();
  return true;
}
function addCompromisso(title, dateLabel, time) {
  state.compromissos.push({ id: uid(), title, dateLabel, time });
  state.compromissos.sort((a, b) => a.time.localeCompare(b.time));
}

/* --------------------------- Execução de comando -------------------------- */
function applyCommand(cmd) {
  switch (cmd.type) {
    case "lista_add":
      addListaItems(cmd.items);
      return `Prontinho! Adicionei ${cmd.items.join(" e ")} na lista.`;
    case "lista_marcar": {
      const ok = marcarListaComprado(cmd.item);
      return ok ? `Marquei "${cmd.item}" como comprado.` : `Não encontrei "${cmd.item}" na lista.`;
    }
    case "remedio_tratamento": {
      const t = criarTratamento(cmd);
      return `Prontinho! ${cmd.medName} de ${cmd.child}, de ${t.intervalHours} em ${t.intervalHours}h por ${t.days} dia${t.days > 1 ? "s" : ""} — ${t.doses.length} doses agendadas a partir de ${formatDoseWhen(t.doses[0].at)}.`;
    }
    case "remedio_confirmar": {
      const ok = confirmarDose(cmd.child);
      return ok ? `Confirmado! Registrei que ${cmd.child} tomou o remédio.` : `Não encontrei remédio pendente de ${cmd.child}.`;
    }
    case "compromisso_add":
      addCompromisso(cmd.title, cmd.dateLabel, cmd.time);
      return `Prontinho! ${cmd.title} ${cmd.dateLabel} às ${cmd.time}.`;
    default:
      return cmd.reply || "Não entendi, pode repetir de outro jeito?";
  }
}

/* Memória curta de conversa: se a IA perguntou algo (ex: "a que horas?") e
   ficou sem resposta certa, a próxima fala do usuário é tratada como
   COMPLEMENTO daquela frase, não como um comando novo do zero. Sem isso,
   responder só "às 15h" virava um compromisso vazio e confuso. */
let pendingClarification = null; // { text: string } | null

async function executeCommand(text) {
  let cmds;
  let contextText = text;

  if (pendingClarification) {
    contextText = `${pendingClarification.text}. ${text}`;
    pendingClarification = null;
    micHint.textContent = "Pensando…";
    cmds = await callAIFallback(contextText);
    if (!Array.isArray(cmds)) cmds = [cmds];
    micHint.textContent = 'Toque e fale, ex: "lembra do remédio da Sofia às 14h"';
  } else {
    const localCmd = parseCommand(text);
    cmds = localCmd ? [localCmd] : null;
    if (!cmds) {
      micHint.textContent = "Pensando…";
      cmds = await callAIFallback(text);
      if (!Array.isArray(cmds)) cmds = [cmds];
      micHint.textContent = 'Toque e fale, ex: "lembra do remédio da Sofia às 14h"';
    }
  }

  if (cmds.length === 1 && cmds[0].type === "desconhecido") {
    pendingClarification = { text: contextText };
  }

  const reply = cmds.map((c) => applyCommand(c)).join(" ");
  speakSmart(reply);
  toast(reply);
  renderAll();
}

/* ------------------------------ Alarme modal ----------------------------- */
const alarmOverlay = document.getElementById("alarmOverlay");
const alarmTitle = document.getElementById("alarmTitle");
const alarmSub = document.getElementById("alarmSub");
let alarmChild = null;

function showAlarm(tratamento) {
  const dose = nextPendingDose(tratamento);
  if (!dose) return;
  alarmChild = tratamento.child;
  const idx = tratamento.doses.indexOf(dose) + 1;
  alarmTitle.textContent = `Hora do remédio de ${tratamento.child}`;
  alarmSub.textContent = `${tratamento.medName} — dose ${idx} de ${tratamento.doses.length}. Agendado para ${formatDoseWhen(dose.at)}. Confirma que já foi dado?`;
  alarmOverlay.classList.add("show");
  speak(`Atenção! Hora do remédio de ${tratamento.child}.`);
}
function hideAlarm() {
  alarmOverlay.classList.remove("show");
  alarmChild = null;
}
document.getElementById("alarmConfirm").addEventListener("click", () => {
  if (alarmChild) {
    confirmarDose(alarmChild);
    renderAll();
  }
});
document.getElementById("alarmSnooze").addEventListener("click", () => {
  toast("Vou lembrar de novo em 5 minutos.");
  hideAlarm();
});

/* --------------------------- Checagem de horário --------------------------
   Alarme crítico funciona por checagem local de relógio (sem depender de
   internet) -- reflete o requisito de "alarmes críticos offline" do plano.
---------------------------------------------------------------------------- */
setInterval(() => {
  const now = new Date();
  state.tratamentos.forEach((t) => {
    const dose = nextPendingDose(t);
    if (dose && new Date(dose.at) <= now && !alarmOverlay.classList.contains("show")) {
      showAlarm(t);
    }
  });
}, 15000);

/* ------------------------------- Delegação -------------------------------- */
document.getElementById("screen").addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;

  if (action === "toggle-lista") {
    const item = state.lista.find((i) => i.id === id);
    if (item) item.done = !item.done;
    renderAll();
  }
  if (action === "del-lista") {
    state.lista = state.lista.filter((i) => i.id !== id);
    renderAll();
  }
  if (action === "del-compromisso") {
    state.compromissos = state.compromissos.filter((c) => c.id !== id);
    renderAll();
  }
  if (action === "test-alarm") {
    const t = state.tratamentos.find((x) => x.id === id);
    if (t) showAlarm(t);
  }
});

/* --------------------------------- Tabs ----------------------------------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

/* ------------------------- Web Speech API (STT/TTS) -----------------------
   Equivalente, no navegador, ao "STT/TTS nativo do celular" do plano de
   custo: usa o motor de voz do próprio sistema operacional, sem chamada de
   API paga.
---------------------------------------------------------------------------- */
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

/* continuous:true evita que o navegador corte a fala no meio de uma pausa
   natural entre frases (ex: "lembra do dentista amanhã... e também leva o
   carro na revisão"). Em vez de deixar o navegador decidir quando o
   usuário terminou, controlamos isso nós mesmos: acumulamos os trechos
   finalizados e só processamos o comando depois de ~1.8s sem fala nova. */
const SILENCE_MS = 1800;
const MAX_LISTEN_MS = 12000; // trava de segurança: nunca escuta indefinidamente (ex: ruído/eco sendo mal-reconhecido em loop)
let finalBuffer = "";
let silenceTimer = null;
let maxListenTimer = null;

function scheduleFinalize() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(finalizeManual, SILENCE_MS);
}

function finalizeManual() {
  clearTimeout(silenceTimer);
  clearTimeout(maxListenTimer);
  const text = finalBuffer.trim();
  finalBuffer = "";
  if (recognition && listening) recognition.stop();
  if (text) executeCommand(text);
}

if (SpeechRecognitionCtor) {
  recognition = new SpeechRecognitionCtor();
  recognition.lang = "pt-BR";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    finalBuffer = "";
    micBtn.classList.add("listening");
    micHint.textContent = "Ouvindo… (toque de novo quando terminar de falar)";
    clearTimeout(maxListenTimer);
    maxListenTimer = setTimeout(finalizeManual, MAX_LISTEN_MS);
  };
  recognition.onend = () => {
    listening = false;
    clearTimeout(silenceTimer);
    clearTimeout(maxListenTimer);
    micBtn.classList.remove("listening");
    micHint.textContent = 'Toque e fale, ex: "lembra do remédio da Sofia às 14h"';
    const pending = finalBuffer.trim();
    finalBuffer = "";
    if (pending) executeCommand(pending);
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("Permita o uso do microfone para falar com a Moderna.");
    }
  };
  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalBuffer += (finalBuffer ? " " : "") + t.trim();
      else interim += t;
    }
    transcriptEl.textContent = `${finalBuffer} ${interim}`.trim();
    scheduleFinalize();
  };
} else {
  micHint.textContent = "Reconhecimento de voz não suportado neste navegador — use o campo de texto abaixo.";
}

micBtn.addEventListener("click", () => {
  if (!recognition) return typedFallbackPrompt();
  if (listening) finalizeManual();
  else {
    transcriptEl.textContent = "";
    try {
      recognition.start();
    } catch {
      /* já iniciado */
    }
  }
});

function typedFallbackPrompt() {
  const text = prompt('Digite o comando (ex: "adiciona arroz na lista"):');
  if (text) {
    transcriptEl.textContent = text;
    executeCommand(text);
  }
}

function pickBestDefaultVoice(voices) {
  const ptVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("pt"));
  const ptBr = ptVoices.find((v) => v.lang.toLowerCase() === "pt-br");
  return ptBr || ptVoices[0] || voices[0] || null;
}

function getSelectedVoice() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  if (!voices.length) return null;
  const pref = getTtsPref();
  const saved = pref.voiceURI && voices.find((v) => v.voiceURI === pref.voiceURI);
  return saved || pickBestDefaultVoice(voices);
}

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = getSelectedVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = "pt-BR";
  }
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
}

/* --------------------------- Voz em nuvem (Google TTS) --------------------
   Muito mais natural que a voz do sistema. Usada nas respostas gerais;
   os alarmes de remédio (showAlarm, acima) continuam na voz nativa de
   propósito -- não podem depender de internet. Se a chamada de rede falhar
   (sem sinal, API fora do ar), cai automaticamente para a voz nativa. */
const TTS_PREF_KEY = "mulher-moderna-tts-pref";
const CLOUD_VOICES = [
  { id: "pt-BR-Wavenet-A", label: "Camila (WaveNet, feminina)" },
  { id: "pt-BR-Wavenet-C", label: "Luciana (WaveNet, feminina)" },
  { id: "pt-BR-Wavenet-D", label: "Beatriz (WaveNet, feminina)" },
  { id: "pt-BR-Wavenet-B", label: "Rafael (WaveNet, masculina)" },
  { id: "pt-BR-Wavenet-E", label: "Thiago (WaveNet, masculina)" },
];

function getTtsPref() {
  try {
    const saved = JSON.parse(localStorage.getItem(TTS_PREF_KEY));
    if (saved && saved.mode) return saved;
  } catch {
    /* ignora */
  }
  return { mode: "cloud", cloudVoice: CLOUD_VOICES[0].id };
}
function setTtsPref(pref) {
  localStorage.setItem(TTS_PREF_KEY, JSON.stringify(pref));
}

let currentCloudAudio = null;
async function speakCloud(text, voiceId) {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: voiceId }),
  });
  if (!r.ok) throw new Error("tts_failed");
  const { audioContent } = await r.json();
  if (!audioContent) throw new Error("tts_empty");
  if (currentCloudAudio) currentCloudAudio.pause();
  currentCloudAudio = new Audio(`data:audio/mp3;base64,${audioContent}`);
  await currentCloudAudio.play();
}

async function speakSmart(text) {
  const pref = getTtsPref();
  if (pref.mode === "cloud") {
    try {
      await speakCloud(text, pref.cloudVoice);
      return;
    } catch {
      /* sem internet ou API fora do ar -- cai para a voz nativa abaixo */
    }
  }
  speak(text);
}

/* --------------------------- Seleção de voz (TTS) -------------------------
   Lista tanto as vozes de nuvem (mais naturais, precisam de internet)
   quanto as vozes nativas do celular (offline, grátis). O usuário escolhe
   e testa; a escolha fica salva no aparelho (localStorage).
---------------------------------------------------------------------------- */
const voiceOverlay = document.getElementById("voiceOverlay");
const voiceList = document.getElementById("voiceList");

function renderVoiceList() {
  const pref = getTtsPref();
  const rows = [];

  CLOUD_VOICES.forEach((v) => {
    const selected = pref.mode === "cloud" && pref.cloudVoice === v.id;
    rows.push({
      key: `cloud:${v.id}`,
      name: `🌐 ${v.label}`,
      sub: "voz de nuvem · mais natural · precisa de internet",
      selected,
      onSelect: () => setTtsPref({ mode: "cloud", cloudVoice: v.id }),
      onPlay: () => speakCloud("Oi! Essa é a minha voz. Ficou boa assim?", v.id).catch(() => toast("Não consegui carregar essa voz agora.")),
    });
  });

  const all = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const pt = all.filter((v) => v.lang && v.lang.toLowerCase().startsWith("pt"));
  const nativeVoices = pt.length ? pt : all;
  nativeVoices.forEach((v) => {
    const selected = pref.mode === "native" && pref.voiceURI === v.voiceURI;
    rows.push({
      key: `native:${v.voiceURI}`,
      name: `📱 ${v.name}`,
      sub: `voz do celular · offline · ${v.lang}`,
      selected,
      onSelect: () => setTtsPref({ mode: "native", voiceURI: v.voiceURI }),
      onPlay: () => {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance("Oi! Essa é a minha voz. Ficou boa assim?");
        u.voice = v;
        u.lang = v.lang;
        window.speechSynthesis.speak(u);
      },
    });
  });

  voiceList.innerHTML = "";
  rows.forEach((row) => {
    const el = document.createElement("div");
    el.className = "voice-row" + (row.selected ? " selected" : "");
    el.innerHTML = `
      <div class="voice-row-main">
        <div class="voice-row-name">${row.name}</div>
        <div class="voice-row-lang">${row.sub}</div>
      </div>
      <button class="voice-row-play" data-action="play-voice">▶</button>
    `;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-action='play-voice']")) return;
      row.onSelect();
      renderVoiceList();
    });
    el.querySelector("[data-action='play-voice']").addEventListener("click", (e) => {
      e.stopPropagation();
      row.onPlay();
    });
    voiceList.appendChild(el);
  });
}

document.getElementById("voiceSettingsBtn").addEventListener("click", () => {
  renderVoiceList();
  voiceOverlay.classList.add("show");
});
document.getElementById("voiceCloseBtn").addEventListener("click", () => {
  voiceOverlay.classList.remove("show");
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (currentCloudAudio) currentCloudAudio.pause();
});
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    if (voiceOverlay.classList.contains("show")) renderVoiceList();
  };
}

/* --------------------------------- Perfil --------------------------------- */
document.getElementById("profileBtn").addEventListener("click", () => {
  toast("Perfis de família: em breve (Fase 2 do roadmap).");
});

/* ---------------------------------- Seed ----------------------------------- */
function seedIfEmpty() {
  if (state.lista.length || state.tratamentos.length || state.compromissos.length) return;
  addListaItems(["arroz", "fralda", "leite"]);
  criarTratamento({ child: "Sofia", medName: "Amoxicilina", time: "14:00", dateLabel: "hoje", intervalHours: 8, days: 3 });
  addCompromisso("Dentista da Sofia", "amanhã", "10:00");
}

document.getElementById("versionTag").textContent = `v${APP_VERSION}`;
document.getElementById("versionTag").title = `Publicado em ${BUILD_TIME}`;

seedIfEmpty();
renderAll();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
