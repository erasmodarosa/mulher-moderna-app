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

const STORAGE_KEY = "mulher-moderna-data-v1";

const state = load() || {
  lista: [],
  remedios: [],
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
------------------------------------------------------------------------- */
function parseCommand(raw) {
  const text = raw.trim().toLowerCase();

  // 1) Marcar item da lista como comprado
  let m = text.match(/^j[áa] compre[i]?\s+(.+)$/) || text.match(/^comprei\s+(.+)$/);
  if (m) return { type: "lista_marcar", item: m[1].trim() };

  // 2) Adicionar item(ns) na lista de compras
  m = text.match(/^(?:adiciona|coloca|p[õo]e)\s+(.+?)\s+na lista(?: de compras)?$/);
  if (m) {
    const items = m[1].split(/,| e /).map((s) => s.trim()).filter(Boolean);
    return { type: "lista_add", items };
  }

  // 3) Confirmar remédio dado
  m = text.match(/^dei\s+(?:o|a)?\s*rem[ée]dio\s+d[aoe]\s+([a-zçãõáéíóú]+)$/i);
  if (m) return { type: "remedio_confirmar", child: capitalize(m[1]) };

  // 4) Cadastrar remédio: "remédio da Sofia às 14h" / "lembra do remédio da Sofia às 14h"
  m = text.match(/rem[ée]dio\s+d[aoe]\s+([a-zçãõáéíóú]+).*?(?:[àa]s?)\s*(\d{1,2})(?::(\d{2}))?\s*h?/i);
  if (m) {
    const child = capitalize(m[1]);
    const hh = m[2].padStart(2, "0");
    const mm = (m[3] || "00").padStart(2, "0");
    return { type: "remedio_add", child, time: `${hh}:${mm}` };
  }

  // 5) Compromisso: "dentista da Sofia amanhã às 10h" / "marca <algo> dia 15 às 10h"
  m = text.match(/^(?:marca|marcar|agenda|agendar)?\s*(.+?)\s+(hoje|amanh[ãa]|dia\s+\d{1,2})\s+[àa]s?\s*(\d{1,2})(?::(\d{2}))?\s*h?/i);
  if (m) {
    const title = capitalize(m[1].trim());
    const dateLabel = m[2];
    const hh = m[3].padStart(2, "0");
    const mm = (m[4] || "00").padStart(2, "0");
    return { type: "compromisso_add", title, dateLabel, time: `${hh}:${mm}` };
  }

  return null;
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* -------------------- Fallback simulado (LLM barato) --------------------
   No app real: Claude Haiku 4.5 + prompt caching, só chamado quando o
   parser local (acima) não reconhece o comando -- é o ponto que mantém
   o custo de IA baixo (ver seção "Estratégia de Custo de IA" do plano).
------------------------------------------------------------------------- */
function callAIFallback(text) {
  return {
    reply: `Não tenho certeza do que você quis dizer com "${text}". Em produção, isso seria enviado para a IA (Claude Haiku) entender melhor — aqui no protótipo, tente um dos comandos de exemplo.`,
  };
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

function renderRemedios() {
  const ul = document.getElementById("remediosItems");
  const empty = document.getElementById("remediosEmpty");
  document.getElementById("remediosCount").textContent = `${state.remedios.length} cadastrados`;
  ul.innerHTML = "";
  empty.style.display = state.remedios.length ? "none" : "block";
  state.remedios.forEach((r) => {
    const li = document.createElement("li");
    li.className = "item-row";
    const tagClass = r.confirmedToday ? "" : "warn";
    li.innerHTML = `
      <div class="check ${r.confirmedToday ? "checked" : ""}" data-id="${r.id}" data-action="toggle-remedio">${r.confirmedToday ? "✓" : ""}</div>
      <div class="item-main">
        <div class="item-title">${r.child} · ${r.time}</div>
        <div class="item-sub">${r.confirmedToday ? "Confirmado hoje" : "Aguardando confirmação"} · ${r.history.length} doses no histórico</div>
      </div>
      <span class="tag ${tagClass}" data-id="${r.id}" data-action="test-alarm" style="cursor:pointer">🔔 testar</span>
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
  const pendentes = state.remedios.filter((r) => !r.confirmedToday);
  if (pendentes.length) {
    parts.push(`${pendentes.length === 1 ? "o remédio de" : "os remédios de"} ${pendentes.map((r) => `${r.child} às ${r.time}`).join(", ")}`);
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
function addRemedio(child, time) {
  const existing = state.remedios.find((r) => r.child === child && r.time === time);
  if (existing) return existing;
  const r = { id: uid(), child, time, confirmedToday: false, history: [] };
  state.remedios.push(r);
  return r;
}
function confirmarRemedio(child) {
  const r = state.remedios.find((x) => x.child === child && !x.confirmedToday);
  if (!r) return false;
  r.confirmedToday = true;
  r.history.push(new Date().toISOString());
  hideAlarm();
  return true;
}
function addCompromisso(title, dateLabel, time) {
  state.compromissos.push({ id: uid(), title, dateLabel, time });
  state.compromissos.sort((a, b) => a.time.localeCompare(b.time));
}

/* --------------------------- Execução de comando -------------------------- */
function executeCommand(text) {
  const cmd = parseCommand(text);

  if (!cmd) {
    const { reply } = callAIFallback(text);
    speak(reply);
    toast(reply);
    return;
  }

  let reply = "";
  switch (cmd.type) {
    case "lista_add":
      addListaItems(cmd.items);
      reply = `Prontinho! Adicionei ${cmd.items.join(" e ")} na lista.`;
      break;
    case "lista_marcar": {
      const ok = marcarListaComprado(cmd.item);
      reply = ok ? `Marquei "${cmd.item}" como comprado.` : `Não encontrei "${cmd.item}" na lista.`;
      break;
    }
    case "remedio_add":
      addRemedio(cmd.child, cmd.time);
      reply = `Prontinho! Remédio de ${cmd.child} às ${cmd.time}, vou te lembrar.`;
      break;
    case "remedio_confirmar": {
      const ok = confirmarRemedio(cmd.child);
      reply = ok ? `Confirmado! Registrei que ${cmd.child} tomou o remédio.` : `Não encontrei remédio pendente de ${cmd.child}.`;
      break;
    }
    case "compromisso_add":
      addCompromisso(cmd.title, cmd.dateLabel, cmd.time);
      reply = `Prontinho! ${cmd.title} ${cmd.dateLabel} às ${cmd.time}.`;
      break;
  }
  speak(reply);
  toast(reply);
  renderAll();
}

/* ------------------------------ Alarme modal ----------------------------- */
const alarmOverlay = document.getElementById("alarmOverlay");
const alarmTitle = document.getElementById("alarmTitle");
const alarmSub = document.getElementById("alarmSub");
let alarmChild = null;

function showAlarm(remedio) {
  alarmChild = remedio.child;
  alarmTitle.textContent = `Hora do remédio de ${remedio.child}`;
  alarmSub.textContent = `Agendado para ${remedio.time}. Confirma que já foi dado?`;
  alarmOverlay.classList.add("show");
  speak(`Atenção! Hora do remédio de ${remedio.child}.`);
}
function hideAlarm() {
  alarmOverlay.classList.remove("show");
  alarmChild = null;
}
document.getElementById("alarmConfirm").addEventListener("click", () => {
  if (alarmChild) {
    confirmarRemedio(alarmChild);
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
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  state.remedios.forEach((r) => {
    if (!r.confirmedToday && r.time === hhmm && !alarmOverlay.classList.contains("show")) {
      showAlarm(r);
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
    const r = state.remedios.find((x) => x.id === id);
    if (r) showAlarm(r);
  }
  if (action === "toggle-remedio") {
    const r = state.remedios.find((x) => x.id === id);
    if (r && !r.confirmedToday) confirmarRemedio(r.child);
    renderAll();
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

if (SpeechRecognitionCtor) {
  recognition = new SpeechRecognitionCtor();
  recognition.lang = "pt-BR";
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    micBtn.classList.add("listening");
    micHint.textContent = "Ouvindo…";
  };
  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    micHint.textContent = 'Toque e fale, ex: "lembra do remédio da Sofia às 14h"';
  };
  recognition.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("Permita o uso do microfone para falar com a Moderna.");
    }
  };
  recognition.onresult = (e) => {
    let finalText = "";
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    transcriptEl.textContent = finalText || interim;
    if (finalText) executeCommand(finalText);
  };
} else {
  micHint.textContent = "Reconhecimento de voz não suportado neste navegador — use o campo de texto abaixo.";
}

micBtn.addEventListener("click", () => {
  if (!recognition) return typedFallbackPrompt();
  if (listening) recognition.stop();
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

function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "pt-BR";
  u.rate = 1.02;
  window.speechSynthesis.speak(u);
}

/* --------------------------------- Perfil --------------------------------- */
document.getElementById("profileBtn").addEventListener("click", () => {
  toast("Perfis de família: em breve (Fase 2 do roadmap).");
});

/* ---------------------------------- Seed ----------------------------------- */
function seedIfEmpty() {
  if (state.lista.length || state.remedios.length || state.compromissos.length) return;
  addListaItems(["arroz", "fralda", "leite"]);
  addRemedio("Sofia", "14:00");
  addCompromisso("Dentista da Sofia", "amanhã", "10:00");
}

seedIfEmpty();
renderAll();
