'use strict';

/* =====================================================================
   BodyEvo — acompanhamento de bulking (PWA)
   ---------------------------------------------------------------------
   Estrutura do arquivo:
     1. Camada de dados  → só estas funções falam com o Supabase
     2. Fila de sincronização (offline-first)
     3. Estado e utilidades
     4. Telas (4a a 4l), sheets e pop-up
     5. Navegação, eventos globais e service worker
   As regras da planilha ficam em regras.js (objeto global R).
   ===================================================================== */

const R = (typeof REGRAS !== 'undefined') ? REGRAS : window.REGRAS;


/* =====================================================================
   1. CAMADA DE DADOS
   ---------------------------------------------------------------------
   Para trocar de banco, basta mexer nesta seção. Sem URL e chave, o app
   roda em "modo local": tudo fica só neste aparelho e não há login.
   ===================================================================== */

const SUPABASE_URL = 'https://icqwjsnirrxbgzojfjag.supabase.co';
const SUPABASE_KEY = 'sb_publishable_IScOrD6nNJzUTSDmrUk2_Q_wj728kfK';   // chave publishable, pública por natureza
const API_URL = '';        // api/ (Garmin e push), ex.: 'https://rumo-api.onrender.com'
const VAPID_PUBLICA = 'BIEoDcQTzNEX-bOTGHb1kGu3EnT3JVJ7w--1lIIVDabhODo-MAxihrT6hvinLo6850dbxqc6wK03vKFjVj5FFAM';

const MODO_LOCAL = !SUPABASE_URL || !SUPABASE_KEY;
const ID_LOCAL = '00000000-0000-4000-8000-000000000000';

const sb = MODO_LOCAL ? null : window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',          // o link do e-mail volta com ?code=, que não briga com o #hash das telas
    storageKey: 'rumo.auth',
  },
});

/* Chave de upsert de cada tabela: reenviar a mesma linha nunca duplica. */
const TABELAS = {
  settings:           { conflito: 'user_id', ordem: 'user_id' },
  kcal_targets:       { conflito: 'user_id,effective_from' },
  macro_goals:        { conflito: 'user_id,macro' },
  daily_logs:         { conflito: 'user_id,date' },
  foods:              { conflito: 'id' },
  meal_types:         { conflito: 'id' },
  meal_entries:       { conflito: 'id' },
  weekly_checkins:    { conflito: 'user_id,week_number' },
  push_subscriptions: { conflito: 'endpoint', soEnvio: true },
};

/** Lê uma tabela inteira, em páginas de 1000 linhas. A RLS devolve só as do usuário. */
async function buscarTabela(tabela) {
  const TAM = 1000;
  const linhas = [];
  for (let de = 0; ; de += TAM) {
    const { data, error } = await sb.from(tabela).select('*')
      .order(TABELAS[tabela].ordem || 'id')
      .range(de, de + TAM - 1);
    if (error) throw error;
    linhas.push(...data);
    if (data.length < TAM) return linhas;
  }
}

async function buscarTudo() {
  const nomes = Object.keys(TABELAS).filter((t) => !TABELAS[t].soEnvio);
  const res = await Promise.all(nomes.map(buscarTabela));
  const dados = {};
  nomes.forEach((t, i) => { dados[t] = res[i]; });
  return dados;
}

/** Upsert de uma linha (reenvio é seguro). Em daily_logs vão só as colunas que o app controla. */
async function salvarLinha(tabela, linha) {
  const { error } = await sb.from(tabela).upsert(linha, { onConflict: TABELAS[tabela].conflito });
  if (error) throw error;
}

async function removerLinha(tabela, id) {
  const { error } = await sb.from(tabela).delete().eq('id', id);
  if (error) throw error;
}

async function tokenAtual() {
  if (MODO_LOCAL) return null;
  const { data } = await sb.auth.getSession();
  return data && data.session ? data.session.access_token : null;
}

/* Login por e-mail e senha. O usuário é criado uma vez no painel do Supabase
   (Authentication › Users › Add user); o app não cria contas. */
async function entrarComSenha(email, senha) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) throw error;
  return data.session;
}

async function sairDaConta() {
  if (!MODO_LOCAL) await sb.auth.signOut().catch(() => {});
}

/** Chamada à api/ (Garmin). O app nunca depende dela: se falhar, o valor manual continua valendo. */
async function chamarApi(caminho, corpo) {
  const token = await tokenAtual();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 75000);   // hospedagem gratuita pode estar "acordando"
  try {
    const r = await fetch(API_URL.replace(/\/$/, '') + caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(corpo || {}),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Bases de alimentos (só leitura) ---------- */

/* TACO 4ª ed. (NEPA/UNICAMP), por 100 g. Fica em dados/taco.json (gerado por ferramentas/gerar_taco.py)
   e o service worker guarda o arquivo para funcionar sem internet. Carrega só na primeira busca. */
let taco = null;
let tacoPromessa = null;
function carregarTaco() {
  if (taco) return Promise.resolve(taco);
  if (!tacoPromessa) {
    tacoPromessa = fetch('dados/taco.json')
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => {
        taco = d.itens.map(([nome, kcal, p, c, g]) => ({ nome, kcal, p, c, g, chave: R.normalizar(nome) }));
        return taco;
      })
      .catch((e) => { tacoPromessa = null; throw e; });
  }
  return tacoPromessa;
}

/* Open Food Facts: produto pelo código de barras (sem chave; precisa de internet).
   Devolve null se o produto não existe ou não tem as calorias por 100 g. */
async function buscarCodigoBarras(codigo) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const campos = 'product_name,product_name_pt,brands,nutriments';
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(codigo)}.json?fields=${campos}`, { signal: ctrl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const p = d && d.status === 1 && d.product;
    const n = p && p.nutriments;
    const kcal = n && numOuNada(n['energy-kcal_100g']);
    if (!kcal) return null;
    const nome = String(p.product_name_pt || p.product_name || '').trim();
    const marca = String(p.brands || '').split(',')[0].trim();
    const comMarca = marca && !R.normalizar(nome).includes(R.normalizar(marca)) ? `${nome} (${marca})` : nome;
    return {
      nome: (comMarca || `Produto ${codigo}`).slice(0, 60),
      kcal, p: numOuNada(n.proteins_100g), c: numOuNada(n.carbohydrates_100g), g: numOuNada(n.fat_100g),
    };
  } finally {
    clearTimeout(timer);
  }
}

function numOuNada(v) {
  const x = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(x) && x >= 0 ? x : null;
}


/* =====================================================================
   2. FILA DE SINCRONIZAÇÃO (offline-first)
   A interface grava primeiro no cache local e enfileira o envio.
   sincronizar() envia a fila e depois baixa o que está no servidor.
   ===================================================================== */

const CHAVES = {
  cache: 'rumo.cache',
  fila: 'rumo.fila',
  usuario: 'rumo.usuario',
  resumo: 'rumo.resumo_dispensado',
  push: 'rumo.push',
};

const store = {
  ler(chave, padrao) {
    try {
      const v = localStorage.getItem(chave);
      return v == null ? padrao : JSON.parse(v);
    } catch (e) { return padrao; }
  },
  gravar(chave, valor) {
    try { localStorage.setItem(chave, JSON.stringify(valor)); }
    catch (e) { console.warn('Falha ao gravar no localStorage', e); }
  },
  apagar(chave) {
    try { localStorage.removeItem(chave); } catch (e) { /* sem armazenamento */ }
  },
};

function cacheVazio() {
  return {
    settings: null, kcal_targets: [], macro_goals: [], daily_logs: [],
    foods: [], meal_types: [], meal_entries: [], weekly_checkins: [],
  };
}

let usuario = store.ler(CHAVES.usuario, null);          // { id, email }
if (MODO_LOCAL && !usuario) usuario = { id: ID_LOCAL, email: null, local: true };
let cache = Object.assign(cacheVazio(), store.ler(CHAVES.cache, {}));
let fila = store.ler(CHAVES.fila, []);
let sincronizando = false;
let erroSync = false;
let semSessao = false;
let retryTimer = null;
let revisaoFila = 0;     // muda a cada alteração da fila; detecta mudanças durante um download
let revisao = 0;         // muda a cada alteração do cache; invalida os cálculos guardados
let ultimoDownload = 0;
let baixando = false;

function gravarCache() { revisao++; store.gravar(CHAVES.cache, cache); }
function gravarFila() { revisaoFila++; store.gravar(CHAVES.fila, fila); atualizarSync(); }

function chaveFila(tabela, linha) {
  const c = TABELAS[tabela].conflito;
  return tabela + '|' + c.split(',').map((k) => linha[k]).join('|');
}

/** Tira o que o servidor controla. */
function paraEnvio(linha) {
  const l = { ...linha };
  delete l.updated_at;
  return l;
}

function enfileirarUpsert(tabela, linha) {
  if (MODO_LOCAL) return;
  const k = chaveFila(tabela, linha);
  // Junta com um envio da mesma linha ainda pendente (menos o que já está a caminho).
  const i = fila.findIndex((o, idx) => o.op === 'upsert' && o.k === k && !(sincronizando && idx === 0));
  if (i >= 0) fila[i].linha = { ...fila[i].linha, ...paraEnvio(linha) };
  else fila.push({ op: 'upsert', tabela, k, linha: paraEnvio(linha) });
  gravarFila();
}

function enfileirarDelete(tabela, id) {
  if (MODO_LOCAL) return;
  fila = fila.filter((o, idx) => !(o.op === 'upsert' && o.tabela === tabela && o.linha.id === id
    && !(sincronizando && idx === 0)));
  fila.push({ op: 'delete', tabela, id });
  gravarFila();
}

/* Erro de dado (classe 22) ou de restrição (23) nunca vai passar: descarta para não travar a
   fila. Os demais (rede, sessão, tabela faltando) ficam e são reenviados depois. */
function erroPermanente(e) {
  return !!(e && typeof e.code === 'string' && /^(22|23)/.test(e.code));
}

async function processarFila() {
  if (MODO_LOCAL || sincronizando) return;
  if (!navigator.onLine) { atualizarSync(); return; }
  if (!fila.length) { erroSync = false; atualizarSync(); return; }
  const token = await tokenAtual().catch(() => null);
  semSessao = !token;
  if (!token) { atualizarSync(); return; }

  sincronizando = true;
  atualizarSync();
  try {
    while (fila.length) {
      const op = fila[0];
      try {
        if (op.op === 'upsert') await salvarLinha(op.tabela, op.linha);
        else if (op.op === 'delete') await removerLinha(op.tabela, op.id);
      } catch (e) {
        if (!erroPermanente(e)) throw e;
        console.error('Operação descartada pelo servidor', op, e);
      }
      fila.shift();
      gravarFila();
    }
    erroSync = false;
  } catch (e) {
    console.warn('Sincronização falhou, tentando de novo em breve', e);
    erroSync = true;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(sincronizar, 15000);
  } finally {
    sincronizando = false;
    atualizarSync();
  }
}

/* Traz o servidor para este aparelho. Só roda com a fila vazia: com envios pendentes o
   servidor ainda não reflete o que foi feito aqui. Com a fila vazia, o servidor é a fonte
   da verdade (inclusive o que a api/ gravou do Garmin). */
async function baixarDoServidor({ forcar = false } = {}) {
  if (MODO_LOCAL || baixando || !navigator.onLine || fila.length) return;
  if (!forcar && Date.now() - ultimoDownload < 30000) return;
  const token = await tokenAtual().catch(() => null);
  if (!token) return;
  const rev = revisaoFila;
  let dados;
  baixando = true;
  try {
    dados = await buscarTudo();
  } catch (e) {
    console.warn('Não foi possível baixar os dados', e);
    return;
  } finally {
    baixando = false;
  }
  if (fila.length || rev !== revisaoFila) return;
  ultimoDownload = Date.now();

  if (!dados.settings.length) { primeiroAcesso(); return; }
  cache = normalizarDados(dados);
  gravarCache();
  atualizarTelaComDados();
}

function normalizarDados(dados) {
  const c = cacheVazio();
  c.settings = { ...dados.settings[0] };
  ['summary_time', 'weigh_reminder_time'].forEach((k) => {
    if (c.settings[k]) c.settings[k] = String(c.settings[k]).slice(0, 5);
  });
  Object.keys(c).forEach((t) => { if (t !== 'settings' && dados[t]) c[t] = dados[t]; });
  c.meal_types.forEach((m) => { if (m.default_time) m.default_time = String(m.default_time).slice(0, 5); });
  return c;
}

/* Servidor vazio (primeiro login): aproveita o que este aparelho já tem ou cria os dados
   iniciais, e manda tudo pela fila. */
function primeiroAcesso() {
  if (!cache.settings) {
    cache = criarSemente(usuario.id);
  } else {
    Object.keys(cache).forEach((t) => {
      if (t === 'settings') cache.settings.user_id = usuario.id;
      else cache[t].forEach((l) => { l.user_id = usuario.id; });
    });
  }
  gravarCache();
  enfileirarTudo();
  processarFila();
  atualizarTelaComDados();
}

function enfileirarTudo() {
  Object.keys(TABELAS).forEach((t) => {
    if (TABELAS[t].soEnvio) return;
    if (t === 'settings') { if (cache.settings) enfileirarUpsert(t, cache.settings); return; }
    cache[t].forEach((l) => enfileirarUpsert(t, l));
  });
}

async function sincronizar(opcoes) {
  await processarFila();
  await baixarDoServidor(opcoes);
}

function atualizarSync() {
  const n = fila.length;
  let classe = '';
  let texto = 'Salvo';
  let aria = 'Tudo salvo';

  if (MODO_LOCAL) {
    classe = 'is-local'; texto = 'Neste aparelho'; aria = 'Modo local: os dados ficam só neste aparelho';
  } else if (!navigator.onLine) {
    classe = 'is-offline';
    texto = n ? `Offline · ${n}` : 'Offline';
    aria = n ? `Sem conexão. ${n} ${n === 1 ? 'alteração será enviada' : 'alterações serão enviadas'} depois.` : 'Sem conexão.';
  } else if (semSessao && n) {
    classe = 'is-erro'; texto = `Entrar · ${n}`; aria = 'Sessão expirada. Toque para entrar e enviar.';
  } else if (sincronizando) {
    classe = 'is-enviando'; texto = 'Sincronizando'; aria = 'Sincronizando';
  } else if (erroSync && n) {
    classe = 'is-erro'; texto = `Erro · ${n}`; aria = 'Erro ao enviar. Tentando de novo em instantes.';
  }

  document.querySelectorAll('.sync').forEach((el) => {
    el.className = 'sync num ' + classe;
    el.setAttribute('aria-label', aria);
    el.innerHTML = '<span class="ponto" aria-hidden="true"></span><span></span>';
    el.lastChild.textContent = texto;
  });
}

/* ---------- Gravações locais (cache + fila) ---------- */

function novoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Insere ou atualiza uma linha inteira (tabelas que só o app altera). */
function gravarLinha(tabela, linha) {
  linha.user_id = usuario.id;
  let final;
  if (tabela === 'settings') {
    cache.settings = { ...cache.settings, ...linha };
    final = cache.settings;
  } else {
    const k = chaveFila(tabela, linha);
    const lista = cache[tabela];
    const i = lista.findIndex((l) => chaveFila(tabela, l) === k);
    if (i >= 0) lista[i] = { ...lista[i], ...linha }; else lista.push({ ...linha });
    final = i >= 0 ? lista[i] : lista[lista.length - 1];
  }
  gravarCache();
  enfileirarUpsert(tabela, final);
  return final;
}

function apagarLinha(tabela, id) {
  const lista = cache[tabela];
  const i = lista.findIndex((l) => l.id === id);
  if (i < 0) return null;
  const [linha] = lista.splice(i, 1);
  gravarCache();
  enfileirarDelete(tabela, id);
  return linha;
}

/** Registro do dia: envia só as colunas alteradas, para não apagar o que a api/ gravou. */
function salvarDia(data, campos) {
  let log = cache.daily_logs.find((l) => l.date === data);
  if (!log) {
    log = { id: novoId(), user_id: usuario.id, date: data, tags: [] };
    cache.daily_logs.push(log);
  }
  Object.assign(log, campos);
  gravarCache();
  enfileirarUpsert('daily_logs', { id: log.id, user_id: usuario.id, date: data, ...campos });
  processarFila();
  return log;
}

function salvarSettings(campos) {
  gravarLinha('settings', campos);
  processarFila();
}

/* ---------- Dados iniciais (seed) ---------- */

const SEMENTE_ALIMENTOS = [
  // nome, kcal, P, C, G (por 100 g), usos, unidade (g), rótulo da unidade, última vez (g)
  ['Arroz branco cozido', 128, 2.5, 28.1, 0.2, 41, null, null, 220],
  ['Aveia em flocos', 394, 13.9, 66.6, 8.5, 35, null, null, 50],
  ['Azeite de oliva', 884, 0, 0, 100, 44, 8, 'colher', 10],
  ['Banana prata', 98, 1.3, 26.0, 0.1, 52, null, null, 120],
  ['Batata-doce cozida', 77, 0.6, 18.4, 0.1, 22, null, null, 250],
  ['Brócolis cozido', 25, 2.1, 4.4, 0.5, 21, null, null, 80],
  ['Feijão carioca cozido', 76, 4.8, 13.6, 0.5, 30, null, null, 160],
  ['Iogurte natural', 51, 4.1, 1.9, 3.0, 15, 170, 'pote', 170],
  ['Mel', 309, 0, 84.0, 0, 24, null, null, 15],
  ['Ovo inteiro cozido', 146, 13.3, 0.6, 9.5, 40, 50, 'un', 150],
  ['Pão de forma integral', 253, 9.4, 49.9, 3.7, 31, 25, 'fatia', 75],
  ['Pasta de amendoim', 588, 25.1, 20.0, 50.4, 20, null, null, 20],
  ['Patinho grelhado', 219, 35.9, 0, 7.3, 18, null, null, 150],
  ['Peito de frango grelhado', 159, 32.0, 0, 2.5, 38, null, null, 150],
  ['Queijo minas frescal', 264, 17.4, 3.2, 20.2, 19, null, null, 30],
  ['Whey protein', 400, 80, 8, 6, 39, 30, 'scoop', 30],
];

function criarSemente(uid) {
  const inicio = '2026-10-28';
  const refeicoes = [
    ['Café da manhã', '07:00', true], ['Lanche da manhã', '10:00', false], ['Almoço', '12:30', true],
    ['Lanche pré-treino', '16:30', true], ['Pós-treino', '18:30', false], ['Jantar', '19:00', true],
    ['Ceia', '22:00', true],
  ];
  return {
    settings: {
      user_id: uid, display_name: 'Rafael', start_date: inicio, start_weight_kg: 74.0, target_weight_kg: 80.0,
      gain_min_kg: 0.10, gain_ideal_kg: 0.25, gain_max_kg: 0.40, kcal_adjust: 175, skinfold_limit_mm: 1.0,
      surplus_band_min: 200, surplus_band_max: 300, summary_time: '22:30', weigh_reminder_time: '07:00',
      manual_burn_fallback: true, remind_weigh: true, remind_checkin: true, remind_summary: true,
    },
    kcal_targets: [{ id: novoId(), user_id: uid, effective_from: inicio, kcal: 2900, reason: 'Plano inicial' }],
    macro_goals: [
      { id: novoId(), user_id: uid, macro: 'protein', target_g: 166, rule: 'min', low_g: null, high_g: null },
      { id: novoId(), user_id: uid, macro: 'carb', target_g: 400, rule: 'range', low_g: 360, high_g: 440 },
      { id: novoId(), user_id: uid, macro: 'fat', target_g: 90, rule: 'max', low_g: null, high_g: 100 },
    ],
    meal_types: refeicoes.map(([name, default_time, active], i) => ({
      id: novoId(), user_id: uid, name, default_time, active, sort: i + 1,
    })),
    foods: SEMENTE_ALIMENTOS.map(([name, k, p, c, g, uso, un, unLabel, ultima]) => ({
      id: novoId(), user_id: uid, name, kcal_100g: k, protein_100g: p, carb_100g: c, fat_100g: g,
      label_basis: '100g', portion_g: null, unit_g: un, unit_label: unLabel,
      last_grams: ultima, use_count: uso, archived: false,
    })),
    daily_logs: [], meal_entries: [], weekly_checkins: [],
  };
}


/* =====================================================================
   3. ESTADO E UTILIDADES
   ===================================================================== */

const estado = {
  tela: 'hoje',
  data: R.hojeSP(),     // dia escolhido no Hoje (tira dos últimos 7 dias)
  refeicao: null,       // { mealId, data } — tela Refeição
  editandoItens: false,
  semana: null,         // semana escolhida no Resumo da semana
  evoModo: 0,           // 0 Diário · 1 Semanal · 2 Até a meta
  alimentos: { busca: '', ordem: 0 },
  alimento: null,       // rascunho do formulário Novo/Editar alimento
  metas: null,          // rascunho das metas de macros
  checkin: null,        // rascunho do check-in
  add: null,            // sheet Adicionar alimento
  peso: null,           // sheet Peso e gasto
  editor: null,         // sheet genérico de Ajustes
  login: { email: '', erro: '', enviando: false },
  resumoData: null,
  giro: 0,              // ângulo do ícone "Atualizar"
};

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Números em pt-BR ---------- */

const NF = {};
function nf(min, max) {
  const k = min + '-' + max;
  return NF[k] || (NF[k] = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max }));
}
const fmt = {
  int: (n) => nf(0, 0).format(Math.round(n) + 0),
  d1: (n) => nf(1, 1).format(n),
  d2: (n) => nf(2, 2).format(n),
  ate1: (n) => nf(0, 1).format(n),
  ate2: (n) => nf(0, 2).format(n),
};
/** Sinal tipográfico: +0,1 · −0,1 · ±0,0 */
function sinal(n, f = fmt.int, eps = 0.0001) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return (n > eps ? '+' : n < -eps ? '−' : '±') + f(Math.abs(n));
}
const num = (x) => R.numOuNulo(x);
const limparNum = (t, max = 6) => String(t).replace(/[^0-9,.]/g, '').slice(0, max);

/* ---------- Busca na TACO ---------- */

/** Itens da TACO que contêm todas as palavras da busca ("arroz cozido" acha "Arroz, tipo 1, cozido").
    Primeiro os que começam pela busca, depois os que começam pela primeira palavra; dentro de cada grupo, A–Z. */
function buscarNaTaco(busca, limite = 8) {
  if (!taco) return [];
  const q = R.normalizar(busca);
  const palavras = q.split(/[\s,]+/).filter(Boolean);
  if (!palavras.length) return [];
  const nota = (t) => (t.chave.startsWith(q) ? 0 : t.chave.startsWith(palavras[0]) ? 1 : 2);
  return taco.filter((t) => palavras.every((p) => t.chave.includes(p)))
    .sort((a, b) => nota(a) - nota(b) || a.nome.localeCompare(b.nome, 'pt-BR'))
    .slice(0, limite);
}

/** O nome contém todas as palavras da busca (já normalizada)? */
function casaBusca(nome, q) {
  const n = R.normalizar(nome);
  return q.split(/[\s,]+/).filter(Boolean).every((p) => n.includes(p));
}

/** Alimento ativo com o mesmo nome (evita duplicar quem já foi copiado da TACO ou do código de barras). */
function alimentoComNome(nome) {
  const k = R.normalizar(nome);
  return cache.foods.find((f) => !f.archived && R.normalizar(f.name) === k) || null;
}

/** Copia um item (TACO ou código de barras) para "Meus alimentos" e devolve a linha. */
function criarAlimentoDe(base) {
  const linha = {
    id: novoId(), name: base.nome.slice(0, 60),
    kcal_100g: base.kcal, protein_100g: base.p, carb_100g: base.c, fat_100g: base.g,
    label_basis: '100g', portion_g: null, unit_g: null, unit_label: null,
    last_grams: null, use_count: 0, archived: false,
  };
  gravarLinha('foods', linha);
  processarFila();
  return derivados().alimentos.get(linha.id) || linha;
}

/** Texto curto por 100 g de um item da TACO. */
function tacoTexto(t) {
  const v = (x) => fmt.ate1(x || 0);
  return `${fmt.int(t.kcal)} kcal · P ${v(t.p)} · C ${v(t.c)} · G ${v(t.g)}`;
}
const arred = (n, casas = 1) => Math.round(n * 10 ** casas) / 10 ** casas;
/** Valor para um campo de texto: 30 → '30', 2.4 → '2,4'. */
const paraCampo = (n, max = 1) => (n === null || n === undefined || n === '' ? '' : nf(0, max).format(n).replace(/\./g, ''));

/* ---------- Datas em pt-BR ---------- */

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const DIAS_CURTOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const DIAS_PLURAL = ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function partesData(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return { a, m, d, dow: R.diaDaSemana(iso) };
}
/** "Quarta, 9 de dezembro" */
function dataLonga(iso) { const p = partesData(iso); return `${DIAS[p.dow]}, ${p.d} de ${MESES[p.m - 1]}`; }
/** "Quarta, 9 dez" */
function dataMedia(iso) { const p = partesData(iso); return `${DIAS[p.dow]}, ${p.d} ${MESES_CURTOS[p.m - 1]}`; }
/** "9 dez" */
function diaMes(iso) { const p = partesData(iso); return `${p.d} ${MESES_CURTOS[p.m - 1]}`; }
/** "4 – 10 nov" ou "25 nov – 1 dez" */
function intervalo(a, b) {
  const pa = partesData(a);
  const pb = partesData(b);
  if (pa.m === pb.m) return `${pa.d} – ${pb.d} ${MESES_CURTOS[pb.m - 1]}`;
  return `${diaMes(a)} – ${diaMes(b)}`;
}
/** Data no formato do Brasil: 28/10/2026 */
function dataBR(iso) { const p = partesData(iso); return `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}/${p.a}`; }
/** Hora de um timestamp em São Paulo. */
function horaDe(ts) { return ts ? R.horaSP(new Date(ts)) : null; }

/* ---------- Toque e vibração ---------- */

/* navigator.vibrate não existe no Safari do iPhone; lá a resposta tátil vem do <input switch>. */
function vibrar(ms = 10) {
  try { if (typeof navigator.vibrate === 'function') navigator.vibrate(ms); } catch (e) { /* sem suporte */ }
}

/* ---------- Ícones (SVG inline, traço de 1,9 px) ---------- */

const P = {
  mais: '<path d="M12 5v14M5 12h14"/>',
  menos: '<path d="M5 12h14"/>',
  voltar: '<path d="m15 5-7 7 7 7"/>',
  avancar: '<path d="m9 5 7 7-7 7"/>',
  fechar: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  fogo: '<path d="M12 3c.6 3 4.5 5 4.5 9.5a4.5 4.5 0 0 1-9 0c0-1.8.7-3.1 1.7-4.2.2 1.5 1.1 2.5 2.2 2.6-1.1-2.8-.3-5.6.6-7.9z"/>',
  alvo: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/>',
  balanca: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.3 10.2a5 5 0 0 1 7.4 0"/><path d="M12 10.4l1.5-2.1"/>',
  regua: '<path d="M3.5 15.5 15.5 3.5l5 5-12 12z"/><path d="M8 11l1.6 1.6M10.6 8.4l1.6 1.6M13.2 5.8l1.6 1.6"/>',
  lua: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  raio: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  atualizar: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  gota: '<path d="M12 3.5c3 3.6 5.5 6.6 5.5 10a5.5 5.5 0 0 1-11 0c0-3.4 2.5-6.4 5.5-10z"/>',
  relogio: '<circle cx="12" cy="12" r="6"/><path d="M9 3.5h6M9 20.5h6M12 9.5V12l1.5 1.5"/>',
  importar: '<path d="M12 15V4M7 9l5-5 5 5M5 20h14"/>',
  exportar: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  lixo: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  sair: '<path d="M14 5h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h9"/>',
  sino: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5h4"/>',
  cima: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  baixo: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  espera: '<path d="M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"/>',
  bandeira: '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>',
  exclamacao: '<path d="M12 6v8M12 18h.01"/>',
  atencao: '<path d="M12 7v6M12 17h.01"/>',
  busca: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  codigo: '<path d="M4 7V5h3M17 5h3v2M20 17v2h-3M7 19H4v-2M8 8v8M11 8v8M14 8v8M17 8v8"/>',
};
const PONTOS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></svg>';

function ic(d, tam = 20, sw = 1.9, extra = '') {
  return `<svg class="ic" width="${tam}" height="${tam}" viewBox="0 0 24 24" stroke-width="${sw}" aria-hidden="true"${extra}>${d}</svg>`;
}

/* ---------- Dados derivados (recalculados só quando o cache muda) ---------- */

let memo = { rev: -1 };

function derivados() {
  if (memo.rev === revisao) return memo;
  const pesos = {};
  const gasto = {};
  const logs = new Map();
  cache.daily_logs.forEach((l) => {
    logs.set(l.date, l);
    if (num(l.weight_kg) !== null) pesos[l.date] = num(l.weight_kg);
    if (num(l.kcal_burned) !== null) gasto[l.date] = num(l.kcal_burned);
  });
  const entradas = new Map();
  cache.meal_entries.forEach((e) => {
    if (!entradas.has(e.date)) entradas.set(e.date, []);
    entradas.get(e.date).push(e);
  });
  entradas.forEach((lista) => lista.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))));
  const kcal = {};
  const totais = new Map();
  entradas.forEach((lista, data) => {
    const t = R.somarItens(lista);
    totais.set(data, t);
    kcal[data] = t.kcal;
  });
  const medidas = {};
  const checkins = new Map();
  cache.weekly_checkins.forEach((c) => {
    checkins.set(c.week_number, c);
    medidas[c.week_number] = medidasDoCheckin(c);
  });
  const alimentos = new Map(cache.foods.map((f) => [f.id, f]));
  const refeicoes = new Map(cache.meal_types.map((m) => [m.id, m]));
  memo = { rev: revisao, pesos, gasto, kcal, logs, entradas, totais, medidas, checkins, alimentos, refeicoes };
  return memo;
}

const CAMPOS_FITA = {
  braco: 'arm_cm', ombros: 'shoulders_cm', peitoral: 'chest_cm', abdomen: 'abdomen_cm',
  coxa: 'thigh_cm', gluteos: 'glutes_cm', panturrilha: 'calf_cm',
};

function medidasDoCheckin(c) {
  const m = {};
  Object.entries(CAMPOS_FITA).forEach(([k, col]) => { m[k] = num(c[col]); });
  m.dobra = R.media([num(c.skinfold_1_mm), num(c.skinfold_2_mm), num(c.skinfold_3_mm)]);
  return m;
}

function cfg() {
  const s = cache.settings;
  return {
    inicio: s.start_date,
    pesoInicial: num(s.start_weight_kg),
    pesoAlvo: num(s.target_weight_kg),
    ganhoMin: num(s.gain_min_kg),
    ganhoIdeal: num(s.gain_ideal_kg),
    ganhoMax: num(s.gain_max_kg),
    ajusteKcal: num(s.kcal_adjust),
    limiteDobra: num(s.skinfold_limit_mm),
    saldoMin: num(s.surplus_band_min),
    saldoMax: num(s.surplus_band_max),
  };
}

const logDo = (data) => derivados().logs.get(data) || null;
const entradasDo = (data) => derivados().entradas.get(data) || [];
const totaisDo = (data) => derivados().totais.get(data) || { kcal: 0, p: 0, c: 0, g: 0 };
const semanaAtual = () => Math.max(1, R.semana(R.hojeSP(), cfg().inicio));

function metaKcalEm(iso) {
  const m = R.metaVigente(cache.kcal_targets, iso);
  if (m) return num(m.kcal);
  const ord = [...cache.kcal_targets].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  return ord.length ? num(ord[0].kcal) : 2900;
}

function metasMacro() {
  const m = {};
  cache.macro_goals.forEach((g) => { m[g.macro] = g; });
  return m;
}

function semanas() {
  const d = derivados();
  const hoje = R.hojeSP();
  if (d.semanas && d.semanasHoje === hoje) return d.semanas;
  d.semanas = R.calcularSemanas(cfg(), { pesos: d.pesos, kcal: d.kcal, gasto: d.gasto, medidas: d.medidas, meta: metaKcalEm }, semanaAtual());
  d.semanasHoje = hoje;
  return d.semanas;
}

/** Status mais recente (a semana em curso ainda não tem ritmo próprio). */
function statusRecente(ate) {
  const s = semanas();
  for (let i = Math.min(ate, s.length) - 1; i >= 0; i--) if (s[i].status) return s[i].status;
  return null;
}

function pesoReferencia() {
  const d = derivados();
  const hoje = R.hojeSP();
  const m = R.mediaPeso7(d.pesos, hoje);
  if (m !== null) return m;
  const ant = R.pesoAnterior(d.pesos, R.somarDias(hoje, 1));
  return ant ? ant.peso : cfg().pesoInicial;
}

/* ---------- Refeições ---------- */

const CURTOS = {
  'café da manhã': 'Café', 'lanche da manhã': 'Lanche m.', 'lanche pré-treino': 'Lanche',
  'pós-treino': 'Pós', 'lanche da tarde': 'Lanche t.',
};
function curto(nome) {
  const k = String(nome || '').toLowerCase();
  if (CURTOS[k]) return CURTOS[k];
  const p = String(nome || '').split(/\s+/)[0];
  return p.length > 8 ? p.slice(0, 7) + '.' : p;
}
/** "ao almoço", "à ceia" */
function artigo(nome) {
  const w = R.normalizar(nome).split(/[\s-]+/)[0];
  return /a$/.test(w) ? 'à' : 'ao';
}
const minuscula = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

const OUTROS = 'outros';   // itens sem refeição (importados da planilha)

/** Refeições do dia: as ativas e as desligadas que tiverem itens naquele dia. */
function refeicoesDoDia(data) {
  const itens = entradasDo(data);
  const comItens = new Set(itens.map((e) => e.meal_type_id || OUTROS));
  const lista = cache.meal_types
    .filter((m) => m.active || comItens.has(m.id))
    .sort((a, b) => (a.sort - b.sort) || String(a.default_time).localeCompare(String(b.default_time)));
  if (comItens.has(OUTROS) || itens.some((e) => e.meal_type_id && !derivados().refeicoes.has(e.meal_type_id))) {
    lista.push({ id: OUTROS, name: 'Outros', default_time: null, active: false });
  }
  return lista;
}

function itensDaRefeicao(data, mealId) {
  const conhecidas = derivados().refeicoes;
  return entradasDo(data).filter((e) => (mealId === OUTROS
    ? !e.meal_type_id || !conhecidas.has(e.meal_type_id)
    : e.meal_type_id === mealId));
}

/** Refeição do horário atual: a última cujo horário já passou. */
function refeicaoAgora(lista) {
  const agora = R.minutos(R.horaSP());
  const comHora = lista.filter((m) => m.id !== OUTROS && m.default_time && m.active);
  let atual = comHora[0] || lista[0] || null;
  comHora.forEach((m) => { if (R.minutos(m.default_time) <= agora) atual = m; });
  return atual;
}

function nomeRefeicao(mealId) {
  if (mealId === OUTROS) return 'Outros';
  const m = derivados().refeicoes.get(mealId);
  return m ? m.name : 'Refeição';
}

/* ---------- Avisos (toast) ---------- */

let avisoTimer = null;
function aviso(texto, { acao = null, fn = null, duracao = 4500 } = {}) {
  const el = $('#aviso');
  el.firstChild.textContent = texto;
  const b = el.lastChild;
  b.hidden = !acao;
  b.textContent = acao || '';
  b.onclick = acao ? () => { esconderAviso(); fn(); } : null;
  el.classList.toggle('sem-abas', !ABAS.has(estado.tela) || !!sheetAtual);
  el.classList.add('is-aberto');
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(esconderAviso, duracao);
}
function esconderAviso() { $('#aviso').classList.remove('is-aberto'); }


/* =====================================================================
   4. TELAS
   Cada renderX() redesenha a tela a partir de cache e estado. Texto
   digitado pelo usuário sempre passa por esc().
   ===================================================================== */

/* ---------- Componentes reaproveitados ---------- */

/** Anel de progresso: pathLength 100, dashoffset = 100 − %. */
function anelHTML({ pct, tam = 104, r = 43, sw = 11, trilho = 'var(--kcal-trilho)', cor = 'var(--kcal)', rotulo, centro }) {
  const off = Math.max(0, 100 - Math.min(100, pct));
  const c = tam / 2;
  return `<div class="anel" role="img" aria-label="${esc(rotulo)}" style="width:${tam}px;height:${tam}px">
    <svg width="${tam}" height="${tam}" viewBox="0 0 ${tam} ${tam}" aria-hidden="true">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:${trilho}" stroke-width="${sw}"/>
      <circle class="anel-arco" cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:${cor}" stroke-width="${sw}" stroke-linecap="round"
        pathLength="100" stroke-dasharray="100" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 ${c} ${c})"/>
    </svg>
    <span class="anel-centro">${centro}</span>
  </div>`;
}

const MACROS = [
  { k: 'protein', nome: 'Proteína', curto: 'P', t: 'p', cor: 'var(--prot)', fill: 'bg-prot', chip: 'c-violeta', f: 4 },
  { k: 'carb', nome: 'Carboidratos', curto: 'C', t: 'c', cor: 'var(--carb)', fill: 'bg-carb', chip: 'c-carb', f: 4 },
  { k: 'fat', nome: 'Gordura', curto: 'G', t: 'g', cor: 'var(--gord)', fill: 'bg-gord', chip: 'c-gord', f: 9 },
];

/* Escala da barra: a meta fica a 75–83% do trilho e o limite (se houver) também cabe. */
function escalaMacro(meta) {
  const alvo = num(meta.target_g) || 1;
  if (meta.rule === 'max') return (num(meta.high_g) || alvo) * 1.1;
  if (meta.rule === 'range') return Math.max(alvo * 1.2, (num(meta.high_g) || 0) * 1.05);
  return alvo / 0.755;
}

function chipMacro(m, meta, valor) {
  const st = R.statusMacro(meta, valor);
  const ok = (t) => `<span class="chip chip-icone c-ok">${ic(P.check, 12, 3)}${t}</span>`;
  if (meta.rule === 'min') return st.ok ? ok('mínimo batido') : `<span class="chip num ${m.chip}">faltam ${fmt.int(st.falta)} g</span>`;
  if (st.excesso > 0) return `<span class="chip num c-alerta">passou ${fmt.int(st.excesso)} g</span>`;
  if (meta.rule === 'range') return st.ok ? ok('na faixa') : `<span class="chip num ${m.chip}">faltam ${fmt.int(st.falta)} g</span>`;
  return st.falta > 0.5 ? `<span class="chip num ${m.chip}">faltam ${fmt.int(st.falta)} g</span>` : ok('na meta');
}

function barraMacroHTML(m, meta, valor) {
  const escala = escalaMacro(meta);
  const pos = (v) => Math.max(0, Math.min(100, (v / escala) * 100));
  const alvo = num(meta.target_g) || 0;
  const fill = `transform: translateX(${(pos(valor) - 100).toFixed(1)}%)`;
  const marca = `<span class="barra-marca" style="left:${pos(alvo).toFixed(1)}%"></span>`;
  let rot;
  if (meta.rule === 'range') rot = `${m.nome} ${fmt.int(valor)} gramas, meta ${fmt.int(alvo)}, faixa ${fmt.int(num(meta.low_g))} a ${fmt.int(num(meta.high_g))}`;
  else if (meta.rule === 'max') rot = `${m.nome} ${fmt.int(valor)} gramas, meta ${fmt.int(alvo)}, máximo ${fmt.int(num(meta.high_g))}`;
  else rot = `${m.nome} ${fmt.int(valor)} gramas, mínimo ${fmt.int(alvo)}`;

  if (meta.rule === 'max') {
    const lim = pos(num(meta.high_g) || alvo);
    return `<div class="barra gord" role="img" aria-label="${rot}">
      <span class="barra-zona zona-limite" style="left:${lim.toFixed(1)}%"></span>
      <div class="barra-fill ${m.fill}" style="position:absolute;left:0;top:0;${fill}"></div>${marca}</div>`;
  }
  const zona = meta.rule === 'range'
    ? `<span class="barra-zona zona-carb" style="left:${pos(num(meta.low_g)).toFixed(1)}%;width:${(pos(num(meta.high_g)) - pos(num(meta.low_g))).toFixed(1)}%"></span>` : '';
  return `<div class="barra" role="img" aria-label="${rot}">${zona}
    <div class="barra-clip"><div class="barra-fill ${m.fill}" style="${fill}"></div></div>${marca}</div>`;
}

function valorMacroHTML(meta, valor) {
  const alvo = fmt.int(num(meta.target_g) || 0);
  const extra = meta.rule === 'max' && num(meta.high_g) !== null ? ` · máx. ${fmt.int(num(meta.high_g))}` : '';
  return `${fmt.int(valor)} <span>/ ${alvo} g${extra}</span>`;
}

function segmentadoHTML({ acao, opcoes, sel, rotulo, escuro = false }) {
  const n = opcoes.length;
  return `<div class="segmentado${escuro ? ' escuro' : ''}" role="group" aria-label="${esc(rotulo)}">
    <span class="seg-ind" aria-hidden="true" style="width: calc((100% - 6px) / ${n}); transform: translateX(${sel * 100}%)"></span>
    ${opcoes.map((o, i) => `<button type="button" class="seg-btn press" data-acao="${acao}" data-i="${i}" aria-pressed="${i === sel}">${esc(o)}</button>`).join('')}
  </div>`;
}

/* Interruptor: <input switch> nativo do Safari 17.4+ (dá a resposta tátil), com o visual do design. */
function chaveHTML(id, ligado, attrs = '') {
  return `<input type="checkbox" switch role="switch" class="chave" id="${id}" ${ligado ? 'checked' : ''} ${attrs}>`;
}

function syncHTML() { return '<button type="button" class="sync num" data-acao="sync"></button>'; }

/* ---------- 4a. Entrar ---------- */

function renderLogin() {
  const l = estado.login;
  const erro = l.erro ? `<p class="msg-erro" role="alert">${esc(l.erro)}</p>` : '';
  const corpo = `
      <label class="rotulo" for="login-email">E-mail</label>
      <div class="campo-grande"><input id="login-email" type="email" inputmode="email" autocomplete="username"
        autocapitalize="off" enterkeyhint="next" required value="${esc(l.email)}" placeholder="voce@exemplo.com"></div>
      <label class="rotulo" for="login-senha">Senha</label>
      <div class="campo-grande"><input id="login-senha" type="password" autocomplete="current-password"
        autocapitalize="off" enterkeyhint="go" required></div>
      ${erro}
      <button type="submit" class="btn-principal press" ${l.enviando ? 'disabled' : ''}>${l.enviando ? 'Entrando…' : 'Entrar'}</button>`;
  $('#login').innerHTML = `
    <div class="login-marca">
      <img src="icons/icon-192.png" alt="" width="72" height="72">
      <h1 id="login-h" class="titulo">BodyEvo</h1>
      <p>Bulking leve, um dia de cada vez. Entre com seu e-mail para guardar e sincronizar seus dados.</p>
    </div>
    <form class="cartao" data-form="login" novalidate>${corpo}</form>
    <p class="msg-suave">O app continua funcionando sem internet depois do primeiro acesso.</p>`;
}

async function enviarLogin() {
  const l = estado.login;
  if (l.enviando) return;
  l.erro = '';
  const email = $('#login-email').value.trim().toLowerCase();
  const senha = $('#login-senha').value;
  l.email = email;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { l.erro = 'Confira o e-mail.'; renderLogin(); return; }
  if (!senha) { l.erro = 'Digite a senha.'; renderLogin(); $('#login-senha').focus(); return; }
  l.enviando = true; renderLogin();
  try {
    const sessao = await entrarComSenha(email, senha);
    l.enviando = false;
    entrar(sessao.user);
  } catch (e) {
    l.enviando = false;
    const codigo = e && e.code;
    l.erro = !navigator.onLine ? 'Sem conexão. O primeiro acesso precisa de internet.'
      : codigo === 'email_not_confirmed' ? 'E-mail ainda não confirmado. No Supabase, abra Authentication › Users e confirme o usuário.'
      : codigo === 'over_request_rate_limit' || (e && e.status === 429) ? 'Muitas tentativas. Espere alguns minutos e tente de novo.'
      : (e && e.status === 400) ? 'E-mail ou senha incorretos.'
      : 'Não deu para entrar. Tente de novo em instantes.';
    renderLogin();
    $('#login-senha').focus();
  }
}

/** Sessão válida: guarda o usuário (para abrir offline) e carrega os dados. */
function entrar(user) {
  if (usuario && usuario.id !== user.id) {
    cache = cacheVazio(); fila = []; gravarCache(); gravarFila();
  }
  usuario = { id: user.id, email: user.email };
  store.gravar(CHAVES.usuario, usuario);
  semSessao = false;
  estado.login = { email: '', erro: '', enviando: false };
  if (estado.tela === 'login') {
    history.replaceState({ tela: 'hoje' }, '', '#hoje');
    mostrar('hoje', { animar: false });
  }
  sincronizar({ forcar: true });
}

async function sair() {
  if (fila.length && !confirm(`Há ${fila.length} alteração(ões) ainda não enviadas. Se sair agora, elas se perdem. Sair mesmo assim?`)) return;
  await sairDaConta();
  cache = cacheVazio(); fila = []; usuario = null;
  store.apagar(CHAVES.usuario); gravarCache(); gravarFila();
  history.replaceState({ tela: 'login' }, '', '#login');
  mostrar('login', { animar: false });
}

/* ---------- 4b. Hoje ---------- */

function carregandoHTML() {
  return `<header class="cabecalho"><div class="linha-sobretitulo"><p class="sobretitulo">Carregando seus dados…</p>${syncHTML()}</div>
    <h1 class="titulo">BodyEvo</h1></header>
    <div class="cartao"><p class="texto-14">Buscando o que já está salvo. Na primeira vez, o app cria suas metas, refeições e alimentos.</p></div>`;
}

function renderHoje() {
  const el = $('#hoje');
  if (!cache.settings) { el.innerHTML = carregandoHTML(); atualizarSync(); return; }
  const c = cfg();
  const hoje = R.hojeSP();
  if (estado.data > hoje) estado.data = hoje;
  const data = estado.data;
  const ehHoje = data === hoje;
  const d = derivados();
  const w = R.semana(data, c.inicio);
  const log = logDo(data);
  const tot = totaisDo(data);
  const meta = metaKcalEm(data);
  const metas = metasMacro();
  const gasto = log && num(log.kcal_burned) !== null ? num(log.kcal_burned) : null;
  const pct = meta ? Math.round((tot.kcal / meta) * 100) : 0;
  const falta = meta - tot.kcal;

  // Tira dos últimos 7 dias
  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const iso = R.somarDias(hoje, -i);
    const p = partesData(iso);
    const pesou = d.pesos[iso] !== undefined;
    const cls = ['dia', 'press', iso === hoje ? 'is-hoje' : '', iso === data ? 'is-sel' : '', !pesou && iso !== hoje ? 'sem-peso' : ''].join(' ');
    const rot = iso === hoje ? `Hoje, ${DIAS[p.dow].toLowerCase()} ${p.d}` : `${DIAS[p.dow]}, ${p.d} — ${pesou ? 'registrado' : 'sem pesagem'}`;
    dias.push(`<li><button type="button" class="${cls}" data-acao="escolher-dia" data-data="${iso}" aria-pressed="${iso === data}" aria-label="${rot}"${iso === hoje ? ' aria-current="date"' : ''}>
      <span class="dia-nome">${iso === hoje ? 'Hoje' : DIAS_CURTOS[p.dow]}</span>
      <span class="dia-num num">${p.d}${pesou && iso !== hoje ? '<span class="marca-peso"></span>' : ''}</span></button></li>`);
  }

  // Gasto: Garmin, manual ou pendente (fallback das 21:30)
  const pedirManual = ehHoje && cache.settings.manual_burn_fallback && gasto === null
    && R.minutos(R.horaSP()) >= R.minutos('21:30');
  let caixaGasto;
  if (gasto !== null && log.burned_source === 'manual') {
    caixaGasto = `<span class="rotulo-12"><span class="ponto cinza" aria-hidden="true"></span>Manual</span><span class="valor num">${fmt.int(gasto)} <small>gastas</small></span>`;
  } else if (gasto !== null) {
    caixaGasto = `<span class="rotulo-12"><span class="ponto ok" aria-hidden="true"></span>Garmin ${horaDe(log.garmin_synced_at) || ''}</span><span class="valor num">${fmt.int(gasto)} <small>gastas</small></span>`;
  } else {
    caixaGasto = `<span class="rotulo-12">Gastas</span><span class="valor num">— <small>informar</small></span>`;
  }

  const macros = MACROS.map((m) => {
    const meta2 = metas[m.k];
    if (!meta2) return '';
    const v = tot[m.t];
    return `<div class="macro">
      <div class="macro-linha"><span class="macro-nome">${m.nome}</span><span class="macro-val num">${valorMacroHTML(meta2, v)}</span>${chipMacro(m, meta2, v)}</div>
      ${barraMacroHTML(m, meta2, v)}</div>`;
  }).join('');

  const alerta = pedirManual ? `<div class="dica alerta">${ic(P.raio, 18)}<span>O Garmin não sincronizou hoje. Informe o gasto do dia.</span>
    <button type="button" class="btn-mini press" data-acao="abrir-peso" data-manual="1">Informar</button></div>` : '';

  // Refeições
  const lista = refeicoesDoDia(data);
  const agora = ehHoje ? refeicaoAgora(lista) : null;
  const minAgora = R.minutos(R.horaSP());
  const vazias = lista.filter((m) => !itensDaRefeicao(data, m.id).length
    && (!ehHoje || m === agora || R.minutos(m.default_time) >= minAgora));
  const porVazia = falta > 0 && vazias.length ? falta / vazias.length : 0;
  const refeicoes = lista.map((m) => {
    const itens = itensDaRefeicao(data, m.id);
    const ehAgora = agora && m.id === agora.id;
    const hora = itens.length && itens[0].created_at ? horaDe(itens[0].created_at) : m.default_time;
    const tag = ehAgora ? '<span class="tag-agora">agora</span>' : (hora ? `<span class="ref-hora num">${hora}</span>` : '');
    const art = artigo(m.name);
    if (!itens.length) {
      const resto = vazias.includes(m) && porVazia > 0 ? `Nada ainda · cabem ~${fmt.int(porVazia)} kcal` : 'Nada registrado';
      return `<div class="refeicao vazia${ehAgora ? ' is-agora' : ''}">
        <div class="ref-vazia-texto"><span class="ref-linha1"><span class="ref-nome">${esc(m.name)}</span>${tag}</span>
        <span class="ref-itens num">${resto}</span></div>
        <button type="button" class="btn-adicionar press hit" data-acao="abrir-add" data-meal="${m.id}" aria-label="Adicionar alimento ${art} ${esc(minuscula(m.name))}">${ic(P.mais, 16, 2.4)}Adicionar</button></div>`;
    }
    const t = R.somarItens(itens);
    const nomes = [...new Set(itens.map((e) => e.food_name || 'Alimento'))].map((n, i) => (i ? minuscula(n) : n)).join(', ');
    return `<div class="refeicao${ehAgora ? ' is-agora' : ''}">
      <button type="button" class="ref-corpo press" data-acao="abrir-refeicao" data-meal="${m.id}">
        <span class="ref-linha1"><span class="ref-nome">${esc(m.name)}</span>${tag}<span class="ref-kcal num">${fmt.int(t.kcal)} <small>kcal</small></span></span>
        <span class="ref-itens reticencias">${esc(nomes)}</span>
        <span class="ref-macros num"><span class="t-prot">P ${fmt.int(t.p)}</span><span class="t-carb">C ${fmt.int(t.c)}</span><span class="t-gord">G ${fmt.int(t.g)}</span></span>
      </button>
      <button type="button" class="ref-mais press" data-acao="abrir-add" data-meal="${m.id}" aria-label="Adicionar alimento ${art} ${esc(minuscula(m.name))}"><span>${ic(P.mais, 18, 2.2)}</span></button>
    </div>`;
  }).join('');

  // Peso
  const peso = d.pesos[data];
  const ant = R.pesoAnterior(d.pesos, data);
  const media7 = R.mediaPeso7(d.pesos, data);
  let subPeso = 'Toque para registrar · em jejum';
  if (peso !== undefined) {
    const partes = [];
    if (ant) partes.push(`${sinal(peso - ant.peso, fmt.d1)} vs ${ant.data === R.somarDias(data, -1) ? 'ontem' : diaMes(ant.data)}`);
    if (media7 !== null) partes.push(`média 7 dias ${fmt.d2(media7)}`);
    subPeso = partes.join(' · ') || 'Primeira pesagem';
  }
  const st = statusRecente(w);
  const chipSt = !st ? '' : ({
    no_ritmo: `<span class="chip chip-26 chip-icone c-ok">${ic(P.check, 13, 2.8)}No ritmo</span>`,
    adaptacao: '<span class="chip chip-26 c-violeta">Adaptação</span>',
    abaixo: `<span class="chip chip-26 chip-icone c-alerta">${ic(P.cima, 13, 2.8)}Abaixo</span>`,
    rapido: `<span class="chip chip-26 chip-icone c-alerta">${ic(P.baixo, 13, 2.8)}Rápido</span>`,
  })[st.codigo];

  // Check-in (só no 1º dia da semana)
  let checkin = '';
  if (R.ehDiaDeCheckin(data, c.inicio)) {
    const ck = d.checkins.get(w);
    const feitas = ck ? contarMedidas(ck) : 0;
    const sub = feitas >= 8 ? 'Check-in feito · toque para revisar'
      : feitas ? `${feitas} de 8 medidas · toque para completar` : '7 medidas com fita + dobra abdominal';
    checkin = `<button type="button" class="banner-checkin press" data-acao="abrir-checkin" data-semana="${w}">
      <span class="icone-44">${ic(P.regua, 22, 1.8)}</span>
      <span class="cl-texto"><span class="cl-titulo">Dia de check-in semanal</span><span class="cl-sub">${sub}</span></span>
      ${ic(P.avancar, 20, 2)}</button>`;
  }

  const fechado = log && log.closed_at;
  const subFechar = fechado ? 'Dia fechado · ver o resumo'
    : ehHoje ? `O resumo abre sozinho às ${cache.settings.summary_time}` : 'Ver o resumo do dia';

  const dica = textoParaFechar(tot, metas);
  const titulo = w >= 1 ? `Semana ${w} do bulking` : `Começa em ${diaMes(c.inicio)}`;

  // Guarda os valores do anel e das barras para animar só a mudança (600 ms).
  const antes = el.dataset.data === data ? {
    anel: $('.anel-arco', el) && $('.anel-arco', el).getAttribute('stroke-dashoffset'),
    fills: $$('.macros .barra-fill', el).map((f) => f.style.transform),
  } : null;

  el.innerHTML = `
    <header class="cabecalho">
      <div class="linha-sobretitulo"><p class="sobretitulo">${dataLonga(data)}</p>${syncHTML()}</div>
      <h1 class="titulo">${titulo}</h1>
    </header>
    <ol class="dias" aria-label="Últimos 7 dias">${dias.join('')}</ol>

    <section class="cartao" aria-labelledby="energia-h">
      <div class="energia-topo">
        <div class="energia-titulo"><span class="icone-32 icone-kcal">${ic(P.fogo, 18)}</span>
          <h2 id="energia-h" class="h2-16">${ehHoje ? 'Energia de hoje' : 'Energia do dia'}</h2></div>
        <button type="button" class="btn-chip press hit" data-acao="ir" data-tela="metas">Metas</button>
      </div>
      <div class="energia-corpo">
        <div class="energia-esq">
          <div class="col2"><span class="rotulo-12">Consumidas nas refeições</span>
            <p class="numero-grande num"><span class="n">${fmt.int(tot.kcal)}</span><span class="de">/ ${fmt.int(meta)} kcal</span></p></div>
          <div class="mini-caixas">
            <button type="button" class="mini-caixa press${pedirManual ? ' alerta' : ''}" data-acao="abrir-peso"${pedirManual ? ' data-manual="1"' : ''}>${caixaGasto}</button>
            <div class="mini-caixa kcal"><span class="rotulo-12">${falta >= 0 ? 'Faltam' : 'Passou'}</span>
              <span class="valor num">${fmt.int(Math.abs(falta))} <small>kcal</small></span></div>
          </div>
        </div>
        ${anelHTML({ pct, rotulo: `${pct}% da meta de calorias`, centro: `<span class="anel-pct num">${pct}%</span><span class="anel-sub">da meta</span>` })}
      </div>
      <div class="macros">${macros}</div>
      ${alerta}
      <p class="dica">${ic(P.alvo, 18)}<span>${dica}</span></p>
    </section>

    <div class="secao-titulo"><h2 class="h2-20">Refeições</h2>
      <button type="button" class="link hit" data-acao="ir" data-tela="alimentos">Meus alimentos</button></div>
    ${refeicoes}
    <button type="button" class="btn-fantasma press" data-acao="aba" data-aba="ajustes">${ic(P.mais, 18, 2)}Refeição extra ou editar refeições</button>

    <button type="button" class="cartao-linha press mt4" data-acao="abrir-peso">
      <span class="icone-40 icone-violeta">${ic(P.balanca, 20)}</span>
      <span class="cl-texto"><span class="peso-linha"><span class="cl-titulo">${ehHoje ? 'Peso hoje' : 'Peso do dia'}</span>
        <span class="peso-valor num">${peso !== undefined ? fmt.d1(peso) + ' kg' : '—'}</span></span>
        <span class="cl-sub num">${subPeso}</span></span>
      ${chipSt}
    </button>
    ${checkin}
    <button type="button" class="cartao-linha press hov" data-acao="abrir-resumo">
      <span class="icone-40 icone-neutro">${ic(P.lua, 20)}</span>
      <span class="cl-texto"><span class="cl-titulo">Fechar o dia</span><span class="cl-sub">${subFechar}</span></span>
      ${ic(P.avancar, 20, 2)}</button>`;
  el.dataset.data = data;
  atualizarSync();

  if (antes && antes.anel !== null) animarValores(el, antes);
}

/** Anel e barras partem do valor antigo e vão até o novo (só quando mudou). */
function animarValores(el, antes) {
  const arco = $('.anel-arco', el);
  const fills = $$('.macros .barra-fill', el);
  const novoAnel = arco.getAttribute('stroke-dashoffset');
  const novos = fills.map((f) => f.style.transform);
  if (antes.anel === novoAnel && antes.fills.every((t, i) => t === novos[i])) return;
  arco.style.transition = 'none';
  arco.style.strokeDashoffset = antes.anel;
  fills.forEach((f, i) => { f.style.transition = 'none'; if (antes.fills[i]) f.style.transform = antes.fills[i]; });
  el.getBoundingClientRect();
  requestAnimationFrame(() => {
    arco.style.transition = '';
    arco.style.strokeDashoffset = novoAnel;
    fills.forEach((f, i) => { f.style.transition = ''; f.style.transform = novos[i]; });
  });
}

/** "Para fechar o dia": o que falta de carboidrato e gordura até a meta. */
function textoParaFechar(tot, metas) {
  if (!tot.kcal) return 'Comece pelo café da manhã: toque em + e pese o primeiro alimento.';
  const fc = metas.carb ? R.statusMacro(metas.carb, tot.c).falta : 0;
  const fg = metas.fat ? R.statusMacro(metas.fat, tot.g).falta : 0;
  const fp = metas.protein ? R.statusMacro(metas.protein, tot.p).falta : 0;
  const c = fc >= 1 ? `${fmt.int(fc)} g de carboidrato` : '';
  const g = fg >= 1 ? `${fmt.int(fg)} g de gordura` : '';
  if (c && g) return `Para fechar o dia: cerca de ${c} e ${g}.`;
  if (c || g) return `Para fechar o dia: cerca de ${c || g}.`;
  if (fp >= 1) return `Falta proteína: cerca de ${fmt.int(fp)} g para o mínimo.`;
  return 'Macros do dia fechados. Agora é só manter.';
}

function contarMedidas(ck) {
  const m = medidasDoCheckin(ck);
  const leituras = [ck.skinfold_1_mm, ck.skinfold_2_mm, ck.skinfold_3_mm].filter((x) => num(x) !== null).length;
  return Object.keys(CAMPOS_FITA).filter((k) => m[k] !== null).length + (leituras === 3 ? 1 : 0);
}

/* ---------- 4c. Sheet: peso e gasto do dia ---------- */

const MARCADORES = [
  ['longao', 'Longão'], ['perna', 'Treino de perna'], ['fora', 'Comi fora'], ['sono', 'Dormi mal'], ['sal', 'Muito sal'],
];

function abrirPeso({ manual = false } = {}) {
  if (!cache.settings) return;
  const data = estado.tela === 'hoje' ? estado.data : R.hojeSP();
  const d = derivados();
  const log = logDo(data);
  const registrado = d.pesos[data];
  const ant = R.pesoAnterior(d.pesos, data);
  const inicial = registrado !== undefined ? registrado : (ant ? ant.peso : cfg().pesoInicial);
  estado.peso = {
    data,
    texto: fmt.d1(inicial),
    tocado: false,
    registrado: registrado !== undefined,
    manual: manual || !!(log && log.burned_source === 'manual'),
    kout: log && log.burned_source === 'manual' && num(log.kcal_burned) !== null ? String(Math.round(log.kcal_burned)) : '',
    tags: new Set((log && log.tags) || []),
    nota: (log && log.note) || '',
  };
  $('#peso-h').textContent = data === R.hojeSP() ? 'Peso e gasto de hoje' : 'Peso e gasto do dia';
  $('#peso-sub').textContent = `${dataMedia(data)} · dia ${R.diasEntre(cfg().inicio, data) + 1}`;
  renderPeso();
  abrirSheet($('#sheet-peso'));
}

function gastoAtualDoSheet() {
  const p = estado.peso;
  const log = logDo(p.data);
  if (p.manual) return num(p.kout);
  if (log && log.burned_source !== 'manual' && num(log.kcal_burned) !== null) return num(log.kcal_burned);
  return garminTotal(log);
}

function garminTotal(log) {
  if (!log || !log.garmin_synced_at) return null;
  const a = num(log.garmin_active_kcal);
  const b = num(log.garmin_bmr_kcal);
  return a === null && b === null ? null : (a || 0) + (b || 0);
}

function notaPeso() {
  const p = estado.peso;
  const d = derivados();
  const n = num(p.texto);
  if (!p.registrado && !p.tocado) return 'Ainda sem pesagem neste dia · ajuste e salve';
  if (n === null) return 'Digite o peso em kg';
  const ant = R.pesoAnterior(d.pesos, p.data);
  const pesos = { ...d.pesos, [p.data]: n };
  const m7 = R.mediaPeso7(pesos, p.data);
  const vs = ant ? `${sinal(n - ant.peso, fmt.d1)} kg vs ${ant.data === R.somarDias(p.data, -1) ? 'ontem' : diaMes(ant.data)}` : 'primeira pesagem';
  return `${vs} · média 7 dias ${fmt.d2(m7)}`;
}

function renderPeso() {
  const p = estado.peso;
  const log = logDo(p.data);
  const ingeridas = totaisDo(p.data).kcal;
  const gastas = gastoAtualDoSheet();
  const temGarmin = !!(log && log.garmin_synced_at);
  const horaG = temGarmin ? horaDe(log.garmin_synced_at) : null;

  let fonte;
  if (p.manual) fonte = '<span class="chip chip-26 num c-neutro"><span class="ponto cinza" aria-hidden="true"></span>Manual</span>';
  else if (temGarmin) fonte = `<span class="chip chip-26 num c-ok"><span class="ponto ok" aria-hidden="true"></span>Garmin · ${horaG}</span>`;
  else fonte = '<span class="chip chip-26 num c-neutro"><span class="ponto cinza" aria-hidden="true"></span>Sem dado</span>';

  const atualizar = `<button type="button" class="btn-atualizar press hit" data-acao="garmin-atualizar">
    ${ic(P.atualizar, 16, 2.2, ` style="transform: rotate(${estado.giro}deg)"`)}Atualizar</button>`;
  let bloco;
  if (p.manual) {
    bloco = `<div class="manual-campo"><label for="peso-kout">Total do dia</label>
      <input id="peso-kout" class="num" type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off"
        value="${esc(p.kout)}" data-campo="peso-kout" data-seleciona><span class="unidade">kcal</span></div>`;
  } else if (temGarmin) {
    const a = num(log.garmin_active_kcal);
    const b = num(log.garmin_bmr_kcal);
    bloco = `<div class="garmin-linha"><div class="col2">
      <span class="garmin-valor num">${fmt.int(garminTotal(log))} <small>kcal</small></span>
      <span class="cc-hint num">ativas ${fmt.int(a || 0)} + repouso ${fmt.int(b || 0)} · até ${horaG}</span></div>${atualizar}</div>`;
  } else {
    bloco = `<div class="garmin-linha"><div class="col2">
      <span class="garmin-valor num">— <small>kcal</small></span>
      <span class="cc-hint">${API_URL ? 'Ainda sem dados do Garmin neste dia' : 'Garmin ainda não configurado'}</span></div>${atualizar}</div>`;
  }

  const tags = MARCADORES.map(([k, rot]) => `<button type="button" class="marcador press" data-acao="peso-tag" data-tag="${k}" aria-pressed="${p.tags.has(k)}">${rot}</button>`).join('');

  $('#peso-corpo').innerHTML = `
    <div class="cartao-campo">
      <div class="cc-topo"><label for="peso-input" class="cc-titulo">Peso</label><span class="cc-hint">em jejum, depois do banheiro</span></div>
      <div class="stepper">
        <button type="button" class="stepper-btn press" data-acao="peso-passo" data-passo="-0.1" aria-label="Diminuir 0,1 kg">${ic(P.menos, 20, 2.2)}</button>
        <div class="stepper-centro"><input id="peso-input" class="num" type="text" inputmode="decimal" enterkeyhint="next"
          autocomplete="off" value="${esc(p.texto)}" data-campo="peso" data-seleciona><span class="unidade">kg</span></div>
        <button type="button" class="stepper-btn press" data-acao="peso-passo" data-passo="0.1" aria-label="Aumentar 0,1 kg">${ic(P.mais, 20, 2.2)}</button>
      </div>
      <p class="stepper-nota num" aria-live="polite" id="peso-nota">${notaPeso()}</p>
    </div>

    <div class="cartao-campo g12">
      <div class="cc-topo"><span class="cc-titulo">${ic(P.raio, 16, 2, ' style="color: var(--carb-icone)"')}Calorias gastas</span>${fonte}</div>
      ${bloco}
      <div class="linha-chave"><label for="peso-manual" id="lbl-manual">Inserir manualmente</label>${chaveHTML('peso-manual', p.manual, 'data-muda="peso-manual"')}</div>
      <div class="linha-saldo" aria-live="polite">
        <div><span class="cc-hint">Ingeridas, das refeições</span><span class="v num">${fmt.int(ingeridas)} kcal</span></div>
        <div><span class="cc-hint">Saldo até agora</span><span class="v num" id="peso-saldo">${gastas === null ? '—' : sinal(ingeridas - gastas)} kcal</span></div>
      </div>
    </div>

    <div class="cartao-campo">
      <div class="cc-topo base"><span class="cc-titulo">Observação</span><span class="cc-hint">opcional</span></div>
      <div class="marcadores" role="group" aria-label="Marcadores do dia">${tags}</div>
      <div class="campo-nota"><input type="text" aria-label="Nota do dia" placeholder="Escreva uma nota" maxlength="200"
        enterkeyhint="done" value="${esc(p.nota)}" data-campo="peso-nota"></div>
    </div>

    <button type="button" class="btn-principal press mt-auto" data-acao="peso-salvar">Salvar</button>`;
}

function atualizarSaldoPeso() {
  const ingeridas = totaisDo(estado.peso.data).kcal;
  const g = gastoAtualDoSheet();
  const el = $('#peso-saldo');
  if (el) el.textContent = `${g === null ? '—' : sinal(ingeridas - g)} kcal`;
}

function salvarPeso() {
  const p = estado.peso;
  const log = logDo(p.data);
  const campos = { tags: [...p.tags], note: p.nota.trim() || null };
  if (p.tocado || p.registrado) {
    const n = num(p.texto);
    if (n === null || n < 30 || n > 250) { aviso('Confira o peso: use kg, por exemplo 75,4.'); $('#peso-input').focus(); return; }
    campos.weight_kg = arred(n, 2);
  }
  if (p.manual) {
    const k = num(p.kout);
    if (k !== null) { campos.kcal_burned = Math.round(k); campos.burned_source = 'manual'; }
  } else if (log && log.burned_source === 'manual') {
    // Voltou para o Garmin: o valor do relógio (se houver) passa a valer.
    campos.burned_source = log.garmin_synced_at ? 'garmin' : null;
    campos.kcal_burned = garminTotal(log);
  }
  salvarDia(p.data, campos);
  vibrar(10);
  fecharSheet();
  renderTelaAtual();
}

async function atualizarGarmin() {
  estado.giro += 360;
  $$('.btn-atualizar svg').forEach((s) => { s.style.transform = `rotate(${estado.giro}deg)`; });
  if (MODO_LOCAL || !API_URL) { aviso('A sincronização com o Garmin precisa da api/ publicada (veja o README).', { duracao: 6000 }); return; }
  if (!navigator.onLine) { aviso('Sem conexão. O valor manual continua funcionando.'); return; }
  const data = estado.peso ? estado.peso.data : R.hojeSP();
  aviso('Buscando no Garmin…', { duracao: 60000 });
  try {
    await chamarApi('/garmin/sync', { date: data });
    await processarFila();
    await baixarDoServidor({ forcar: true });
    if (sheetAtual === $('#sheet-peso')) renderPeso();
    const log = logDo(data);
    aviso(log && log.garmin_synced_at ? `Garmin atualizado às ${horaDe(log.garmin_synced_at)}` : 'O Garmin ainda não tem dados deste dia.');
  } catch (e) {
    aviso('Não deu para falar com o Garmin agora. O valor manual continua funcionando.', { duracao: 6000 });
  }
}

/* ---------- 4d. Sheet: adicionar alimento ---------- */

function abrirAdd({ mealId = null, data = null, foodId = null } = {}) {
  if (!cache.settings) return;
  let dia = data;
  if (!dia) dia = estado.tela === 'refeicao' && estado.refeicao ? estado.refeicao.data : (estado.tela === 'hoje' ? estado.data : R.hojeSP());
  const lista = refeicoesDoDia(dia).filter((m) => m.id !== OUTROS);
  let meal = mealId && mealId !== OUTROS ? mealId : null;
  if (!meal && estado.tela === 'refeicao' && estado.refeicao && estado.refeicao.mealId !== OUTROS) meal = estado.refeicao.mealId;
  if (!meal) { const a = refeicaoAgora(lista); meal = a ? a.id : (lista[0] && lista[0].id); }
  const f = foodId ? derivados().alimentos.get(foodId) : null;
  estado.add = { data: dia, mealId: meal, foodId: f ? f.id : null, gramas: f ? gramasSugeridas(f) : '', busca: '' };
  $('#add-busca').value = '';
  const sub = $('#add-sub');
  sub.hidden = dia === R.hojeSP();
  sub.textContent = dataMedia(dia);
  renderAdd();
  abrirSheet($('#sheet-add'));
  $('#add-lista').scrollTop = 0;
}

function gramasSugeridas(f) {
  const g = num(f.last_grams) || num(f.unit_g) || 100;
  return paraCampo(g, 1);
}

function renderAdd() {
  const a = estado.add;
  const lista = refeicoesDoDia(a.data).filter((m) => m.id !== OUTROS);
  const grade = $('#add-refeicoes');
  const n = lista.length;
  grade.style.gridTemplateColumns = `repeat(${n}, minmax(${n > 5 ? '64px' : '0'}, 1fr))`;
  grade.style.overflowX = n > 5 ? 'auto' : '';
  grade.innerHTML = lista.map((m) => `<button type="button" class="press" data-acao="add-refeicao" data-meal="${m.id}" aria-pressed="${m.id === a.mealId}">${esc(curto(m.name))}</button>`).join('');
  renderAddLista();
  renderAddPainel();
}

/** Mais usados na refeição: contagem do histórico; completa com os mais usados no geral. */
function maisUsados(mealId) {
  const d = derivados();
  const cont = new Map();
  cache.meal_entries.forEach((e) => {
    if (e.meal_type_id === mealId && e.food_id) cont.set(e.food_id, (cont.get(e.food_id) || 0) + 1);
  });
  const ativos = (f) => f && !f.archived;
  const lista = [...cont.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => d.alimentos.get(id)).filter(ativos);
  const vistos = new Set(lista.map((f) => f.id));
  cache.foods.filter((f) => ativos(f) && !vistos.has(f.id))
    .sort((x, y) => (num(y.use_count) || 0) - (num(x.use_count) || 0))
    .forEach((f) => lista.push(f));
  return lista.slice(0, 8);
}

function porCemTexto(f, comUnidade = false) {
  const u = comUnidade ? ' g' : '';
  return `${fmt.int(num(f.kcal_100g) || 0)} kcal · P ${fmt.ate1(num(f.protein_100g) || 0)}${u} · C ${fmt.ate1(num(f.carb_100g) || 0)}${u} · G ${fmt.ate1(num(f.fat_100g) || 0)}${u}`;
}

function renderAddLista() {
  const a = estado.add;
  const q = R.normalizar(a.busca);
  const meal = derivados().refeicoes.get(a.mealId);
  const foods = q
    ? cache.foods.filter((f) => !f.archived && casaBusca(f.name, q)).sort((x, y) => x.name.localeCompare(y.name, 'pt-BR'))
    : maisUsados(a.mealId);
  $('#add-lista-titulo').textContent = q ? 'Resultados'
    : `Mais usados ${meal ? (artigo(meal.name) === 'à' ? 'no horário da ' : 'no ') + minuscula(meal.name) : ''}`;
  const itens = foods.map((f) => `<button type="button" class="item-alimento press" data-acao="add-escolher" data-id="${f.id}" aria-pressed="${f.id === a.foodId}">
      <span class="ia-texto"><span class="ia-nome">${esc(f.name)}</span><span class="ia-sub num">${porCemTexto(f)}</span></span>
      ${num(f.last_grams) ? `<span class="ia-ult num">últ. ${fmt.ate1(num(f.last_grams))} g</span>` : ''}
      <span class="ia-check" aria-hidden="true">${ic(P.check, 14, 3)}</span></button>`).join('');
  const vazio = q && !foods.length ? `<p class="lista-vazia">Nada com “${esc(a.busca.trim())}” nos seus alimentos.</p>` : '';
  $('#add-lista').innerHTML = `${itens}${vazio}${q ? tacoNaListaHTML(a.busca, 'add-taco', 6) : ''}
    <div class="acoes-novo">
      <button type="button" class="btn-tracejado press" data-acao="add-novo">${ic(P.mais, 16, 2.4)}Cadastrar novo</button>
      <button type="button" class="btn-tracejado press" data-acao="add-codigo">${ic(P.codigo, 16, 2.2)}Código de barras</button>
    </div>`;
  if (q && !taco) carregarTaco().then(() => { if (estado.add && estado.add.busca === a.busca) renderAddLista(); }).catch(() => {});
}

/** Seção "Tabela TACO" abaixo dos resultados de uma busca. */
let tacoMostrados = [];
function tacoNaListaHTML(busca, acao, limite) {
  if (!taco) return '';
  // O que já foi copiado para "Meus alimentos" aparece só lá.
  tacoMostrados = buscarNaTaco(busca, limite + 10).filter((t) => !alimentoComNome(t.nome)).slice(0, limite);
  if (!tacoMostrados.length) return '';
  return `<h3 class="taco-titulo">Tabela TACO <small>valores por 100 g</small></h3>
    ${tacoMostrados.map((t, i) => `<button type="button" class="item-alimento press" data-acao="${acao}" data-i="${i}">
      <span class="ia-texto"><span class="ia-nome">${esc(t.nome)}</span><span class="ia-sub num">${tacoTexto(t)}</span></span>
      <span class="ia-mais" aria-hidden="true">${ic(P.mais, 14, 2.6)}</span></button>`).join('')}`;
}

/** Escolhe um alimento no sheet (já existente ou recém-copiado) e mostra o painel da balança. */
function escolherNoAdd(f) {
  const a = estado.add;
  if (a.foodId !== f.id) { a.foodId = f.id; a.gramas = gramasSugeridas(f); }
  renderAddLista();
  renderAddPainel();
  vibrar(5);
}

function renderAddPainel() {
  const a = estado.add;
  const f = a.foodId ? derivados().alimentos.get(a.foodId) : null;
  const painel = $('#add-painel');
  const meal = derivados().refeicoes.get(a.mealId);
  if (!f) {
    painel.innerHTML = `<div class="col2"><p class="painel-nome">Escolha um alimento</p>
      <p class="painel-sub">Toque num item da lista ou busque pelo nome.</p></div>
      <button type="button" class="btn-confirmar" disabled><span class="l1">Adicionar ${meal ? artigo(meal.name) + ' ' + esc(minuscula(meal.name)) : ''}</span></button>`;
    return;
  }
  const sugestoes = [];
  if (num(f.last_grams)) sugestoes.push(`<button type="button" class="btn-sugestao press hit" data-acao="add-usar" data-g="${num(f.last_grams)}">Última vez: ${fmt.ate1(num(f.last_grams))} g</button>`);
  if (num(f.unit_g) && num(f.unit_g) !== num(f.last_grams)) sugestoes.push(`<button type="button" class="btn-sugestao press hit" data-acao="add-usar" data-g="${num(f.unit_g)}">1 ${esc(f.unit_label || 'un')} = ${fmt.ate1(num(f.unit_g))} g</button>`);
  painel.innerHTML = `
    <div class="col2"><p class="painel-nome">${esc(f.name)}</p><p class="painel-sub num">Por 100 g: ${porCemTexto(f, true)}</p></div>
    <div class="balanca">
      <button type="button" class="btn-10 press" data-acao="add-passo" data-passo="-10" aria-label="Menos 10 gramas">−10</button>
      <label class="balanca-campo" for="add-gramas"><span class="rotulo-12">Peso na balança</span>
        <input id="add-gramas" class="num" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off"
          value="${esc(a.gramas)}" data-campo="add-gramas" data-seleciona><span class="unidade">g</span></label>
      <button type="button" class="btn-10 press" data-acao="add-passo" data-passo="10" aria-label="Mais 10 gramas">+10</button>
    </div>
    <div class="sugestoes">${sugestoes.join('')}<span class="cc-hint">Zere a balança com o prato antes</span></div>
    <div class="resultado" aria-live="polite">
      <p class="resultado-kcal num"><span class="n" id="add-kcal"></span><span class="u">kcal</span></p>
      <div class="pilulas num"><span class="pilula c-violeta-forte" id="add-p"></span><span class="pilula c-carb" id="add-c"></span><span class="pilula c-gord" id="add-g"></span></div>
    </div>
    <button type="button" class="btn-confirmar press" data-acao="add-confirmar" id="add-cta">
      <span class="l1">Adicionar ${meal ? artigo(meal.name) + ' ' + esc(minuscula(meal.name)) : ''}</span><span class="l2 num" id="add-delta"></span></button>`;
  atualizarAddResultado();
}

/** Resultado ao vivo enquanto digita o peso da balança. */
function atualizarAddResultado() {
  const a = estado.add;
  const f = derivados().alimentos.get(a.foodId);
  if (!f || !$('#add-kcal')) return;
  const g = Math.max(0, num(a.gramas) || 0);
  const v = R.macrosDoItem(g, f);
  $('#add-kcal').textContent = fmt.int(v.kcal);
  $('#add-p').textContent = `P ${fmt.ate1(v.p)} g`;
  $('#add-c').textContent = `C ${fmt.ate1(v.c)} g`;
  $('#add-g').textContent = `G ${fmt.ate1(v.g)} g`;
  const meal = derivados().refeicoes.get(a.mealId);
  const antesMeal = R.somarItens(itensDaRefeicao(a.data, a.mealId)).kcal;
  const dia = totaisDo(a.data).kcal;
  $('#add-delta').textContent = `${meal ? curto(meal.name) : 'Refeição'}: ${fmt.int(antesMeal)} → ${fmt.int(antesMeal + v.kcal)} kcal · dia: ${fmt.int(dia + v.kcal)} de ${fmt.int(metaKcalEm(a.data))}`;
  $('#add-cta').disabled = !(g > 0);
}

function confirmarAdd() {
  const a = estado.add;
  const f = derivados().alimentos.get(a.foodId);
  const g = num(a.gramas);
  if (!f || !g || g <= 0) return;
  const entrada = {
    id: novoId(), user_id: usuario.id, date: a.data, meal_type_id: a.mealId, food_id: f.id, food_name: f.name,
    grams: arred(g, 1), kcal_100g: num(f.kcal_100g), protein_100g: num(f.protein_100g),
    carb_100g: num(f.carb_100g), fat_100g: num(f.fat_100g), created_at: new Date().toISOString(),
  };
  cache.meal_entries.push(entrada);
  gravarCache();
  enfileirarUpsert('meal_entries', entrada);
  gravarLinha('foods', { ...f, last_grams: arred(g, 1), use_count: (num(f.use_count) || 0) + 1 });
  processarFila();
  vibrar(10);
  const meal = derivados().refeicoes.get(a.mealId);
  fecharSheet();
  renderTelaAtual();
  aviso(`${f.name} ${artigo(meal ? meal.name : 'o')} ${meal ? minuscula(meal.name) : ''}`.trim(), {
    acao: 'Desfazer',
    fn: () => { apagarLinha('meal_entries', entrada.id); processarFila(); renderTelaAtual(); },
  });
}

/* ---------- 4e. Refeição ---------- */

function renderRefeicao() {
  const el = $('#refeicao');
  const r = estado.refeicao;
  if (!r || !cache.settings) { el.innerHTML = ''; return; }
  const itens = itensDaRefeicao(r.data, r.mealId);
  const meal = derivados().refeicoes.get(r.mealId);
  const nome = nomeRefeicao(r.mealId);
  const hora = itens.length && itens[0].created_at ? horaDe(itens[0].created_at) : (meal && meal.default_time);
  const ed = estado.editandoItens;
  const linhas = itens.map((e) => {
    const v = R.macrosDoItem(e.grams, e);
    return `<div class="item-wrap" data-id="${e.id}">
      <div class="item-apagar-fundo" aria-hidden="true">Apagar</div>
      <div class="item-linha" data-deslizar>
        <div class="il-texto"><label class="il-nome" for="item-${e.id}">${esc(e.food_name || 'Alimento')}</label>
          <span class="il-sub num" data-r="macros">P ${fmt.ate1(v.p)} · C ${fmt.ate1(v.c)} · G ${fmt.ate1(v.g)}</span></div>
        <div class="campo campo-g"><input id="item-${e.id}" class="num" type="text" inputmode="decimal" enterkeyhint="done"
          autocomplete="off" value="${paraCampo(num(e.grams))}" data-campo="item-gramas" data-muda="item-gramas" data-id="${e.id}" data-seleciona>
          <span class="unidade">g</span></div>
        <span class="il-kcal num" data-r="kcal">${fmt.int(v.kcal)}</span>
        ${ed ? `<button type="button" class="btn-lixo press" data-acao="item-apagar" data-id="${e.id}" aria-label="Apagar ${esc(e.food_name || 'item')}">${ic(P.lixo, 18)}</button>` : ''}
      </div></div>`;
  }).join('');
  const art = artigo(nome);
  el.innerHTML = `
    <div class="barra-topo">
      <button type="button" class="btn-circ press" data-acao="voltar" aria-label="Voltar">${ic(P.voltar, 20, 2.2)}</button>
      <button type="button" class="btn-circ press" data-acao="refeicao-editar" aria-pressed="${ed}" aria-label="${ed ? 'Concluir edição' : 'Mais opções da refeição'}">${ed ? ic(P.check, 20, 2.4) : PONTOS}</button>
    </div>
    <header class="cabecalho cabecalho-pilha">
      <p class="sobretitulo num">${dataMedia(r.data)}${hora ? ' · ' + hora : ''}</p>
      <h1 class="titulo">${esc(nome)}</h1>
    </header>
    <section class="cartao total-refeicao" aria-label="Total da refeição" id="ref-total"></section>
    <div class="itens-titulo"><h2>${itens.length} ${itens.length === 1 ? 'alimento' : 'alimentos'}</h2>
      <span class="cc-hint">${ed ? 'toque na lixeira para apagar' : 'toque no peso para corrigir'}</span></div>
    ${itens.length ? `<section class="itens">${linhas}</section>` : '<div class="cartao"><p class="texto-14">Nenhum alimento nesta refeição ainda.</p></div>'}
    ${r.mealId !== OUTROS ? `<button type="button" class="btn-tracejado press" data-acao="abrir-add" data-meal="${r.mealId}">${ic(P.mais, 16, 2.4)}Adicionar alimento ${art} ${esc(minuscula(nome))}</button>` : ''}
    <p class="nota-rodape">Cada peso fica salvo e volta como sugestão da próxima vez que você adicionar esse alimento. Deslize um item para a esquerda para apagar.</p>`;
  atualizarTotalRefeicao();
}

/** Totais recalculados a cada tecla (sem animação). */
function atualizarTotalRefeicao() {
  const r = estado.refeicao;
  const box = $('#ref-total');
  if (!box) return;
  const t = R.somarItens(itensDaRefeicao(r.data, r.mealId));
  const pk = t.p * 4; const ck = t.c * 4; const gk = t.g * 9;
  const soma = (pk + ck + gk) || 1;
  const pct = (x) => ((x / soma) * 100).toFixed(1) + '%';
  const meta = metaKcalEm(r.data);
  box.innerHTML = `
    <div class="tr-topo" aria-live="polite"><p class="tr-kcal num"><span class="n">${fmt.int(t.kcal)}</span><span class="u">kcal</span></p>
      <span class="tr-share num">${meta ? Math.round((t.kcal / meta) * 100) : 0}% da meta do dia</span></div>
    <div class="divisao" role="img" aria-label="Calorias da refeição: ${Math.round(pk / soma * 100)}% proteína, ${Math.round(ck / soma * 100)}% carboidrato, ${Math.round(gk / soma * 100)}% gordura">
      <span class="bg-prot" style="width:${pct(pk)}"></span><span class="bg-carb" style="width:${pct(ck)}"></span><span class="bg-gord" style="width:${pct(gk)}"></span></div>
    <div class="legenda-3 num">
      <div><span class="rotulo-12"><span class="ponto bg-prot"></span>Proteína</span><span class="v">${fmt.ate1(t.p)} g</span></div>
      <div><span class="rotulo-12"><span class="ponto bg-carb"></span>Carboidrato</span><span class="v">${fmt.ate1(t.c)} g</span></div>
      <div><span class="rotulo-12"><span class="ponto bg-gord"></span>Gordura</span><span class="v">${fmt.ate1(t.g)} g</span></div>
    </div>`;
}

function editarGramasItem(input, enviar) {
  const e = cache.meal_entries.find((x) => x.id === input.dataset.id);
  if (!e) return;
  input.value = limparNum(input.value, 5);
  const g = num(input.value);
  if (g === null || g <= 0) { if (enviar) input.value = paraCampo(num(e.grams)); return; }
  e.grams = arred(g, 1);
  gravarCache();
  const linha = input.closest('.item-linha');
  const v = R.macrosDoItem(e.grams, e);
  $('[data-r="macros"]', linha).textContent = `P ${fmt.ate1(v.p)} · C ${fmt.ate1(v.c)} · G ${fmt.ate1(v.g)}`;
  $('[data-r="kcal"]', linha).textContent = fmt.int(v.kcal);
  atualizarTotalRefeicao();
  if (enviar) {
    enfileirarUpsert('meal_entries', e);
    const f = e.food_id && derivados().alimentos.get(e.food_id);
    if (f) gravarLinha('foods', { ...f, last_grams: e.grams });
    processarFila();
  }
}

function apagarItem(id) {
  const e = apagarLinha('meal_entries', id);
  if (!e) return;
  processarFila();
  vibrar(8);
  renderRefeicao();
  aviso(`${e.food_name || 'Item'} apagado`, {
    acao: 'Desfazer',
    fn: () => { gravarLinha('meal_entries', e); processarFila(); renderTelaAtual(); },
  });
}

/* Deslizar para a esquerda apaga. Só assume o gesto quando o movimento é claramente horizontal. */
function ligarDeslizarItens() {
  let g = null;
  const raiz = $('#refeicao');
  raiz.addEventListener('pointerdown', (e) => {
    const linha = e.target.closest('[data-deslizar]');
    if (!linha || g || e.button > 0) return;
    g = { linha, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, ativo: false, t: e.timeStamp };
  });
  raiz.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (!g.ativo) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { g = null; return; }
      if (Math.abs(dx) < 10 || dx > 0) return;
      g.ativo = true;
      g.linha.setPointerCapture(e.pointerId);
      g.linha.classList.add('is-arrastando');
      if (document.activeElement && g.linha.contains(document.activeElement)) document.activeElement.blur();
    }
    g.dx = Math.min(0, dx);
    g.linha.style.transform = `translateX(${g.dx}px)`;
  });
  const soltar = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const { linha, dx, ativo, t } = g;
    g = null;
    if (!ativo) return;
    linha.classList.remove('is-arrastando');
    const veloc = dx / Math.max(1, e.timeStamp - t);
    if (dx < -linha.offsetWidth * 0.35 || (dx < -40 && veloc < -0.5)) {
      linha.style.transform = 'translateX(-100%)';
      const id = linha.closest('.item-wrap').dataset.id;
      setTimeout(() => apagarItem(id), 200);
    } else {
      linha.style.transform = '';
    }
  };
  raiz.addEventListener('pointerup', soltar);
  raiz.addEventListener('pointercancel', soltar);
}

/* ---------- 4f. Meus alimentos ---------- */

function renderAlimentos() {
  const el = $('#alimentos');
  if (!cache.settings) { el.innerHTML = ''; return; }
  const ativos = cache.foods.filter((f) => !f.archived);
  const busca = estado.alimentos.busca;
  if (!$('#alimentos-busca')) {
    el.innerHTML = `
      <div class="barra-topo">
        <button type="button" class="btn-circ press" data-acao="voltar" aria-label="Voltar">${ic(P.voltar, 20, 2.2)}</button>
        <button type="button" class="btn-escuro press" data-acao="novo-alimento">${ic(P.mais, 18, 2.4)}Novo alimento</button>
      </div>
      <header class="cabecalho cabecalho-pilha"><p class="sobretitulo num" id="alimentos-conta"></p><h1 class="titulo">Meus alimentos</h1></header>
      <label class="busca">${ic(P.busca, 18, 2, ' style="color: var(--texto-2)"')}<span class="sr-only">Buscar alimento</span>
        <input type="search" id="alimentos-busca" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"
          placeholder="Buscar" value="${esc(busca)}" data-campo="alimentos-busca"></label>
      <div id="alimentos-ordem"></div>
      <section class="lista-alimentos" aria-label="Lista de alimentos" id="alimentos-lista"></section>
      <section class="taco-bloco" aria-label="Tabela TACO" id="alimentos-taco"></section>
      <p class="nota-rodape">Valores por 100 g, como no rótulo. Itens com porção ou unidade (whey, ovo) também podem ser registrados pela quantidade.</p>`;
  }
  $('#alimentos-conta').textContent = `${ativos.length} alimentos · valores por 100 g`;
  $('#alimentos-ordem').innerHTML = segmentadoHTML({ acao: 'alimentos-ordem', opcoes: ['A–Z', 'Mais usados'], sel: estado.alimentos.ordem, rotulo: 'Ordenar', escuro: true });
  renderListaAlimentos();
}

function renderListaAlimentos() {
  const q = R.normalizar(estado.alimentos.busca);
  const porUso = estado.alimentos.ordem === 1;
  let lista = cache.foods.filter((f) => !f.archived && (!q || casaBusca(f.name, q)));
  lista = porUso
    ? lista.sort((a, b) => (num(b.use_count) || 0) - (num(a.use_count) || 0))
    : lista.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const html = lista.map((f) => {
    const un = num(f.unit_g) ? `1 ${esc(f.unit_label || 'un')} = ${fmt.ate1(num(f.unit_g))} g · ` : '';
    const usos = porUso ? ` · ${num(f.use_count) || 0}×` : '';
    return `<button type="button" class="linha-alimento" data-acao="editar-alimento" data-id="${f.id}">
      <span class="ia-texto"><span class="ia-nome">${esc(f.name)}</span>
        <span class="ia-sub num">${un}P ${fmt.ate1(num(f.protein_100g) || 0)} · C ${fmt.ate1(num(f.carb_100g) || 0)} · G ${fmt.ate1(num(f.fat_100g) || 0)}${usos}</span></span>
      <span class="la-kcal num">${fmt.int(num(f.kcal_100g) || 0)} <small>kcal</small></span>${ic(P.avancar, 16, 2.2, ' class="chevron"')}</button>`;
  }).join('');
  const t = estado.alimentos.busca.trim();
  $('#alimentos-lista').innerHTML = html || `<div class="vazio">
    <p>${t ? `Nenhum alimento seu com “${esc(t)}”.` : 'Nenhum alimento cadastrado.'}</p>
    <button type="button" class="btn-claro press" data-acao="novo-alimento" data-nome="${esc(t)}">${t ? `Cadastrar “${esc(t)}”` : 'Cadastrar alimento'}</button></div>`;
  $('#alimentos-taco').innerHTML = t ? tacoNaListaHTML(t, 'alimentos-taco', 10) : '';
  if (t && !taco) carregarTaco().then(() => { if (estado.alimentos.busca.trim() === t && estado.tela === 'alimentos') renderListaAlimentos(); }).catch(() => {});
}

/* ---------- 4g. Novo / editar alimento ---------- */

/** prefill = { nome, kcal, p, c, g, origem } vindo da TACO ou do código de barras (valores por 100 g). */
function rascunhoAlimento(id, nome = '', voltarAdd = null, prefill = null) {
  const f = id ? derivados().alimentos.get(id) : null;
  if (!f) {
    const r = { id: null, nome, base: 0, porcao: '', kcal: '', p: '', c: '', g: '', unidade: '', voltarAdd, origem: '' };
    return prefill ? preencherRascunho(r, prefill) : r;
  }
  const porcao = f.label_basis === 'portion' && num(f.portion_g) ? num(f.portion_g) : null;
  const k = porcao ? porcao / 100 : 1;
  const v = (x) => (num(x) === null ? '' : paraCampo(arred(num(x) * k, 1)));
  return {
    id: f.id, nome: f.name, base: porcao ? 1 : 0, porcao: porcao ? paraCampo(porcao) : '',
    kcal: v(f.kcal_100g), p: v(f.protein_100g), c: v(f.carb_100g), g: v(f.fat_100g),
    unidade: num(f.unit_g) ? paraCampo(num(f.unit_g)) : '', voltarAdd,
  };
}

function preencherRascunho(r, d) {
  const v = (x) => (x === null || x === undefined ? '' : paraCampo(arred(x, 1)));
  return { ...r, nome: d.nome || r.nome, base: 0, porcao: '', kcal: v(d.kcal), p: v(d.p), c: v(d.c), g: v(d.g), origem: d.origem || '' };
}

const NUTRIENTES = [
  ['kcal', 'Calorias', 'kcal', 'var(--kcal)'], ['p', 'Proteínas', 'g', 'var(--prot)'],
  ['c', 'Carboidratos', 'g', 'var(--carb)'], ['g', 'Gorduras', 'g', 'var(--gord)'],
];

function renderAlimento() {
  const a = estado.alimento;
  const el = $('#alimento');
  if (!a) { el.innerHTML = ''; return; }
  const porc = num(a.porcao) || 100;
  const porcao = a.base === 1 ? `<div class="linha-campo"><label for="al-porcao">Tamanho da porção</label>
      <div class="campo w104"><input id="al-porcao" class="num" type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off"
        value="${esc(a.porcao)}" data-campo="al" data-k="porcao" data-seleciona><span class="unidade">g</span></div></div>` : '';
  el.innerHTML = `
    <div class="topo-form">
      <button type="button" class="acao cancelar press" data-acao="voltar">Cancelar</button>
      <h1>${a.id ? 'Editar alimento' : 'Novo alimento'}</h1>
      <button type="button" class="acao salvar press" data-acao="alimento-salvar">Salvar</button>
    </div>
    ${a.id ? '' : `<button type="button" class="btn-tracejado press" data-acao="al-codigo">${ic(P.codigo, 16, 2.2)}Preencher pelo código de barras</button>`}
    ${a.origem ? `<p class="origem-dados">${esc(a.origem)}</p>` : ''}
    <div class="cartao-20 nome"><label class="rotulo" for="al-nome">Nome</label>
      <input id="al-nome" type="text" enterkeyhint="next" autocomplete="off" autocapitalize="sentences" maxlength="60"
        value="${esc(a.nome)}" placeholder="Ex.: Whey protein baunilha" data-campo="al" data-k="nome"></div>
    <section class="cartao-20"><h2>Valores do rótulo</h2>
      ${segmentadoHTML({ acao: 'al-base', opcoes: ['Por 100 g', 'Por porção'], sel: a.base, rotulo: 'Base dos valores' })}
      ${porcao}</section>
    <section class="cartao-20 nutri" aria-labelledby="nutri-h">
      <h2 id="nutri-h" class="num">Nutrientes ${a.base === 1 ? 'por porção de ' + fmt.ate1(porc) + ' g' : 'por 100 g'}</h2>
      ${NUTRIENTES.map(([k, rot, u, cor]) => `<div class="nutri-linha"><span class="ponto" style="background:${cor}" aria-hidden="true"></span>
        <label for="al-${k}">${rot}</label>
        <div class="campo w120"><input id="al-${k}" class="num" type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off"
          value="${esc(a[k])}" data-campo="al" data-k="${k}" data-seleciona><span class="unidade">${u}</span></div></div>`).join('')}
    </section>
    <section class="conferencia" aria-live="polite" id="al-conf"></section>
    <section class="cartao-20"><div class="linha-campo">
      <div class="col2"><label for="al-unidade">1 unidade pesa</label><span class="li-sub">Opcional · 1 scoop, 1 ovo, 1 fatia</span></div>
      <div class="campo w104"><input id="al-unidade" class="num" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off"
        placeholder="–" value="${esc(a.unidade)}" data-campo="al" data-k="unidade" data-seleciona><span class="unidade">g</span></div></div></section>
    <button type="button" class="btn-principal press mt4" data-acao="alimento-salvar">Salvar alimento</button>
    ${a.id ? '<button type="button" class="btn-texto press" data-acao="alimento-arquivar">Arquivar alimento</button>' : ''}`;
  atualizarConferencia();
}

/** Confere 4P + 4C + 9G contra o rótulo (diferença acima de 8% → "Confira o rótulo"). */
function atualizarConferencia() {
  const a = estado.alimento;
  const box = $('#al-conf');
  if (!box) return;
  const kcal = num(a.kcal) || 0; const p = num(a.p) || 0; const c = num(a.c) || 0; const g = num(a.g) || 0;
  const chk = R.conferirRotulo(kcal, p, c, g);
  const porc = num(a.porcao) || 100;
  const k = a.base === 1 ? 100 / porc : 1;
  box.className = 'conferencia ' + (chk.ok ? 'ok' : 'alerta');
  const texto = `4 × ${fmt.ate1(p)} + 4 × ${fmt.ate1(c)} + 9 × ${fmt.ate1(g)} = ${fmt.ate1(chk.calc)} kcal pelos macros, contra ${fmt.ate1(kcal)} kcal no rótulo${chk.ok ? '.' : ` (diferença de ${Math.round(chk.diff * 100)}%).`}`;
  box.innerHTML = `<div class="conf-topo"><span class="conf-icone">${ic(chk.ok ? P.check : P.atencao, 14, 3)}</span>
      <span class="conf-titulo">${chk.ok ? 'Bate com o rótulo' : 'Confira o rótulo'}</span></div>
    <p class="num">${texto}</p>
    ${a.base === 1 ? `<p class="num">Por 100 g: ${fmt.ate1(kcal * k)} kcal · P ${fmt.ate1(p * k)} · C ${fmt.ate1(c * k)} · G ${fmt.ate1(g * k)}</p>` : ''}`;
  const h = $('#nutri-h');
  if (h) h.textContent = `Nutrientes ${a.base === 1 ? 'por porção de ' + fmt.ate1(porc) + ' g' : 'por 100 g'}`;
}

function salvarAlimento() {
  const a = estado.alimento;
  const nome = a.nome.trim().replace(/\s+/g, ' ');
  if (!nome) { aviso('Dê um nome ao alimento.'); $('#al-nome').focus(); return; }
  const kcal = num(a.kcal);
  if (!kcal || kcal <= 0) { aviso('Preencha as calorias do rótulo.'); $('#al-kcal').focus(); return; }
  const porc = a.base === 1 ? num(a.porcao) : null;
  if (a.base === 1 && !(porc > 0)) { aviso('Informe o tamanho da porção em gramas.'); $('#al-porcao').focus(); return; }
  const v = R.paraCem({ kcal, p: num(a.p) || 0, c: num(a.c) || 0, g: num(a.g) || 0 }, porc || 100);
  const antigo = a.id ? derivados().alimentos.get(a.id) : null;
  const un = num(a.unidade);
  const linha = {
    ...(antigo || {}),
    id: a.id || novoId(),
    name: nome,
    kcal_100g: arred(v.kcal, 2), protein_100g: arred(v.p, 2), carb_100g: arred(v.c, 2), fat_100g: arred(v.g, 2),
    label_basis: a.base === 1 ? 'portion' : '100g',
    portion_g: porc,
    unit_g: un && un > 0 ? un : null,
    unit_label: un && un > 0 ? ((antigo && antigo.unit_label) || 'un') : null,
    last_grams: antigo ? antigo.last_grams : null,
    use_count: antigo ? antigo.use_count : 0,
    archived: false,
  };
  gravarLinha('foods', linha);
  processarFila();
  vibrar(10);
  const volta = a.voltarAdd;
  if (volta) aposVoltar = () => abrirAdd({ ...volta, foodId: linha.id });
  voltar();
}

function arquivarAlimento() {
  const a = estado.alimento;
  const f = a && a.id && derivados().alimentos.get(a.id);
  if (!f) return;
  gravarLinha('foods', { ...f, archived: true });
  processarFila();
  aviso(`${f.name} arquivado`, { acao: 'Desfazer', fn: () => { gravarLinha('foods', { ...f, archived: false }); processarFila(); renderTelaAtual(); } });
  voltar();
}

/* ---------- 4h. Metas de macros ---------- */

const REGRAS_MACRO = ['min', 'range', 'max'];

function rascunhoMetas() {
  const m = metasMacro();
  const r = {};
  MACROS.forEach((x) => {
    const g = m[x.k] || { target_g: '', rule: 'min' };
    r[x.k] = {
      meta: paraCampo(num(g.target_g)), regra: Math.max(0, REGRAS_MACRO.indexOf(g.rule)),
      lo: paraCampo(num(g.low_g)), hi: paraCampo(num(g.high_g)),
    };
  });
  return r;
}

function renderMetas() {
  const el = $('#metas');
  if (!cache.settings || !estado.metas) { el.innerHTML = ''; return; }
  const peso = pesoReferencia();
  const cartoes = MACROS.map((x) => {
    const mm = estado.metas[x.k];
    const nomeCurto = x.k === 'carb' ? 'Carboidrato' : x.nome;
    const regras = ['Mínimo', 'Faixa', 'Máximo'].map((rot, i) => `<button type="button" class="press" data-acao="metas-regra" data-k="${x.k}" data-i="${i}" aria-pressed="${i === mm.regra}">${rot}</button>`).join('');
    let extra = '';
    if (mm.regra === 0) extra = `<p class="texto-regra num" id="m-texto-${x.k}">Conta como batida a partir de ${esc(mm.meta || '0')} g. Passar da meta é ok.</p>`;
    if (mm.regra === 1) extra = `<div class="linha-faixa"><span>Aceitável de</span>
        <input class="num campo-curto" type="text" inputmode="decimal" aria-label="Mínimo de ${nomeCurto} em gramas" value="${esc(mm.lo)}" data-campo="metas" data-k="${x.k}" data-c="lo" data-seleciona>
        <span>a</span>
        <input class="num campo-curto" type="text" inputmode="decimal" aria-label="Máximo de ${nomeCurto} em gramas" value="${esc(mm.hi)}" data-campo="metas" data-k="${x.k}" data-c="hi" data-seleciona>
        <span>g</span></div>`;
    if (mm.regra === 2) extra = `<div class="linha-faixa"><span>Não passar de</span>
        <input class="num campo-curto" type="text" inputmode="decimal" aria-label="Limite de ${nomeCurto} em gramas" value="${esc(mm.hi)}" data-campo="metas" data-k="${x.k}" data-c="hi" data-seleciona>
        <span>g por dia</span></div>`;
    return `<section class="cartao-macro">
      <div class="cm-topo"><span class="ponto" style="background:${x.cor}" aria-hidden="true"></span><h2>${nomeCurto}</h2>
        <span class="cm-info num" id="m-info-${x.k}"></span></div>
      <div class="linha-campo"><label for="meta-${x.k}">Meta diária</label>
        <div class="campo w112"><input id="meta-${x.k}" class="num" type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off"
          value="${esc(mm.meta)}" data-campo="metas" data-k="${x.k}" data-c="meta" data-seleciona><span class="unidade">g</span></div></div>
      <div class="grade-opcoes regras" role="group" aria-label="Regra de ${nomeCurto}">${regras}</div>
      ${extra}</section>`;
  }).join('');
  el.innerHTML = `
    <div class="barra-topo">
      <button type="button" class="btn-circ press" data-acao="voltar" aria-label="Voltar">${ic(P.voltar, 20, 2.2)}</button>
      <button type="button" class="btn-escuro so-texto press" data-acao="metas-salvar">Salvar</button>
    </div>
    <header class="cabecalho cabecalho-pilha"><p class="sobretitulo num">Peso de referência ${fmt.d1(peso)} kg · média 7 dias</p>
      <h1 class="titulo">Metas de macros</h1></header>
    <section class="cartao metas-soma" aria-live="polite" id="metas-soma"></section>
    ${cartoes}`;
  atualizarMetas();
}

function atualizarMetas() {
  const m = estado.metas;
  const meta = metaKcalEm(R.hojeSP());
  const peso = pesoReferencia();
  const kc = (k, f) => (num(m[k].meta) || 0) * f;
  const pk = kc('protein', 4); const ck = kc('carb', 4); const gk = kc('fat', 9);
  const soma = pk + ck + gk;
  const tot = soma || 1;
  const diff = soma - meta;
  const fora = Math.abs(diff) / meta > 0.03;
  const pct = (x) => Math.round((x / tot) * 100) + '%';
  $('#metas-soma').innerHTML = `
    <div class="ms-topo"><div class="col2"><span class="rotulo-12">As metas somam</span>
      <p class="ms-valor num"><span class="n">${fmt.int(soma)}</span><span class="u">de ${fmt.int(meta)} kcal</span></p></div>
      <span class="chip chip-26 num ${fora ? 'c-alerta' : 'c-ok'}">${fora ? sinal(diff) + ' kcal' : 'Fecha com a meta'}</span></div>
    <div class="divisao" role="img" aria-label="Divisão das calorias: proteína ${pct(pk)}, carboidrato ${pct(ck)}, gordura ${pct(gk)}">
      <span class="bg-prot" style="width:${pct(pk)}"></span><span class="bg-carb" style="width:${pct(ck)}"></span><span class="bg-gord" style="width:${pct(gk)}"></span></div>
    <div class="ms-legenda num"><span>Proteína ${pct(pk)}</span><span>Carboidrato ${pct(ck)}</span><span>Gordura ${pct(gk)}</span></div>
    ${fora ? `<button type="button" class="btn-claro press" data-acao="metas-carbo">Ajustar carboidrato para fechar ${fmt.int(meta)}</button>` : ''}`;
  MACROS.forEach((x) => {
    const g = num(m[x.k].meta) || 0;
    const info = $('#m-info-' + x.k);
    if (info) info.textContent = `${fmt.d1(g / peso)} g/kg · ${fmt.int(g * x.f)} kcal`;
    const t = $('#m-texto-' + x.k);
    if (t) t.textContent = `Conta como batida a partir de ${m[x.k].meta || '0'} g. Passar da meta é ok.`;
  });
}

function salvarMetas() {
  const m = estado.metas;
  const atuais = metasMacro();
  for (const x of MACROS) {
    const mm = m[x.k];
    const alvo = num(mm.meta);
    if (!(alvo > 0)) { aviso(`Preencha a meta de ${x.nome.toLowerCase()}.`); return; }
    const regra = REGRAS_MACRO[mm.regra];
    const lo = num(mm.lo); const hi = num(mm.hi);
    if (regra === 'range' && !(lo !== null && hi !== null && lo <= alvo && alvo <= hi)) { aviso(`A faixa de ${x.nome.toLowerCase()} precisa conter a meta.`); return; }
    if (regra === 'max' && !(hi !== null && hi >= alvo)) { aviso(`O limite de ${x.nome.toLowerCase()} precisa ser maior que a meta.`); return; }
    gravarLinha('macro_goals', {
      id: atuais[x.k] ? atuais[x.k].id : novoId(), macro: x.k, target_g: alvo, rule: regra,
      low_g: regra === 'range' ? lo : null, high_g: regra === 'min' ? null : hi,
    });
  }
  processarFila();
  vibrar(10);
  aviso('Metas salvas');
  voltar();
}

/* ---------- 4i. Check-in semanal ---------- */

const FITA = [
  ['braco', 'Braço', 'Contraído, no ponto mais grosso'],
  ['ombros', 'Ombros', 'Maior circunferência, braços relaxados'],
  ['peitoral', 'Peitoral', 'Linha dos mamilos, depois de expirar'],
  ['abdomen', 'Abdômen', 'Altura do umbigo, relaxado'],
  ['coxa', 'Coxa', 'Meio da coxa, perna relaxada'],
  ['gluteos', 'Glúteos', 'Ponto de maior volume, pés juntos'],
  ['panturrilha', 'Panturrilha', 'Parte mais grossa, em pé'],
];

function rascunhoCheckin(w) {
  const ck = derivados().checkins.get(w);
  const v = {};
  FITA.forEach(([k]) => { v[k] = ck ? paraCampo(num(ck[CAMPOS_FITA[k]])) : ''; });
  const r = ck ? [ck.skinfold_1_mm, ck.skinfold_2_mm, ck.skinfold_3_mm].map((x) => paraCampo(num(x))) : ['', '', ''];
  return { w, v, r };
}

/** Semana anterior com check-in (para os "vs sem. 6"). */
function checkinAnterior(w) {
  const d = derivados();
  for (let i = w - 1; i >= 1; i--) if (d.checkins.has(i)) return { n: i, m: d.medidas[i] };
  return null;
}

function renderCheckin() {
  const el = $('#checkin');
  const ck = estado.checkin;
  if (!ck || !cache.settings) { el.innerHTML = ''; return; }
  const ant = checkinAnterior(ck.w);
  const leituras = ck.r.map((val, i) => `<div><label class="rotulo" for="dobra-${i}">${i + 1}ª leitura</label>
      <div class="campo-medida${num(val) !== null ? ' cheio' : ''}" id="box-dobra-${i}"><input id="dobra-${i}" class="num" type="text" inputmode="decimal"
        enterkeyhint="next" autocomplete="off" placeholder="–" value="${esc(val)}" data-campo="ck-dobra" data-i="${i}" data-seleciona>
        <span class="unidade">mm</span></div></div>`).join('');
  const fita = FITA.map(([k, nome, hint]) => `<div class="medida-linha">
      <div class="il-texto"><label for="m-${k}">${nome}</label><span class="medida-hint">${hint}</span></div>
      <div class="medida-dir">
        <div class="campo-medida fita-campo${num(ck.v[k]) !== null ? ' cheio' : ''}" id="box-${k}"><input id="m-${k}" class="num" type="text" inputmode="decimal"
          enterkeyhint="next" autocomplete="off" placeholder="–" value="${esc(ck.v[k])}" data-campo="ck-fita" data-k="${k}" data-seleciona>
          <span class="unidade">cm</span></div>
        <span class="medida-delta num" id="delta-${k}"></span></div></div>`).join('');
  el.innerHTML = `
    <div class="barra-topo">
      <button type="button" class="btn-circ press" data-acao="voltar" aria-label="Voltar">${ic(P.voltar, 20, 2.2)}</button>
      <span class="feitas num" id="ck-feitas"></span>
    </div>
    <header class="cabecalho cabecalho-pilha"><h1 class="titulo">Check-in semanal</h1>
      <p class="sobretitulo">Semana ${ck.w} · ${minuscula(dataLonga(R.inicioDaSemana(ck.w, cfg().inicio)))}</p></header>
    <div class="progresso-8" role="progressbar" aria-label="Medidas preenchidas" aria-valuemin="0" aria-valuemax="8" id="ck-progresso"></div>
    <div class="aviso-violeta">${ic(P.info, 20)}<p>Em jejum, sempre do mesmo lado do corpo e com a fita firme, sem apertar.</p></div>

    <h2 class="h2-15 titulo-bloco">Gordura abdominal</h2>
    <section class="cartao-checkin surgir">
      <div class="ck-topo"><span class="icone-36 icone-violeta">${ic(P.gota, 19)}</span>
        <div class="col2"><span class="cl-titulo t16">Dobra abdominal</span>
        <span class="medida-hint">Adipômetro · 2 cm ao lado do umbigo · 3 leituras</span></div></div>
      <div class="leituras">${leituras}</div>
      <div class="media-dobra" aria-live="polite">
        <div><span class="cc-hint">Média desta semana</span><span class="n num" id="ck-media"></span></div>
        <div><span class="chip chip-26 num" id="ck-chip"></span><span class="cc-hint num">limite +${fmt.d1(cfg().limiteDobra)} mm/semana</span></div>
      </div>
    </section>

    <div class="titulo-bloco"><h2 class="h2-15">Fita métrica</h2><span class="cc-hint">em centímetros</span></div>
    <section class="cartao-checkin fita surgir atraso-60">${fita}</section>

    <button type="button" class="btn-principal press mt12" data-acao="checkin-salvar">Salvar check-in</button>
    <p class="msg-suave">${ant ? '' : 'Primeira medição: ela vira a base para as próximas. '}Pode salvar parcial e completar ao longo do dia.</p>`;
  atualizarCheckin();
}

function atualizarCheckin() {
  const ck = estado.checkin;
  const ant = checkinAnterior(ck.w);
  const lim = cfg().limiteDobra;
  const leituras = ck.r.map(num).filter((x) => x !== null);
  const media = R.media(leituras);
  const feitas = (leituras.length === 3 ? 1 : 0) + FITA.filter(([k]) => num(ck.v[k]) !== null).length;
  $('#ck-feitas').textContent = `${feitas} de 8 medidas`;
  const prog = $('#ck-progresso');
  prog.setAttribute('aria-valuenow', String(feitas));
  prog.innerHTML = Array.from({ length: 8 }, (_, i) => `<span class="${i < feitas ? 'on' : ''}"></span>`).join('');
  $('#ck-media').innerHTML = `${media === null ? '–' : fmt.d1(media)} <small>mm</small>`;
  const chip = $('#ck-chip');
  const dobraAnt = ant ? ant.m.dobra : null;
  if (media !== null && dobraAnt !== null) {
    const d = media - dobraAnt;
    const acima = d > lim + 1e-9;
    chip.className = `chip chip-26 num ${acima ? 'c-alerta' : 'c-ok'}`;
    chip.textContent = acima ? `${sinal(d, fmt.d1, 0.04)} mm · acima do limite` : `${sinal(d, fmt.d1, 0.04)} mm vs sem. ${ant.n}`;
  } else {
    chip.className = 'chip chip-26 num c-neutro';
    chip.textContent = dobraAnt !== null ? `sem. ${ant.n}: ${fmt.d1(dobraAnt)} mm` : 'primeira medição';
  }
  FITA.forEach(([k]) => {
    const n = num(ck.v[k]);
    const box = $('#box-' + k);
    box.classList.toggle('cheio', n !== null);
    const el = $('#delta-' + k);
    const antes = ant ? ant.m[k] : null;
    el.classList.toggle('cheio', n !== null && antes !== null);
    if (n !== null && antes !== null) el.textContent = `${sinal(n - antes, fmt.d1, 0.04)} vs sem. ${ant.n}`;
    else el.textContent = antes !== null ? `sem. ${ant.n}: ${fmt.d1(antes)}` : '';
  });
  ck.r.forEach((v, i) => $('#box-dobra-' + i).classList.toggle('cheio', num(v) !== null));
}

function salvarCheckin() {
  const ck = estado.checkin;
  const atual = derivados().checkins.get(ck.w);
  const linha = {
    id: atual ? atual.id : novoId(), week_number: ck.w, date: R.inicioDaSemana(ck.w, cfg().inicio),
    skinfold_1_mm: num(ck.r[0]), skinfold_2_mm: num(ck.r[1]), skinfold_3_mm: num(ck.r[2]),
  };
  FITA.forEach(([k]) => { linha[CAMPOS_FITA[k]] = num(ck.v[k]); });
  gravarLinha('weekly_checkins', linha);
  processarFila();
  vibrar(10);
  aviso('Check-in salvo');
  voltar();
}

/* ---------- 4j. Resumo da semana ---------- */

function infoStatus(w, sem) {
  const st = sem.status;
  const aj = fmt.int(cfg().ajusteKcal);
  if (sem.media === null) return { titulo: 'Sem pesagens nesta semana', cls: 'c-neutro', icone: P.bandeira };
  if (!st) return { titulo: 'Semana de base', cls: 'c-violeta', icone: P.bandeira };
  return ({
    adaptacao: { titulo: 'Adaptação — aguarde', cls: 'c-violeta', icone: P.espera },
    abaixo: { titulo: `Abaixo do ritmo — some ${aj} kcal`, cls: 'c-alerta', icone: P.cima },
    rapido: { titulo: `Rápido demais — reduza ${aj} kcal`, cls: 'c-alerta', icone: P.baixo },
    no_ritmo: { titulo: 'No ritmo — mantenha', cls: 'c-ok', icone: P.check },
  })[st.codigo];
}

function renderSemana() {
  const el = $('#semana');
  if (!cache.settings) { el.innerHTML = carregandoHTML(); return; }
  const c = cfg();
  const lista = semanas();
  const atual = lista.length;
  if (!estado.semana || estado.semana > atual) estado.semana = Math.max(1, atual - 1);
  const w = estado.semana;
  const s = lista[w - 1];
  const info = infoStatus(w, s);

  let verd = s.media === null ? 'Nenhum peso registrado nesta semana.' : `Média de ${fmt.d2(s.media)} kg`;
  if (s.media !== null) {
    if (s.variacao !== null) verd += `, ${sinal(s.variacao, fmt.d2)} kg sobre a semana ${w - 1}.`;
    else verd += w === 1 ? '. O ritmo começa a ser medido na semana 2.' : '. Sem a média da semana anterior para comparar.';
    if (s.status && s.status.codigo === 'adaptacao') verd += ' As primeiras semanas sobem mais por água e glicogênio; avalie a partir da semana 3.';
  }
  if (w === atual) verd += ` Semana em andamento (${R.diasEntre(s.inicio, R.hojeSP()) + 1} de 7 dias).`;

  // Régua de ritmo: 0 a 2× o ideal (0,10 fica a 20%, 0,25 no meio, 0,40 a 80%).
  const escala = 2 * c.ganhoIdeal;
  const pos = (x) => Math.max(0, Math.min(100, (x / escala) * 100));
  const ritmo = s.ritmo !== null ? `
    <div class="ritmo">
      <div class="ritmo-topo"><span>Ritmo das 2 últimas semanas</span><b class="num">${sinal(s.ritmo, fmt.d2)} kg/sem</b></div>
      <div class="regua" role="img" aria-label="Ritmo ${sinal(s.ritmo, fmt.d2)} kg por semana. Faixa saudável de ${fmt.d2(c.ganhoMin)} a ${fmt.d2(c.ganhoMax)}, ideal ${fmt.d2(c.ganhoIdeal)}.">
        <div class="regua-faixas"><span class="lento" style="width:${pos(c.ganhoMin)}%"></span>
          <span class="bom" style="width:${pos(c.ganhoMax) - pos(c.ganhoMin)}%"></span><span class="rapido" style="flex:1"></span></div>
        <span class="regua-ideal" style="left:${pos(c.ganhoIdeal)}%"></span>
        <span class="regua-marcador" aria-hidden="true" style="transform: translateX(${pos(s.ritmo).toFixed(1)}%)"><span></span></span>
      </div>
      <div class="regua-rotulos num"><span style="left:0">lento</span>
        <span class="meio" style="left:${pos(c.ganhoMin)}%">${fmt.d2(c.ganhoMin)}</span>
        <span class="meio ideal" style="left:${pos(c.ganhoIdeal)}%">${fmt.d2(c.ganhoIdeal)} ideal</span>
        <span class="meio" style="left:${pos(c.ganhoMax)}%">${fmt.d2(c.ganhoMax)}</span><span style="right:0">rápido</span></div>
    </div>` : '';

  // Sugestão de calorias (Semanal AA)
  const sug = s.sugestao;
  const prox = R.inicioDaSemana(w + 1, c.inicio);
  const ehRecente = w >= atual - 1;
  let sugHTML;
  if (!sug) {
    sugHTML = `<p class="valor num"><span class="n">—</span></p><p class="porque">Registre o peso e o check-in para ter uma sugestão.</p>`;
  } else {
    const base = sug.usouMeta ? `Meta (${fmt.int(sug.base)})` : `Média real (${fmt.int(sug.base)})`;
    let porque = sug.usouMeta ? 'Sem calorias anotadas na semana: parte da meta vigente, sem ajuste.' : 'Sua média real da semana, sem ajuste.';
    if (sug.motivo === 'abaixo') porque = `${base} + ${fmt.int(sug.ajuste)} — o ritmo ficou abaixo de ${fmt.d2(c.ganhoMin)} kg/sem.`;
    if (sug.motivo === 'rapido') porque = `${base} − ${fmt.int(-sug.ajuste)} — o ritmo passou de ${fmt.d2(c.ganhoMax)} kg/sem.`;
    if (sug.motivo === 'dobra') porque = `${base} − ${fmt.int(-sug.ajuste)} — a dobra abdominal subiu acima do limite.`;
    let acao = '';
    if (ehRecente) {
      const aplicada = cache.kcal_targets.find((t) => t.effective_from === prox && num(t.kcal) === sug.valor);
      const mesma = Math.abs(sug.valor - metaKcalEm(R.hojeSP())) <= 10;
      const texto = aplicada ? `Meta da semana ${w + 1}: ${fmt.int(sug.valor)} ✓` : (mesma ? `Confirmar meta de ${fmt.int(sug.valor)}` : `Usar ${fmt.int(sug.valor)} como meta`);
      acao = `<button type="button" class="btn-aplicar press" data-acao="aplicar-meta" aria-pressed="${!!aplicada}">${texto}</button>`;
    } else {
      const seguinte = metaKcalEm(prox);
      acao = `<p class="passado num">${Math.abs(seguinte - sug.valor) <= 10 ? `Aplicada na semana ${w + 1} (${fmt.int(seguinte)})` : `Meta da semana ${w + 1} ficou em ${fmt.int(seguinte)}`}</p>`;
    }
    sugHTML = `<p class="valor num"><span class="n">${fmt.int(sug.valor)}</span><span class="u">kcal/dia</span></p><p class="porque num">${porque}</p>${acao}`;
  }

  // Números da semana
  const diasSemana = w === atual ? R.diasEntre(s.inicio, R.hojeSP()) + 1 : 7;
  const fontes = new Set();
  for (let i = 0; i < 7; i++) { const l = logDo(R.somarDias(s.inicio, i)); if (l && num(l.kcal_burned) !== null) fontes.add(l.burned_source || 'garmin'); }
  const fonte = !fontes.size ? 'sem registro' : fontes.size > 1 ? 'relógio + manual' : (fontes.has('manual') ? 'manual' : 'relógio');
  const saldoCls = s.saldoMedio === null ? '' : (s.saldoMedio < c.saldoMin || s.saldoMedio > c.saldoMax ? 'alerta' : 'ok');
  const saldoSub = s.saldoMedio === null ? 'sem gasto registrado' : (s.saldoMedio < c.saldoMin ? `abaixo de +${fmt.int(c.saldoMin)}` : s.saldoMedio > c.saldoMax ? `acima de +${fmt.int(c.saldoMax)}` : `na faixa +${fmt.int(c.saldoMin)} a +${fmt.int(c.saldoMax)}`);
  const blocos = [
    ['Média de peso', s.media === null ? '—' : fmt.d2(s.media), 'kg', `${s.diasPesados} de ${diasSemana} dias pesados`, s.diasPesados < diasSemana ? 'alerta' : ''],
    ['Ganho total', s.ganhoTotal === null ? '—' : sinal(s.ganhoTotal, fmt.d2), 'kg', `esperado ${sinal(c.ganhoIdeal * w, fmt.d2)}`, ''],
    ['Média ingerida', s.mediaKcal === null ? '—' : fmt.int(s.mediaKcal), 'kcal', s.mediaKcal === null ? `meta ${fmt.int(s.metaKcal)}` : `${sinal(s.kcalVsMeta)} vs meta ${fmt.int(s.metaKcal)}`, ''],
    ['Média gasta', s.mediaGasto === null ? '—' : fmt.int(s.mediaGasto), 'kcal', fonte, ''],
    ['Saldo médio', s.saldoMedio === null ? '—' : sinal(s.saldoMedio), 'kcal/dia', saldoSub, saldoCls],
    ['Calorias anotadas', `${s.diasKcal}/${diasSemana}`, 'dias', w === atual ? 'semana em andamento' : (s.diasKcal >= 7 ? 'semana completa' : `faltaram ${7 - s.diasKcal} dias`), ''],
  ].map(([rot, v, u, sub, cls]) => `<div class="bloco"><span class="rotulo-12">${rot}</span>
      <span class="v num">${v} <small>${u}</small></span><span class="s num ${cls}">${sub}</span></div>`).join('');

  // Medidas (Semanal Z)
  const z = s.leitura;
  const zInfo = !z ? { chip: 'Sem check-in', cls: 'c-neutro', texto: 'Faça o check-in semanal para ver a leitura das medidas.' }
    : ({
      dobra_subindo: { chip: 'Atenção', cls: 'c-alerta', texto: 'Dobra subindo rápido — atenção à gordura.' },
      qualidade: { chip: 'Ganho de qualidade', cls: 'c-ok', texto: 'Braço sobe e a dobra abdominal fica controlada.' },
      estavel: { chip: 'Estável', cls: 'c-neutro', texto: 'Estável — continue medindo.' },
    })[z.codigo];
  const dd = (v, f, u) => (v === null ? '—' : `${sinal(v, f, 0.04)} ${u}`);
  const medidas = [
    ['Braço', 'desde a semana 1', dd(s.dBracoS1, fmt.d1, 'cm')],
    ['Abdômen', 'desde a semana 1', dd(s.dAbdomenS1, fmt.d1, 'cm')],
    ['Dobra abdominal', s.dDobraAnt === null ? (w === 1 ? 'base da medição' : 'sem a semana anterior') : `${sinal(s.dDobraAnt, fmt.d1, 0.04)} vs semana anterior · limite ${fmt.d1(c.limiteDobra)}`, dd(s.dDobraS1, fmt.d1, 'mm')],
  ].map(([n, sub, v]) => `<div><dt><b>${n}</b><span class="num">${sub}</span></dt><dd class="num">${v}</dd></div>`).join('');

  el.innerHTML = `
    <header class="cabecalho"><p class="sobretitulo">Como foi a semana</p><h1 class="titulo">Resumo da semana</h1></header>
    <div class="nav-semana">
      <button type="button" class="press" data-acao="semana-mudar" data-d="-1" aria-label="Semana anterior" ${w <= 1 ? 'disabled' : ''}>${ic(P.voltar, 18, 2.2)}</button>
      <div class="centro" aria-live="polite"><b class="num">Semana ${w}</b><span class="num">${intervalo(s.inicio, s.fim)}</span></div>
      <button type="button" class="press" data-acao="semana-mudar" data-d="1" aria-label="Próxima semana" ${w >= atual ? 'disabled' : ''}>${ic(P.avancar, 18, 2.2)}</button>
    </div>
    <section class="cartao veredito" aria-labelledby="verdict-h">
      <div class="vd-topo"><span class="icone-44r ${info.cls}">${ic(info.icone, 22, 2.3)}</span>
        <div class="vd-texto"><h2 id="verdict-h">${info.titulo}</h2><p class="num">${verd}</p></div></div>
      ${ritmo}
    </section>
    <section class="sugestao" aria-labelledby="sug-h"><h2 id="sug-h">Calorias para a semana ${w + 1}</h2>${sugHTML}</section>
    <div class="blocos-2">${blocos}</div>
    <section class="cartao medidas-semana" aria-labelledby="med-h">
      <div class="energia-topo"><h2 id="med-h" class="h2-16">Medidas</h2><span class="chip chip-26 ${zInfo.cls}">${zInfo.chip}</span></div>
      <p class="texto-14">${zInfo.texto}</p>
      <dl class="lista-def">${medidas}</dl>
      <button type="button" class="btn-chip press alinhar-inicio" data-acao="abrir-checkin" data-semana="${w}">${derivados().checkins.has(w) ? 'Revisar' : 'Fazer'} o check-in da semana ${w}</button>
    </section>`;
}

/** "Usar como meta": cria a meta da próxima semana (ou desfaz, se já estava aplicada). */
function aplicarMeta() {
  const c = cfg();
  const w = estado.semana;
  const s = semanas()[w - 1];
  if (!s || !s.sugestao) return;
  const prox = R.inicioDaSemana(w + 1, c.inicio);
  const existente = cache.kcal_targets.find((t) => t.effective_from === prox);
  if (existente && num(existente.kcal) === s.sugestao.valor) {
    apagarLinha('kcal_targets', existente.id);
  } else {
    gravarLinha('kcal_targets', {
      id: existente ? existente.id : novoId(), effective_from: prox, kcal: s.sugestao.valor, reason: `Sugestão da semana ${w}`,
    });
    vibrar(10);
  }
  processarFila();
  renderSemana();
}

/* ---------- 4k. Evolução (gráficos em SVG, sem biblioteca) ---------- */

/** Escala linear do gráfico: x e y em unidades de dado → pixels. */
function escalaGrafico(W, H, x0, x1, y0, y1) {
  const PX = 8; const PT = 14; const PB = 12;
  return {
    x: (v) => PX + ((v - x0) / ((x1 - x0) || 1)) * (W - 2 * PX),
    y: (v) => PT + (1 - (v - y0) / ((y1 - y0) || 1)) * (H - PT - PB),
    base: H - PB,
  };
}
const caminho = (pts, s) => pts.map((p, i) => (i ? 'L' : 'M') + s.x(p[0]).toFixed(1) + ' ' + s.y(p[1]).toFixed(1)).join(' ');
const area = (pts, s) => (pts.length ? caminho(pts, s) + ` L${s.x(pts[pts.length - 1][0]).toFixed(1)} ${s.base} L${s.x(pts[0][0]).toFixed(1)} ${s.base} Z` : '');
const bolinhas = (pts, s, r) => pts.map((p) => {
  const cx = s.x(p[0]); const cy = s.y(p[1]);
  return `M${(cx - r).toFixed(1)} ${cy.toFixed(1)} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;
}).join(' ');

function gradeY(y0, y1) {
  const faixa = y1 - y0;
  const passo = faixa <= 3 ? 0.5 : faixa <= 6 ? 1 : 2;
  const v = [];
  for (let g = Math.ceil(y0 / passo) * passo; g <= y1 + 1e-9; g += passo) v.push(arred(g, 2));
  return { v, casas: passo < 1 ? 1 : 0 };
}

function dadosGrafico(modo) {
  const c = cfg();
  const d = derivados();
  const hoje = R.hojeSP();
  const lista = semanas();
  const total = Math.max(0, R.diasEntre(c.inicio, hoje));
  const comMedia = lista.filter((s) => s.media !== null);
  const leg = {
    ponto: (rot) => `<li><span class="leg-ponto" aria-hidden="true"></span>${rot}</li>`,
    linha: (rot) => `<li><span class="leg-linha" aria-hidden="true"></span>${rot}</li>`,
    trac: (rot) => `<li><span class="leg-trac" aria-hidden="true"></span>${rot}</li>`,
    tracV: (rot) => `<li><span class="leg-trac-v" aria-hidden="true"></span>${rot}</li>`,
  };

  if (modo === 0) {
    const pts = [];
    const ma = [];
    for (let i = 0; i <= total; i++) {
      const iso = R.somarDias(c.inicio, i);
      if (d.pesos[iso] !== undefined) pts.push([i, d.pesos[iso]]);
      const m = R.mediaPeso7(d.pesos, iso);
      if (m !== null) ma.push([i, m]);
    }
    if (pts.length < 2) return null;
    const ideal = [[0, c.pesoInicial], [Math.max(total, 1), c.pesoInicial + c.ganhoIdeal * (Math.max(total, 1) / 7)]];
    const ys = pts.map((p) => p[1]).concat(ideal.map((p) => p[1]));
    const ult = pts[pts.length - 1];
    const isoUlt = R.somarDias(c.inicio, ult[0]);
    const xl = [0, 1, 2, 3].map((k) => Math.round((total * k) / 3)).filter((x, i, a) => a.indexOf(x) === i);
    return {
      x0: 0, x1: Math.max(total, 1), y0: Math.min(...ys) - 0.2, y1: Math.max(...ys) + 0.2,
      principal: ma, area: ma, pontos: pts, r: 2.6, ideal, proj: null,
      destaque: ult, balao: `${isoUlt === hoje ? 'Hoje' : diaMes(isoUlt)} · ${fmt.d1(ult[1])}`,
      xl: xl.map((x) => [x, diaMes(R.somarDias(c.inicio, x))]),
      legenda: leg.ponto('Pesagem') + leg.linha('Média 7 dias') + leg.trac('Ritmo ideal'),
      rotulo: `Peso diário de ${diaMes(c.inicio)} a ${diaMes(hoje)}, com média de 7 dias e linha do ritmo ideal.`,
    };
  }

  if (modo === 1) {
    if (!comMedia.length) return null;
    const pts = comMedia.map((s) => [s.n, s.media]);
    const n1 = pts[0][0]; const n2 = pts[pts.length - 1][0];
    const ideal = [[n1, c.pesoInicial + c.ganhoIdeal * n1], [n2, c.pesoInicial + c.ganhoIdeal * n2]];
    const ys = pts.map((p) => p[1]).concat(ideal.map((p) => p[1]));
    const ult = pts[pts.length - 1];
    const x0 = n1 === n2 ? n1 - 0.5 : n1; const x1 = n1 === n2 ? n2 + 0.5 : n2;
    const passo = Math.max(1, Math.ceil((n2 - n1 + 1) / 8));
    const xl = [];
    for (let n = n1; n <= n2; n += passo) xl.push([n, 'S' + n]);
    return {
      x0, x1, y0: Math.min(...ys) - 0.2, y1: Math.max(...ys) + 0.2,
      principal: pts, area: pts, pontos: pts, r: 3.4, ideal, proj: null,
      destaque: ult, balao: `S${ult[0]} · ${fmt.d2(ult[1])}`, xl,
      legenda: leg.linha('Média semanal') + leg.trac(`Esperado +${fmt.d2(c.ganhoIdeal)}/sem`),
      rotulo: `Média semanal de peso das semanas ${n1} a ${n2} contra o peso esperado.`,
    };
  }

  // Até a meta: real, ritmo ideal até o alvo e projeção no ritmo atual.
  const fechadas = (lista.length > 1 ? lista.slice(0, -1) : lista).filter((s) => s.media !== null);
  const real = [[0, c.pesoInicial]].concat(fechadas.map((s) => [s.n, s.media]));
  const ultSem = fechadas[fechadas.length - 1];
  const comRitmo = [...fechadas].reverse().find((s) => s.ritmo !== null);
  const proj = ultSem && comRitmo ? R.projecaoAlvo(c, ultSem.n, ultSem.media, comRitmo.ritmo) : null;
  const xIdeal = (c.pesoAlvo - c.pesoInicial) / c.ganhoIdeal;
  const x1 = Math.ceil(Math.max(xIdeal, proj ? proj.x : 0, ultSem ? ultSem.n : 1)) + 0.5;
  const ys = real.map((p) => p[1]).concat([c.pesoAlvo]);
  const meses = [];
  const ini = partesData(c.inicio);
  for (let k = 0; k < 24; k++) {
    const m = (ini.m - 1 + k) % 12; const a = ini.a + Math.floor((ini.m - 1 + k) / 12);
    const iso = `${a}-${String(m + 1).padStart(2, '0')}-01`;
    const x = k === 0 ? 0 : R.diasEntre(c.inicio, iso) / 7;
    if (x > x1) break;
    meses.push([x, MESES_CURTOS[m]]);
  }
  const salto = Math.max(1, Math.ceil(meses.length / 4));
  return {
    x0: 0, x1, y0: Math.min(...ys) - 0.4, y1: c.pesoAlvo + 0.4,
    principal: real, area: real, pontos: real.slice(1), r: 2.6,
    ideal: [[0, c.pesoInicial], [xIdeal, c.pesoAlvo]],
    proj: proj ? [[ultSem.n, ultSem.media], [proj.x, c.pesoAlvo]] : null,
    destaque: proj ? [proj.x, c.pesoAlvo] : real[real.length - 1],
    balao: proj ? `${fmt.int(c.pesoAlvo)} kg ≈ ${diaMes(proj.data)}` : (ultSem ? `S${ultSem.n} · ${fmt.d2(ultSem.media)}` : 'Início'),
    xl: meses.filter((_, i) => i % salto === 0),
    legenda: leg.linha('Real') + (proj ? leg.tracV(`Projeção ${sinal(comRitmo.ritmo, fmt.d2)}/sem`) : '') + leg.trac('Ritmo ideal'),
    rotulo: proj ? `Projeção até o alvo: no ritmo atual de ${fmt.d2(comRitmo.ritmo)} kg por semana, ${fmt.int(c.pesoAlvo)} kg por volta de ${diaMes(proj.data)}.`
      : 'Peso médio por semana até agora, com a linha do ritmo ideal até o alvo.',
  };
}

function graficoHTML(modo, largura) {
  const g = dadosGrafico(modo);
  if (!g) return '<div class="vazio-grafico">Registre o peso por alguns dias para ver o gráfico.</div>';
  const W = Math.max(200, largura - 36);
  const H = 180;
  const s = escalaGrafico(W, H, g.x0, g.x1, g.y0, g.y1);
  const grade = gradeY(g.y0, g.y1);
  const hx = s.x(g.destaque[0]); const hy = s.y(g.destaque[1]);
  const balaoX = Math.max(60, Math.min(36 + hx, largura - 44));
  const balaoY = hy < 44 ? hy + 12 : hy - 36;
  return `<div class="grafico">
      ${grade.v.map((v) => `<span class="eixo-y num" style="top:${(s.y(v) - 8).toFixed(1)}px">${nf(grade.casas, grade.casas).format(v)}</span>`).join('')}
      <svg role="img" aria-label="${esc(g.rotulo)}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <defs><linearGradient id="evoArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style="stop-color:var(--violeta)" stop-opacity="0.22"/><stop offset="1" style="stop-color:var(--violeta)" stop-opacity="0"/></linearGradient></defs>
        <path d="${grade.v.map((v) => `M0 ${s.y(v).toFixed(1)} H${W}`).join(' ')}" fill="none" style="stroke:var(--grade)" stroke-width="1"/>
        <path d="${area(g.area, s)}" fill="url(#evoArea)" stroke="none"/>
        <path d="${caminho(g.ideal, s)}" fill="none" style="stroke:var(--texto)" stroke-opacity="0.38" stroke-width="1.6" stroke-dasharray="4 4" stroke-linecap="round"/>
        ${g.proj ? `<path d="${caminho(g.proj, s)}" fill="none" style="stroke:var(--violeta)" stroke-width="2.2" stroke-dasharray="5 5" stroke-linecap="round"/>` : ''}
        <path d="${bolinhas(g.pontos, s, g.r)}" style="fill:var(--violeta-ponto)" stroke="none"/>
        <path d="${caminho(g.principal, s)}" fill="none" style="stroke:var(--violeta)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="6" style="fill:var(--violeta);stroke:var(--cartao)" stroke-width="3"/>
      </svg>
      <span class="balao num" style="left:${balaoX.toFixed(1)}px;top:${balaoY.toFixed(1)}px">${g.balao}</span>
      ${g.xl.map(([x, rot]) => `<span class="eixo-x num" style="left:${Math.max(18, Math.min(36 + s.x(x), largura - 18)).toFixed(1)}px">${rot}</span>`).join('')}
    </div>
    <ul class="legenda" aria-label="Legenda">${g.legenda}</ul>`;
}

function sparkHTML(valores, cls) {
  const pts = valores.length === 1
    ? [[32, 12]]
    : (() => {
      const mn = Math.min(...valores); const mx = Math.max(...valores); const r = (mx - mn) || 1;
      return valores.map((v, i) => [2 + (i / (valores.length - 1)) * 60, 20 - ((v - mn) / r) * 16]);
    })();
  const ult = pts[pts.length - 1];
  return `<svg width="64" height="24" viewBox="0 0 64 24" aria-hidden="true" class="${cls}">
    <path d="${pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ')}" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${ult[0].toFixed(1)}" cy="${ult[1].toFixed(1)}" r="2.8" stroke="none"/></svg>`;
}

function renderEvolucao() {
  const el = $('#evolucao');
  if (!cache.settings) { el.innerHTML = carregandoHTML(); return; }
  const c = cfg();
  const d = derivados();
  const hoje = R.hojeSP();
  const lista = semanas();
  const total = Math.max(0, R.diasEntre(c.inicio, hoje));
  const m7 = R.mediaPeso7(d.pesos, hoje);
  const ganho = m7 === null ? null : m7 - c.pesoInicial;

  // A semana em andamento ainda está incompleta: os números usam a última semana fechada.
  const fechadas = lista.length > 1 ? lista.slice(0, -1) : lista;
  const comRitmo = [...fechadas].reverse().find((s) => s.ritmo !== null);
  const comMedia = [...fechadas].reverse().find((s) => s.media !== null);
  const proj = comRitmo && comMedia ? R.projecaoAlvo(c, comMedia.n, comMedia.media, comRitmo.ritmo) : null;
  const rotSt = comRitmo && comRitmo.status ? ({
    no_ritmo: ['no ritmo', 'ok'], abaixo: ['abaixo do ritmo', 'alerta'], rapido: ['rápido demais', 'alerta'], adaptacao: ['adaptação', ''],
  })[comRitmo.status.codigo] : ['', ''];

  // Superávit médio por semana (Semanal AC)
  const comSaldo = lista.filter((s) => s.saldoMedio !== null).slice(-8);
  const maxV = Math.max(450, ...comSaldo.map((s) => s.saldoMedio * 1.1));
  const altura = (v) => Math.max(4, (Math.max(0, v) / maxV) * 140);
  const faixaTopo = 162 - (c.saldoMax / maxV) * 140;
  const faixaAlt = ((c.saldoMax - c.saldoMin) / maxV) * 140;
  const barras = comSaldo.map((s) => {
    const v = s.saldoMedio;
    const dentro = v >= c.saldoMin && v <= c.saldoMax;
    return `<div class="barra-sem"><b class="num">${sinal(v)}</b><span class="${dentro ? 'na-faixa' : ''}" style="height:${altura(v).toFixed(1)}px"></span></div>`;
  }).join('');
  const abaixo = comSaldo.filter((s) => s.saldoMedio < c.saldoMin).map((s) => s.n);
  const acima = comSaldo.filter((s) => s.saldoMedio > c.saldoMax).map((s) => s.n);
  const juntar = (ns) => (ns.length === 1 ? `Semana ${ns[0]}` : `Semanas ${ns.slice(0, -1).join(', ')} e ${ns[ns.length - 1]}`);
  const partes = [];
  if (abaixo.length) partes.push(`${juntar(abaixo)} abaixo da faixa`);
  if (acima.length) partes.push(`${juntar(acima)} acima da faixa`);
  let nota = partes.length ? partes.join(' · ') : `Todas as semanas dentro da faixa de +${fmt.int(c.saldoMin)} a +${fmt.int(c.saldoMax)}`;
  const metasOrd = [...cache.kcal_targets].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  if (metasOrd.length > 1) {
    const ult = metasOrd[metasOrd.length - 1]; const pen = metasOrd[metasOrd.length - 2];
    const dif = num(ult.kcal) - num(pen.kcal);
    if (dif) nota += ` → meta ${dif > 0 ? 'subiu' : 'desceu'} ${fmt.int(Math.abs(dif))} kcal, para ${fmt.int(num(ult.kcal))}, na semana ${R.semana(ult.effective_from, c.inicio)}`;
  }
  nota += '.';

  // Medidas: sparklines das semanas com check-in
  const semanasCk = [...d.checkins.keys()].sort((a, b) => a - b);
  const linha = (nome, chave, cls, gord) => {
    const vals = semanasCk.map((w) => d.medidas[w][chave]).filter((v) => v !== null);
    if (!vals.length) return '';
    return `<div class="linha-spark${gord ? ' gord' : ''}"><span class="nome">${nome}</span>${sparkHTML(vals, cls)}
      <span class="v num">${fmt.d1(vals[vals.length - 1])}</span><span class="d num">${sinal(vals[vals.length - 1] - vals[0], fmt.d1, 0.04)}</span></div>`;
  };
  const musculo = [['Braço', 'braco'], ['Ombros', 'ombros'], ['Peitoral', 'peitoral'], ['Coxa', 'coxa'], ['Glúteos', 'gluteos'], ['Panturrilha', 'panturrilha']]
    .map(([n, k]) => linha(n, k, 'spark-musculo', false)).join('');
  const gordura = linha('Abdômen (cm)', 'abdomen', 'spark-gord', true) + linha('Dobra (mm)', 'dobra', 'spark-gord', true);
  const ultCk = [...lista].reverse().find((s) => s.leitura);
  const leitura = ultCk ? ({
    qualidade: ['ok', P.check], dobra_subindo: ['alerta', P.atencao], estavel: ['neutro', P.info],
  })[ultCk.leitura.codigo] : null;
  const medidasHTML = semanasCk.length ? `
      <div class="subtitulo-medidas"><h3>Músculo · cm</h3><span>${semanasCk.length} ${semanasCk.length === 1 ? 'semana' : 'semanas'} · atual · Δ</span></div>
      <div>${musculo}</div>
      <div class="subtitulo-medidas gord"><h3>Gordura</h3><span>limite da dobra: +${fmt.d1(c.limiteDobra)} mm/sem</span></div>
      <div>${gordura}</div>
      ${leitura ? `<div class="leitura-caixa ${leitura[0]}">${ic(leitura[1], 18, 2.4)}<p>${esc(ultCk.leitura.texto)}.</p></div>` : ''}`
    : '<p class="texto-14">As medidas aparecem aqui depois do primeiro check-in semanal.</p>';

  const largura = Math.min(480, el.clientWidth || window.innerWidth) - 76;
  el.innerHTML = `
    <header class="cabecalho"><p class="sobretitulo num">${diaMes(c.inicio)} – ${diaMes(hoje)} · ${total + 1} ${total ? 'dias' : 'dia'}</p>
      <h1 class="titulo">Evolução</h1></header>
    <section class="cartao" aria-labelledby="peso-h">
      <div class="evo-topo">
        <div class="col2"><h2 id="peso-h">Peso · média 7 dias</h2>
          <p class="evo-valor num"><span class="n">${m7 === null ? '—' : fmt.d2(m7)}</span><span class="u">kg</span></p></div>
        <div class="evo-dir">${ganho === null ? '' : `<span class="chip chip-26 chip-icone num c-violeta">${ic(ganho >= 0 ? P.cima : P.baixo, 14, 2.6)}${fmt.d2(Math.abs(ganho))} kg</span>`}
          <span class="cc-hint">desde ${diaMes(c.inicio)}</span></div>
      </div>
      ${segmentadoHTML({ acao: 'evo-modo', opcoes: ['Diário', 'Semanal', 'Até a meta'], sel: estado.evoModo, rotulo: 'Período do gráfico' })}
      <div id="evo-grafico">${graficoHTML(estado.evoModo, largura)}</div>
    </section>
    <div class="blocos-3">
      <div class="bloco-p"><span class="rotulo-12">Ritmo 2 sem.</span><span class="v num">${comRitmo ? sinal(comRitmo.ritmo, fmt.d2) : '—'}</span>
        <span class="s ${rotSt[1]}">kg/sem${rotSt[0] ? ' · ' + rotSt[0] : ''}</span></div>
      <div class="bloco-p"><span class="rotulo-12">Vs. esperado</span><span class="v num">${comMedia ? sinal(comMedia.media - comMedia.esperado, fmt.d2) : '—'}</span>
        <span class="s">kg${comMedia ? ' · semana ' + comMedia.n : ''}</span></div>
      <div class="bloco-p"><span class="rotulo-12">${fmt.int(c.pesoAlvo)} kg em</span><span class="v num">${proj ? '≈ ' + diaMes(proj.data) : '—'}</span>
        <span class="s">${proj ? 'neste ritmo' : 'sem ritmo ainda'}</span></div>
    </div>
    <section class="cartao cartao-12" aria-labelledby="kcal-h">
      <div class="col2"><h2 id="kcal-h" class="h2-16">Superávit médio por semana</h2><p class="p13">Ingeridas − gastas, em kcal/dia</p></div>
      ${comSaldo.length ? `<div class="barras" role="img" aria-label="Superávit médio: ${comSaldo.map((s) => `semana ${s.n} ${sinal(s.saldoMedio)}`).join(', ')} kcal por dia. Faixa ideal de +${c.saldoMin} a +${c.saldoMax}.">
        <div class="barras-faixa" style="top:${faixaTopo.toFixed(1)}px;height:${faixaAlt.toFixed(1)}px"></div>
        <span class="barras-faixa-rotulo" style="top:${(faixaTopo + faixaAlt / 2 - 7).toFixed(1)}px">faixa +${fmt.int(c.saldoMin)} a +${fmt.int(c.saldoMax)}</span>
        <div class="barras-col">${barras}</div></div>
      <div class="barras-x num">${comSaldo.map((s) => `<span>S${s.n}</span>`).join('')}</div>
      <p class="nota-caixa">${nota}</p>` : '<p class="texto-14">O superávit aparece quando houver refeições e gasto registrados no mesmo dia.</p>'}
    </section>
    <section class="cartao cartao-6" aria-labelledby="med-evo-h">
      <div class="col2 pb6"><h2 id="med-evo-h" class="h2-16">Medidas</h2>
        <p class="p13">${semanasCk.length ? `Semana ${semanasCk[semanasCk.length - 1]} · variação desde a semana ${semanasCk[0]}` : 'Check-in semanal'}</p></div>
      ${medidasHTML}
    </section>`;
}

/* ---------- 4l. Ajustes ---------- */

function linhaAjuste({ acao, titulo, sub = '', valor = '', alta = false, dados = '' }) {
  return `<button type="button" class="linha-item${alta || sub ? ' alta' : ''}" data-acao="${acao}" ${dados}>
    <span class="li-texto"><span class="li-titulo">${titulo}</span>${sub ? `<span class="li-sub">${sub}</span>` : ''}</span>
    ${valor ? `<span class="li-valor num">${valor}</span>` : ''}${ic(P.avancar, 16, 2.2, ' class="chevron"')}</button>`;
}

function linhaChave({ id, titulo, sub = '', hora = '', ligado, muda, dados = '', editar = '' }) {
  const texto = hora
    ? `<span class="lca-texto"><span class="li-titulo" id="lbl-${id}">${titulo}</span><span class="lca-hora num">${hora}</span></span>`
    : `<span class="lca-texto col"><span class="li-titulo" id="lbl-${id}">${titulo}</span>${sub ? `<span class="li-sub">${sub}</span>` : ''}</span>`;
  return `<div class="linha-chave-ajuste${sub ? ' alta' : ''}">
    ${editar ? `<button type="button" class="lca-botao press" ${editar}>${texto}</button>` : texto}
    ${chaveHTML(id, ligado, `aria-labelledby="lbl-${id}" data-muda="${muda}" ${dados}`)}</div>`;
}

function ultimaSincGarmin() {
  let ult = null;
  cache.daily_logs.forEach((l) => { if (l.garmin_synced_at && (!ult || l.garmin_synced_at > ult)) ult = l.garmin_synced_at; });
  return ult;
}

function renderAjustes() {
  const el = $('#ajustes');
  if (!cache.settings) { el.innerHTML = carregandoHTML(); return; }
  const s = cache.settings;
  const c = cfg();
  const metas = metasMacro();
  const metaAtual = metaKcalEm(R.hojeSP());
  const metasOrd = [...cache.kcal_targets].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const anterior = metasOrd.length > 1 ? num(metasOrd[metasOrd.length - 2].kcal) : null;
  const refeicoes = [...cache.meal_types].sort((a, b) => a.sort - b.sort);
  const ativas = refeicoes.filter((m) => m.active).length;
  const ultG = ultimaSincGarmin();
  let chipG = '<span class="chip chip-26 c-neutro">Não configurado</span>';
  if (API_URL && ultG && Date.now() - new Date(ultG).getTime() < 26 * 3600000) chipG = '<span class="chip chip-26 c-ok"><span class="ponto ok" aria-hidden="true"></span>Conectado</span>';
  else if (API_URL && ultG) chipG = '<span class="chip chip-26 c-alerta">Sem sincronizar</span>';
  else if (API_URL) chipG = '<span class="chip chip-26 c-neutro">Aguardando</span>';
  const pushAtivo = store.ler(CHAVES.push, false) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const diaCk = DIAS_PLURAL[R.diaDaSemana(c.inicio)];

  el.innerHTML = `
    <header class="cabecalho"><p class="sobretitulo">${esc(s.display_name || 'Você')} · bulking leve desde ${diaMes(c.inicio)}</p>
      <h1 class="titulo">Ajustes</h1></header>

    <h2 class="titulo-grupo">Objetivo</h2>
    <div class="grupo">
      ${linhaAjuste({ acao: 'editar', dados: 'data-ed="inicio"', titulo: 'Data de início', valor: dataBR(c.inicio) })}
      ${linhaAjuste({ acao: 'editar', dados: 'data-ed="pesos"', titulo: 'Peso inicial → alvo', valor: `${fmt.d1(c.pesoInicial)} → ${fmt.d1(c.pesoAlvo)} kg` })}
      ${linhaAjuste({ acao: 'editar', dados: 'data-ed="ganho"', titulo: 'Ganho semanal', sub: `ideal ${fmt.d2(c.ganhoIdeal)} · média das 2 últimas semanas`, valor: `${fmt.d2(c.ganhoMin)}–${fmt.d2(c.ganhoMax)} kg` })}
      ${linhaAjuste({ acao: 'editar', dados: 'data-ed="dobra"', titulo: 'Limite da dobra abdominal', sub: `acima disso, alerta e −${fmt.int(c.ajusteKcal)} kcal`, valor: `${fmt.d1(c.limiteDobra)} mm/sem` })}
    </div>

    <h2 class="titulo-grupo">Alimentação</h2>
    <div class="grupo">
      ${linhaAjuste({ acao: 'editar', dados: 'data-ed="kcal"', titulo: 'Meta de calorias', sub: `±${fmt.int(c.ajusteKcal)} quando fora do ritmo${anterior ? ' · era ' + fmt.int(anterior) : ''}`, valor: `${fmt.int(metaAtual)} kcal` })}
      ${linhaAjuste({ acao: 'ir', dados: 'data-tela="metas"', titulo: 'Metas de macros', sub: 'metas e limites por dia', valor: metas.protein ? `P ${fmt.int(num(metas.protein.target_g))} · C ${fmt.int(num(metas.carb.target_g))} · G ${fmt.int(num(metas.fat.target_g))}` : '' })}
      ${linhaAjuste({ acao: 'ir', dados: 'data-tela="alimentos"', titulo: 'Meus alimentos', valor: String(cache.foods.filter((f) => !f.archived).length) })}
    </div>

    <h2 class="titulo-grupo">Minhas refeições</h2>
    <div class="grupo">
      ${refeicoes.map((m) => linhaChave({
        id: 'ref-' + m.id, titulo: esc(m.name), hora: m.default_time || '—', ligado: m.active, muda: 'refeicao-ativa',
        dados: `data-id="${m.id}"`, editar: `data-acao="editar" data-ed="refeicao" data-id="${m.id}" aria-label="Editar ${esc(m.name)}"`,
      })).join('')}
      <button type="button" class="linha-item" data-acao="editar" data-ed="refeicao">${ic(P.mais, 18, 2.2, ' class="chevron"')}<span class="li-titulo">Adicionar refeição</span></button>
    </div>
    <p class="nota-grupo num">${ativas} refeições aparecem no Hoje, nesse horário. Uma refeição desligada volta a aparecer no dia em que tiver algum item.</p>

    <h2 class="titulo-grupo">Calorias gastas</h2>
    <div class="grupo">
      <button type="button" class="linha-item alta" data-acao="garmin-atualizar">
        <span class="icone-36b">${ic(P.relogio, 18, 2)}</span>
        <span class="li-texto"><span class="li-titulo">Garmin Connect</span><span class="li-sub">total do dia: ativas + repouso${ultG ? ' · ' + horaDe(ultG) : ''}</span></span>
        ${chipG}</button>
      ${linhaChave({ id: 'fallback', titulo: 'Pedir valor manual', sub: 'se o Garmin não sincronizar até 21:30', ligado: s.manual_burn_fallback, muda: 'ajuste-bool', dados: 'data-k="manual_burn_fallback"' })}
    </div>

    <h2 class="titulo-grupo">Lembretes</h2>
    <div class="grupo">
      ${linhaChave({ id: 'lemb-peso', titulo: 'Pesagem diária', sub: `todo dia às ${s.weigh_reminder_time}, em jejum`, ligado: s.remind_weigh, muda: 'lembrete', dados: 'data-k="remind_weigh"' })}
      ${linhaChave({ id: 'lemb-ck', titulo: 'Check-in semanal', sub: `${diaCk}, junto com a pesagem`, ligado: s.remind_checkin, muda: 'lembrete', dados: 'data-k="remind_checkin"' })}
      ${linhaChave({ id: 'lemb-resumo', titulo: 'Resumo do fim do dia', sub: `${s.summary_time} · calorias, macros e progresso`, ligado: s.remind_summary, muda: 'lembrete', dados: 'data-k="remind_summary"' })}
      ${linhaAjuste({ acao: 'editar', dados: 'data-ed="horarios"', titulo: 'Horários', valor: `${s.weigh_reminder_time} · ${s.summary_time}` })}
      ${linhaAjuste({ acao: 'ativar-push', titulo: 'Notificações neste aparelho', sub: 'no iPhone, só com o BodyEvo na Tela de Início', valor: pushAtivo ? 'Ativas' : 'Ativar' })}
    </div>

    <h2 class="titulo-grupo">Dados</h2>
    <div class="grupo">
      <button type="button" class="linha-item" data-acao="importar">${ic(P.importar, 20, 1.9, ' class="dados"')}<span class="li-titulo flex1">Importar planilha (.xlsx)</span></button>
      <button type="button" class="linha-item" data-acao="editar" data-ed="exportar">${ic(P.exportar, 20, 1.9, ' class="dados"')}<span class="li-titulo flex1">Exportar planilha</span><span class="li-valor">.xlsx · .csv</span></button>
    </div>
    <p class="nota-grupo">${MODO_LOCAL ? 'Modo local: os dados ficam só neste aparelho. Exporte de vez em quando como backup.'
      : 'Os dados ficam no seu Supabase, com uma cópia neste aparelho para funcionar sem internet. Exporte de vez em quando como backup.'}</p>

    <h2 class="titulo-grupo">Conta</h2>
    <div class="grupo">
      ${linhaAjuste({ acao: 'editar', dados: 'data-ed="nome"', titulo: 'Nome', valor: esc(s.display_name || '—') })}
      ${MODO_LOCAL ? '<div class="linha-item"><span class="li-texto"><span class="li-titulo">Modo local</span><span class="li-sub">Configure o Supabase em app.js para sincronizar</span></span></div>'
        : `<button type="button" class="linha-item" data-acao="sair">${ic(P.sair, 20, 1.9, ' class="dados"')}<span class="li-texto"><span class="li-titulo">Sair da conta</span><span class="li-sub">${esc(usuario && usuario.email)}</span></span></button>`}
    </div>
    <p class="nota-grupo num" id="versao">BodyEvo</p>`;
  pedirVersao();
}

/* ---------- Editor genérico (sheet de Ajustes) ---------- */

function abrirEditor(cfgEditor) {
  estado.editor = cfgEditor;
  $('#editor-h').textContent = cfgEditor.titulo;
  const campos = (cfgEditor.campos || []).map((f) => {
    const tipo = f.tipo === 'date' || f.tipo === 'time' || f.tipo === 'text' ? f.tipo : 'text';
    const modo = f.tipo === 'decimal' ? 'inputmode="decimal"' : f.tipo === 'int' ? 'inputmode="numeric"' : '';
    const largo = f.tipo === 'text' ? ' largo' : (f.tipo === 'date' || f.tipo === 'time' ? ' medio' : '');
    return `<div class="linha-campo"><div class="col2"><label for="ed-${f.k}">${f.rotulo}</label>${f.dica ? `<span class="li-sub">${f.dica}</span>` : ''}</div>
      <div class="campo${largo}"><input id="ed-${f.k}" name="${f.k}" class="num" type="${tipo}" ${modo} autocomplete="off" enterkeyhint="done"
        value="${esc(f.valor == null ? '' : f.valor)}" ${f.tipo === 'decimal' || f.tipo === 'int' ? 'data-seleciona' : ''}>${f.sufixo ? `<span class="unidade">${f.sufixo}</span>` : ''}</div></div>`;
  }).join('');
  $('#editor-corpo').innerHTML = `
    ${campos ? `<div class="cartao-20">${campos}</div>` : ''}
    ${cfgEditor.html || ''}
    ${cfgEditor.salvar ? '<button type="submit" class="btn-principal press">Salvar</button>' : ''}
    ${cfgEditor.apagar ? `<button type="button" class="btn-texto press" data-acao="editor-apagar">${cfgEditor.apagar.rotulo}</button>` : ''}`;
  abrirSheet($('#sheet-editor'));
}

function valoresEditor() {
  const v = {};
  $$('#editor-corpo input[name]').forEach((i) => { v[i.name] = i.value.trim(); });
  return v;
}

const EDITORES = {
  inicio: () => ({
    titulo: 'Data de início',
    campos: [{ k: 'start_date', rotulo: 'Início do bulking', tipo: 'date', valor: cache.settings.start_date, dica: 'As semanas e o check-in contam a partir deste dia' }],
    salvar: (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.start_date)) return 'Escolha uma data.';
      salvarSettings({ start_date: v.start_date });
      return null;
    },
  }),
  pesos: () => ({
    titulo: 'Peso inicial e alvo',
    campos: [
      { k: 'start_weight_kg', rotulo: 'Peso inicial', tipo: 'decimal', valor: paraCampo(num(cache.settings.start_weight_kg), 2), sufixo: 'kg' },
      { k: 'target_weight_kg', rotulo: 'Peso alvo', tipo: 'decimal', valor: paraCampo(num(cache.settings.target_weight_kg), 2), sufixo: 'kg' },
    ],
    salvar: (v) => {
      const a = num(v.start_weight_kg); const b = num(v.target_weight_kg);
      if (!(a > 30 && b > 30)) return 'Confira os pesos.';
      salvarSettings({ start_weight_kg: a, target_weight_kg: b });
      return null;
    },
  }),
  ganho: () => ({
    titulo: 'Ganho semanal',
    campos: [
      { k: 'gain_min_kg', rotulo: 'Mínimo', tipo: 'decimal', valor: paraCampo(num(cache.settings.gain_min_kg), 2), sufixo: 'kg', dica: 'abaixo disso, some calorias' },
      { k: 'gain_ideal_kg', rotulo: 'Ideal', tipo: 'decimal', valor: paraCampo(num(cache.settings.gain_ideal_kg), 2), sufixo: 'kg' },
      { k: 'gain_max_kg', rotulo: 'Máximo', tipo: 'decimal', valor: paraCampo(num(cache.settings.gain_max_kg), 2), sufixo: 'kg', dica: 'acima disso, reduza calorias' },
    ],
    salvar: (v) => {
      const a = num(v.gain_min_kg); const b = num(v.gain_ideal_kg); const c = num(v.gain_max_kg);
      if (!(a !== null && b !== null && c !== null && a <= b && b <= c && b > 0)) return 'Use mínimo ≤ ideal ≤ máximo.';
      salvarSettings({ gain_min_kg: a, gain_ideal_kg: b, gain_max_kg: c });
      return null;
    },
  }),
  dobra: () => ({
    titulo: 'Limite da dobra',
    campos: [{ k: 'skinfold_limit_mm', rotulo: 'Subida máxima por semana', tipo: 'decimal', valor: paraCampo(num(cache.settings.skinfold_limit_mm), 2), sufixo: 'mm' }],
    salvar: (v) => {
      const a = num(v.skinfold_limit_mm);
      if (!(a > 0)) return 'Confira o limite.';
      salvarSettings({ skinfold_limit_mm: a });
      return null;
    },
  }),
  kcal: () => ({
    titulo: 'Meta de calorias',
    campos: [
      { k: 'kcal', rotulo: 'Meta a partir de hoje', tipo: 'int', valor: String(metaKcalEm(R.hojeSP())), sufixo: 'kcal' },
      { k: 'kcal_adjust', rotulo: 'Ajuste quando fora do ritmo', tipo: 'int', valor: String(cache.settings.kcal_adjust), sufixo: 'kcal' },
      { k: 'surplus_band_min', rotulo: 'Saldo diário ideal: de', tipo: 'int', valor: String(cache.settings.surplus_band_min), sufixo: 'kcal' },
      { k: 'surplus_band_max', rotulo: 'até', tipo: 'int', valor: String(cache.settings.surplus_band_max), sufixo: 'kcal' },
    ],
    salvar: (v) => {
      const k = num(v.kcal); const aj = num(v.kcal_adjust); const a = num(v.surplus_band_min); const b = num(v.surplus_band_max);
      if (!(k > 800) || aj === null || a === null || b === null || a > b) return 'Confira os valores.';
      const hoje = R.hojeSP();
      if (Math.round(k) !== metaKcalEm(hoje)) {
        const ex = cache.kcal_targets.find((t) => t.effective_from === hoje);
        gravarLinha('kcal_targets', { id: ex ? ex.id : novoId(), effective_from: hoje, kcal: Math.round(k), reason: 'Ajuste manual' });
      }
      salvarSettings({ kcal_adjust: Math.round(aj), surplus_band_min: Math.round(a), surplus_band_max: Math.round(b) });
      return null;
    },
  }),
  horarios: () => ({
    titulo: 'Horários',
    campos: [
      { k: 'weigh_reminder_time', rotulo: 'Lembrete de pesagem', tipo: 'time', valor: cache.settings.weigh_reminder_time },
      { k: 'summary_time', rotulo: 'Resumo do dia', tipo: 'time', valor: cache.settings.summary_time, dica: 'o pop-up abre sozinho depois deste horário' },
    ],
    salvar: (v) => {
      if (!/^\d{2}:\d{2}/.test(v.weigh_reminder_time) || !/^\d{2}:\d{2}/.test(v.summary_time)) return 'Escolha os horários.';
      salvarSettings({ weigh_reminder_time: v.weigh_reminder_time.slice(0, 5), summary_time: v.summary_time.slice(0, 5) });
      return null;
    },
  }),
  nome: () => ({
    titulo: 'Seu nome',
    campos: [{ k: 'display_name', rotulo: 'Nome', tipo: 'text', valor: cache.settings.display_name || '' }],
    salvar: (v) => { salvarSettings({ display_name: v.display_name.slice(0, 40) || null }); return null; },
  }),
  refeicao: (id) => {
    const m = id ? derivados().refeicoes.get(id) : null;
    return {
      titulo: m ? 'Editar refeição' : 'Nova refeição',
      campos: [
        { k: 'name', rotulo: 'Nome', tipo: 'text', valor: m ? m.name : '' },
        { k: 'default_time', rotulo: 'Horário', tipo: 'time', valor: m ? m.default_time : '15:00' },
      ],
      salvar: (v) => {
        if (!v.name) return 'Dê um nome à refeição.';
        if (!/^\d{2}:\d{2}/.test(v.default_time)) return 'Escolha o horário.';
        const hora = v.default_time.slice(0, 5);
        // A ordem segue o horário.
        const todas = cache.meal_types.filter((x) => !m || x.id !== m.id).concat([{ id: m ? m.id : null, default_time: hora }]);
        todas.sort((a, b) => String(a.default_time).localeCompare(String(b.default_time)));
        const novoIdRef = m ? m.id : novoId();
        todas.forEach((x, i) => {
          if (x.id === null || x.id === novoIdRef) return;
          if (x.sort !== i + 1) gravarLinha('meal_types', { ...x, sort: i + 1 });
        });
        const pos = todas.findIndex((x) => x.id === (m ? m.id : null)) + 1;
        gravarLinha('meal_types', { ...(m || {}), id: novoIdRef, name: v.name.slice(0, 40), default_time: hora, active: m ? m.active : true, sort: pos });
        processarFila();
        return null;
      },
      apagar: m ? {
        rotulo: 'Apagar refeição',
        fn: () => {
          if (cache.meal_entries.some((e) => e.meal_type_id === m.id)) {
            aviso('Essa refeição tem itens registrados. Desligue-a em vez de apagar, para não perder o histórico.', { duracao: 6000 });
            return false;
          }
          apagarLinha('meal_types', m.id); processarFila();
          return true;
        },
      } : null,
    };
  },
  exportar: () => {
    carregarXLSX().catch(() => {});   // já carrega, para o toque em "Baixar" abrir o compartilhamento na hora
    return {
      titulo: 'Exportar planilha',
      html: `<p class="texto-14">Mesmo formato de colunas da planilha AcompanhamentoPeso (abas Configuracao, Diario e Semanal).</p>
        <button type="button" class="btn-principal press" data-acao="exportar" data-tipo="xlsx">${ic(P.exportar, 20, 2)}Baixar .xlsx</button>
        <button type="button" class="btn-claro press" data-acao="exportar" data-tipo="csv">Baixar o diário em .csv</button>`,
    };
  },
};

function enviarEditor() {
  const ed = estado.editor;
  if (!ed || !ed.salvar) return;
  const erro = ed.salvar(valoresEditor());
  if (erro) { aviso(erro); return; }
  vibrar(10);
  fecharSheet();
  renderTelaAtual();
}

/* ---------- Lembretes e Web Push ---------- */

function b64urlParaBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* O iOS só entrega push para PWA na Tela de Início (16.4+), e a permissão precisa vir de um toque. */
async function ativarNotificacoes() {
  if (MODO_LOCAL) { aviso('As notificações precisam do Supabase configurado.'); return false; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
    aviso('No iPhone, as notificações só funcionam com o BodyEvo na Tela de Início (Compartilhar › Adicionar à Tela de Início).', { duracao: 7000 });
    return false;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { aviso('Notificações bloqueadas. Libere em Ajustes do iPhone › Notificações › BodyEvo.', { duracao: 6000 }); return false; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlParaBytes(VAPID_PUBLICA) });
    const j = sub.toJSON();
    enfileirarUpsert('push_subscriptions', { id: novoId(), user_id: usuario.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    processarFila();
    store.gravar(CHAVES.push, true);
    aviso('Notificações ativas neste aparelho');
    return true;
  } catch (e) {
    console.warn('Push', e);
    aviso('Não deu para ativar as notificações agora.');
    return false;
  }
}

async function mudarLembrete(input) {
  const k = input.dataset.k;
  const ligado = input.checked;
  if (ligado && !store.ler(CHAVES.push, false)) {
    const ok = await ativarNotificacoes();
    if (!ok) { input.checked = false; return; }
  }
  salvarSettings({ [k]: ligado });
  vibrar(5);
}

/* ---------- 4m. Resumo do dia (pop-up) ---------- */

const ICONE_RESUMO = { check: 'M5 12.5 9.5 17 19 7.5', down: 'M12 5v14M6 13l6 6 6-6', up: 'M12 19V5M6 11l6-6 6 6', bang: 'M12 6v8M12 18h.01' };

function renderResumo() {
  const data = estado.resumoData;
  const c = cfg();
  const s = cache.settings;
  const d = derivados();
  const tot = totaisDo(data);
  const meta = metaKcalEm(data);
  const metas = metasMacro();
  const log = logDo(data);
  const gasto = log && num(log.kcal_burned) !== null ? num(log.kcal_burned) : null;
  const saldo = R.saldoDia(tot.kcal, gasto);
  const faixa = R.faixaSaldo(saldo, c);
  const variante = R.varianteDoDia(tot.kcal, meta);
  const pct = meta ? Math.round((tot.kcal / meta) * 100) : 0;
  const dif = Math.abs(meta - tot.kcal);

  const v = {
    na_meta: { titulo: 'Dia na meta', icone: ICONE_RESUMO.check, selo: 'c-ok', cor: 'var(--kcal)' },
    abaixo: { titulo: `Faltaram ${fmt.int(dif)} kcal`, icone: ICONE_RESUMO.down, selo: 'c-alerta', cor: 'var(--kcal)' },
    acima: { titulo: `${fmt.int(dif)} kcal acima da meta`, icone: ICONE_RESUMO.up, selo: 'c-alerta', cor: 'var(--kcal-forte)' },
  }[variante];

  const tagSaldo = { faixa: ['na faixa', 'c-ok'], abaixo: ['abaixo da faixa', 'c-alerta'], deficit: ['déficit', 'c-alerta'], acima: ['acima da faixa', 'c-alerta'] }[faixa];
  let rotGasto = 'Gastas · sem registro';
  if (gasto !== null) rotGasto = log.burned_source === 'manual' ? 'Gastas · manual' : `Gastas · Garmin, ${data === R.hojeSP() ? 'até ' + (horaDe(log.garmin_synced_at) || 'agora') : 'dia inteiro'}`;

  const st = {};
  const macros = MACROS.map((m, i) => {
    const meta2 = metas[m.k];
    if (!meta2) return '';
    const val = tot[m.t];
    const r = R.statusMacro(meta2, val);
    st[m.k] = r;
    const regra = meta2.rule === 'min' ? `mín. ${fmt.int(num(meta2.target_g))}`
      : meta2.rule === 'range' ? `${fmt.int(num(meta2.low_g))}–${fmt.int(num(meta2.high_g))}` : `máx. ${fmt.int(num(meta2.high_g))}`;
    const nome = m.k === 'carb' ? 'Carboidrato' : m.nome;
    return `<li style="animation-delay:${380 + i * 50}ms"><span class="ponto" style="background:${m.cor}" aria-hidden="true"></span>
      <span class="nome">${nome}</span><span class="v num">${fmt.int(val)} g</span><span class="regra num">${regra}</span>
      <span class="rs-ok ${r.ok ? 'c-ok' : 'c-alerta'}" role="img" aria-label="${nome}: ${r.ok ? 'dentro da meta' : 'fora da meta'}">${ic(`<path d="${r.ok ? ICONE_RESUMO.check : ICONE_RESUMO.bang}"/>`, 13, 3)}</span></li>`;
  }).join('');

  // Progresso até o alvo
  const m7 = R.mediaPeso7(d.pesos, data);
  const atualPeso = m7 !== null ? m7 : c.pesoInicial;
  const caminhoKg = c.pesoAlvo - c.pesoInicial;
  const feito = caminhoKg ? Math.max(0, Math.min(1, (atualPeso - c.pesoInicial) / caminhoKg)) : 0;
  const nSem = Math.max(1, R.semana(data, c.inicio) - 1);

  // Sequências
  const diasRegistro = new Set([...d.entradas.keys(), ...Object.keys(d.pesos)]);
  const seguidos = R.diasSeguidos(diasRegistro, data);
  const protOk = new Set();
  if (metas.protein) d.totais.forEach((t, dia) => { if (R.statusMacro(metas.protein, t.p).ok) protOk.add(dia); });
  // Só celebra a sequência de proteína se ela foi batida neste dia.
  const protSeguidos = protOk.has(data) ? R.diasSeguidos(protOk, data) : 0;

  // Mensagem: muda conforme o dia, sempre encorajadora.
  const amanha = R.somarDias(data, 1);
  const lembrete = R.ehDiaDeCheckin(amanha, c.inicio)
    ? `Amanhã é dia de check-in: pesagem às ${s.weigh_reminder_time}, em jejum, e as medidas.`
    : `Amanhã: pesagem às ${s.weigh_reminder_time}, em jejum.`;
  const nomes = { protein: 'proteína', carb: 'carboidrato', fat: 'gordura' };
  let msg;
  if (variante === 'na_meta') {
    const todos = Object.values(st).every((x) => x.ok);
    msg = (todos ? 'Calorias e os três macros dentro do plano. ' : 'Calorias dentro do plano. ')
      + 'É a proteína acima do mínimo, dia após dia, que faz o superávit virar músculo. ' + lembrete;
  } else if (variante === 'abaixo') {
    const k = R.macroQueMaisPesou(tot, metas, 'abaixo');
    msg = `${k ? `Quase tudo que faltou foi ${nomes[k]}. ` : ''}Um dia assim não muda nada: o que conta é a média da semana. Para amanhã, deixe a ceia separada, que fica mais fácil fechar.`;
  } else {
    const k = R.macroQueMaisPesou(tot, metas, 'acima');
    msg = `${k ? `A maior parte do extra veio de ${nomes[k]}. ` : ''}Sem culpa e sem compensar cortando amanhã: é só voltar ao plano normal. Um dia fora não aparece na média da semana.`;
  }

  const fechado = log && log.closed_at;
  $('#resumo-cartao').innerHTML = `
    <div class="rs-topo"><span class="rs-data num">${dataLonga(data)} · ${R.horaSP()}</span>
      <button type="button" class="rs-fechar press" data-acao="resumo-revisar" aria-label="Fechar resumo">${ic(P.fechar, 16, 2.4)}</button></div>
    <div class="rs-titulo"><span class="rs-selo ${v.selo}">${ic(`<path class="desenhar" d="${v.icone}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="0"/>`, 26, 2.6)}</span>
      <div class="col2"><span class="rs-data">Resumo do dia</span><h1 id="resumo-h">${v.titulo}</h1></div></div>
    <div class="rs-numeros">
      ${anelHTML({ pct, tam: 112, r: 47, trilho: 'var(--kcal-trilho-2)', cor: v.cor, rotulo: `${fmt.int(tot.kcal)} de ${fmt.int(meta)} kcal, ${pct}% da meta`,
        centro: `<span class="anel-pct num">${fmt.int(tot.kcal)}</span><span class="anel-sub num">de ${fmt.int(meta)} kcal</span>` })}
      <dl>
        <div class="col2"><dt>${gasto !== null && log.burned_source !== 'manual' ? '<span class="ponto ok" aria-hidden="true"></span>' : ''}${rotGasto}</dt>
          <dd class="num">${gasto === null ? '—' : fmt.int(gasto) + ' kcal'}</dd></div>
        <div class="col2"><dt>Saldo</dt><dd class="rs-saldo num"><span>${saldo === null ? '—' : sinal(saldo)}</span>
          ${tagSaldo ? `<span class="chip ${tagSaldo[1]}">${tagSaldo[0]}</span>` : ''}</dd></div>
      </dl>
    </div>
    <ul class="rs-macros" aria-label="Macros do dia">${macros}</ul>
    <div class="rs-progresso">
      <div class="topo"><b>Rumo aos ${fmt.int(c.pesoAlvo)} kg</b><span class="num">${fmt.d2(atualPeso)} kg · ${sinal(atualPeso - c.pesoInicial, fmt.d2)} kg em ${nSem} ${nSem === 1 ? 'semana' : 'semanas'}</span></div>
      <div class="barra" role="img" aria-label="${Math.round(feito * 100)}% do caminho de ${fmt.int(c.pesoInicial)} a ${fmt.int(c.pesoAlvo)} kg">
        <div class="barra-clip"><div class="barra-fill bg-prot deslizar-x" style="transform: translateX(${(feito * 100 - 100).toFixed(1)}%)"></div></div></div>
      <div class="rs-chips num">
        ${seguidos > 0 ? `<span class="chip chip-26 c-violeta-forte">${seguidos} ${seguidos === 1 ? 'dia' : 'dias seguidos'} registrando</span>` : ''}
        ${protSeguidos > 1 ? `<span class="chip chip-26 c-violeta-forte">Proteína batida há ${protSeguidos} dias</span>` : ''}
      </div>
    </div>
    <p class="rs-msg ${variante === 'na_meta' ? 'ok' : 'alerta'}">${msg}</p>
    <div class="rs-botoes">
      <button type="button" class="claro press" data-acao="resumo-revisar">Revisar o dia</button>
      <button type="button" class="escuro press" data-acao="resumo-fechar-dia">${fechado ? 'Pronto' : 'Fechar o dia'}</button>
    </div>`;
}

/* ---------- 4n. Importar e exportar planilha (SheetJS, no navegador) ---------- */

function carregarXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = ok;
    s.onerror = falha;
    document.head.appendChild(s);
  });
}

/* Datas do Excel são dias desde 30/12/1899 (25569 = 01/01/1970). */
const isoDeSerial = (n) => R.isoDeNum(Math.floor(n) - 25569);
const serialDeIso = (iso) => R.diaNum(iso) + 25569;

const IMPORTADO = 'Importado da planilha';

async function importarPlanilha(arquivo) {
  try {
    await carregarXLSX();
  } catch (e) { aviso('Não deu para carregar o leitor de planilhas.'); return; }
  let wb;
  try {
    wb = XLSX.read(await arquivo.arrayBuffer(), { cellDates: false });
  } catch (e) { aviso('Arquivo inválido. Use o .xlsx da planilha AcompanhamentoPeso.'); return; }
  const conf = wb.Sheets.Configuracao;
  const diario = wb.Sheets.Diario;
  if (!conf || !diario) { aviso('A planilha precisa das abas Configuracao e Diario.'); return; }
  const v = (ws, ref) => (ws[ref] ? ws[ref].v : null);
  const data = (x) => (typeof x === 'number' ? isoDeSerial(x) : (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null));

  // Aba Configuracao → settings (e a meta de kcal do início)
  const inicio = data(v(conf, 'B4')) || cache.settings.start_date;
  const ajustes = { start_date: inicio };
  [['B5', 'start_weight_kg'], ['B6', 'target_weight_kg'], ['B7', 'gain_min_kg'], ['B8', 'gain_ideal_kg'],
    ['B9', 'gain_max_kg'], ['B11', 'skinfold_limit_mm'], ['B12', 'kcal_adjust']].forEach(([ref, k]) => {
    const n = num(v(conf, ref));
    if (n !== null) ajustes[k] = n;
  });

  // Aba Diario: uma linha por dia
  const faixa = XLSX.utils.decode_range(diario['!ref'] || 'A1:P1');
  const dias = [];
  for (let r = 1; r <= faixa.e.r; r++) {
    const cel = (col) => v(diario, col + (r + 1));
    const d = data(cel('A')) || R.somarDias(inicio, r - 1);
    const linha = {
      data: d, peso: num(cel('C')), kcal: num(cel('K')), gasto: num(cel('M')), dobra: num(cel('O')),
      nota: cel('P') != null && String(cel('P')).trim() ? String(cel('P')).trim().slice(0, 200) : null,
      fita: {},
    };
    [['D', 'braco'], ['E', 'ombros'], ['F', 'peitoral'], ['G', 'abdomen'], ['H', 'coxa'], ['I', 'gluteos'], ['J', 'panturrilha']]
      .forEach(([col, k]) => { const n = num(cel(col)); if (n !== null) linha.fita[k] = n; });
    if (linha.peso !== null || linha.kcal !== null || linha.gasto !== null || linha.dobra !== null || linha.nota || Object.keys(linha.fita).length) dias.push(linha);
  }
  if (!confirm(`Importar ${dias.length} ${dias.length === 1 ? 'dia' : 'dias'} da planilha? Nos mesmos dias, os valores da planilha substituem os do app.`)) return;

  salvarSettings(ajustes);
  const kcalIni = num(v(conf, 'B10'));
  if (kcalIni) {
    const ex = cache.kcal_targets.find((t) => t.effective_from === inicio);
    gravarLinha('kcal_targets', { id: ex ? ex.id : novoId(), effective_from: inicio, kcal: Math.round(kcalIni), reason: 'Importado da planilha' });
  }

  const porSemana = {};
  dias.forEach((d) => {
    const campos = {};
    if (d.peso !== null) campos.weight_kg = arred(d.peso, 2);
    if (d.gasto !== null) { campos.kcal_burned = Math.round(d.gasto); campos.burned_source = 'manual'; }
    if (d.nota) campos.note = d.nota;
    if (Object.keys(campos).length) salvarDia(d.data, campos);
    // As kcal ingeridas viram um item "Importado da planilha" por dia (100 g × kcal/100 g).
    if (d.kcal !== null) {
      const ex = cache.meal_entries.find((e) => e.date === d.data && e.food_name === IMPORTADO);
      gravarLinha('meal_entries', {
        id: ex ? ex.id : novoId(), date: d.data, meal_type_id: null, food_id: null, food_name: IMPORTADO, grams: 100,
        kcal_100g: Math.round(d.kcal), protein_100g: null, carb_100g: null, fat_100g: null,
        created_at: ex ? ex.created_at : new Date(`${d.data}T12:00:00-03:00`).toISOString(),
      });
    }
    const w = R.semana(d.data, inicio);
    if (w < 1) return;
    const sem = porSemana[w] || (porSemana[w] = { dobra: [] });
    Object.entries(d.fita).forEach(([k, n]) => { (sem[k] = sem[k] || []).push(n); });
    if (d.dobra !== null) sem.dobra.push(d.dobra);
  });

  // Medidas diárias → média semanal no check-in
  Object.entries(porSemana).forEach(([w, m]) => {
    const campos = {};
    Object.keys(CAMPOS_FITA).forEach((k) => { if (m[k] && m[k].length) campos[CAMPOS_FITA[k]] = arred(R.media(m[k]), 2); });
    if (m.dobra.length) Object.assign(campos, { skinfold_1_mm: arred(R.media(m.dobra), 2), skinfold_2_mm: null, skinfold_3_mm: null });
    if (!Object.keys(campos).length) return;
    const ex = derivados().checkins.get(Number(w));
    gravarLinha('weekly_checkins', { ...(ex || {}), id: ex ? ex.id : novoId(), week_number: Number(w), date: R.inicioDaSemana(Number(w), inicio), ...campos });
  });
  processarFila();
  renderTelaAtual();
  aviso(`${dias.length} ${dias.length === 1 ? 'dia importado' : 'dias importados'}`);
}

const COLUNAS_DIARIO = ['Data', 'Semana', 'Peso (kg)', 'Braço (cm)', 'Ombros (cm)', 'Peitoral (cm)', 'Abdômen (cm)', 'Perna/coxa (cm)',
  'Glúteos (cm)', 'Panturrilha (cm)', 'Calorias (kcal)', 'Calorias vs meta (kcal)', 'Calorias gastas (kcal)', 'Saldo calórico (kcal)',
  'Dobra abdominal (mm)', 'Observação (ex.: dia de longão, comeu fora)'];

/** Linhas da aba Diario, do início até hoje. */
function linhasDiario() {
  const c = cfg();
  const d = derivados();
  const hoje = R.hojeSP();
  const rot = Object.fromEntries(MARCADORES);
  const linhas = [];
  for (let iso = c.inicio; iso <= hoje; iso = R.somarDias(iso, 1)) {
    const w = R.semana(iso, c.inicio);
    const ck = R.ehDiaDeCheckin(iso, c.inicio) ? d.medidas[w] : null;
    const kcal = d.kcal[iso] !== undefined ? Math.round(d.kcal[iso]) : null;
    const gasto = d.gasto[iso] !== undefined ? Math.round(d.gasto[iso]) : null;
    const log = d.logs.get(iso);
    const obs = [log && log.note, ...((log && log.tags) || []).map((t) => rot[t] || t)].filter(Boolean).join(' · ');
    linhas.push([
      iso, w, d.pesos[iso] !== undefined ? d.pesos[iso] : null,
      ...['braco', 'ombros', 'peitoral', 'abdomen', 'coxa', 'gluteos', 'panturrilha'].map((k) => (ck ? ck[k] : null)),
      kcal, kcal === null ? null : kcal - metaKcalEm(iso), gasto, kcal !== null && gasto !== null ? kcal - gasto : null,
      ck && ck.dobra !== null ? arred(ck.dobra, 2) : null, obs || null,
    ]);
  }
  return linhas;
}

function exportarXlsx() {
  const c = cfg();
  const s = cache.settings;
  const dataCel = (iso) => ({ t: 'n', v: serialDeIso(iso), z: 'dd/mm/yyyy' });
  const r3 = (x) => (x === null || x === undefined ? null : arred(x, 3));
  const conf = [
    ['Acompanhamento de Bulking Leve'], [], ['Parâmetros'],
    ['Data de início', dataCel(c.inicio)], ['Peso inicial (kg)', c.pesoInicial], ['Peso alvo (kg)', c.pesoAlvo],
    ['Ganho semanal mínimo (kg)', c.ganhoMin], ['Ganho semanal ideal (kg)', c.ganhoIdeal], ['Ganho semanal máximo (kg)', c.ganhoMax],
    ['Calorias atuais (kcal/dia)', metaKcalEm(R.hojeSP())], ['Limite dobra abdominal (mm/semana)', c.limiteDobra],
    ['Ajuste calórico (kcal/dia)', c.ajusteKcal], [], ['Exportado do BodyEvo em', dataCel(R.hojeSP())],
    ['Nome', s.display_name || ''],
  ];
  const diario = [COLUNAS_DIARIO, ...linhasDiario().map((l) => [dataCel(l[0]), ...l.slice(1)])];
  const semanal = [['Semana', 'Início', 'Fim', 'Dias pesados', 'Média peso (kg)', 'Peso esperado (kg)', 'Variação semana (kg)',
    'Ritmo 2 sem. (kg/sem)', 'Ganho total (kg)', 'Média calorias (kcal/dia)', 'Status / ajuste', 'Média braço (cm)', 'Média ombros (cm)',
    'Média peitoral (cm)', 'Média abdômen (cm)', 'Média perna (cm)', 'Média glúteos (cm)', 'Média panturrilha (cm)',
    'Dias c/ calorias anotadas', 'Média dobra abd. (mm)', 'Δ braço vs sem.1 (cm)', 'Δ abdômen vs sem.1 (cm)', 'Δ dobra vs sem.1 (mm)',
    'Δ dobra vs sem. anterior (mm)', 'Calorias reais − meta (kcal)', 'Leitura das medidas', 'Calorias sugeridas próx. semana (kcal/dia)',
    'Média calorias gastas (kcal/dia)', 'Saldo calórico médio (kcal/dia)']];
  semanas().forEach((w) => {
    const m = w.medidas;
    semanal.push([w.n, dataCel(w.inicio), dataCel(w.fim), w.diasPesados, r3(w.media), r3(w.esperado), r3(w.variacao), r3(w.ritmo),
      r3(w.ganhoTotal), w.mediaKcal === null ? null : Math.round(w.mediaKcal), w.status ? w.status.texto : null,
      m.braco, m.ombros, m.peitoral, m.abdomen, m.coxa, m.gluteos, m.panturrilha, w.diasKcal, r3(m.dobra),
      r3(w.dBracoS1), r3(w.dAbdomenS1), r3(w.dDobraS1), r3(w.dDobraAnt), w.kcalVsMeta === null ? null : Math.round(w.kcalVsMeta),
      w.leitura ? w.leitura.texto : null, w.sugestao ? w.sugestao.valor : null,
      w.mediaGasto === null ? null : Math.round(w.mediaGasto), w.saldoMedio === null ? null : Math.round(w.saldoMedio)]);
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(conf), 'Configuracao');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(diario), 'Diario');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(semanal), 'Semanal');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** CSV no padrão do Excel brasileiro: ponto e vírgula e vírgula decimal. */
function exportarCsv() {
  const cel = (x) => {
    if (x === null || x === undefined) return '';
    if (typeof x === 'number') return String(arred(x, 3)).replace('.', ',');
    const t = String(x);
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const linhas = [COLUNAS_DIARIO, ...linhasDiario().map((l) => [dataBR(l[0]), ...l.slice(1)])];
  return new Blob(['﻿' + linhas.map((l) => l.map(cel).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

async function compartilharArquivo(blob, nome) {
  const arquivo = new File([blob], nome, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
    try { await navigator.share({ files: [arquivo], title: nome }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportar(tipo) {
  if (!window.XLSX && tipo === 'xlsx') { aviso('Carregando o gerador de planilhas… toque de novo.'); carregarXLSX(); return; }
  const nome = `BodyEvo-${R.hojeSP()}.${tipo}`;
  compartilharArquivo(tipo === 'xlsx' ? exportarXlsx() : exportarCsv(), nome);
}


/* ---------- 4o. Leitor de código de barras ---------- */

/* Câmera traseira em tela cheia. Usa o BarcodeDetector do navegador quando existe (Android/Chrome);
   no iPhone carrega a ZXing (vendor/zxing.min.js) só na primeira leitura. Sempre dá para digitar o número. */
const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let leitor = null;   // { fim, stream, zxing, timer }

function carregarScript(src) {
  return new Promise((ok, erro) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => { s.remove(); erro(new Error('falhou ' + src)); };
    document.head.appendChild(s);
  });
}

function lerCodigoDeBarras() {
  fecharLeitor(null);
  esconderAviso();
  return new Promise((fim) => {
    const el = document.createElement('div');
    el.id = 'leitor';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'leitor-h');
    el.innerHTML = `
      <video id="leitor-video" playsinline muted autoplay aria-hidden="true"></video>
      <div class="leitor-topo"><h1 id="leitor-h">Código de barras</h1>
        <button type="button" class="btn-fechar press" data-acao="leitor-fechar" aria-label="Fechar">${ic(P.fechar, 18, 2.4)}</button></div>
      <div class="leitor-mira" aria-hidden="true"></div>
      <p class="leitor-dica" id="leitor-dica" aria-live="polite">Abrindo a câmera…</p>
      <form class="leitor-manual" data-form="leitor" novalidate>
        <label class="sr-only" for="leitor-num">Número do código de barras</label>
        <input id="leitor-num" class="num" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="search" maxlength="14" placeholder="Ou digite o número">
        <button type="submit" class="press">Buscar</button>
      </form>`;
    document.body.appendChild(el);
    leitor = { fim, el, stream: null, zxing: null, timer: null };
    iniciarCamera(leitor);
  });
}

async function iniciarCamera(l) {
  const dica = (t) => { const d = $('#leitor-dica'); if (d) d.textContent = t; };
  const video = $('#leitor-video');
  const restricoes = { video: { facingMode: { ideal: 'environment' } }, audio: false };
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('sem câmera');
    let nativo = null;
    if ('BarcodeDetector' in window) {
      const suportados = await window.BarcodeDetector.getSupportedFormats().catch(() => []);
      const formatos = FORMATOS.filter((f) => suportados.includes(f));
      if (formatos.length) nativo = new window.BarcodeDetector({ formats: formatos });
    }
    if (nativo) {
      l.stream = await navigator.mediaDevices.getUserMedia(restricoes);
      if (leitor !== l) { pararCamera(l); return; }
      video.srcObject = l.stream;
      await video.play().catch(() => {});
      dica('Aponte para o código de barras do rótulo');
      const tentar = async () => {
        if (leitor !== l) return;
        try {
          const achados = await nativo.detect(video);
          if (achados.length) { fecharLeitor(achados[0].rawValue); return; }
        } catch (e) { /* quadro ainda não pronto */ }
        l.timer = setTimeout(tentar, 200);
      };
      tentar();
      return;
    }
    if (!window.ZXing) { dica('Carregando o leitor…'); await carregarScript('vendor/zxing.min.js'); }
    if (leitor !== l) return;
    const Z = window.ZXing;
    const dicas = new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]]]);
    l.zxing = new Z.BrowserMultiFormatReader(dicas, 200);
    const promessa = l.zxing.decodeFromConstraints(restricoes, video, (res) => { if (res && leitor === l) fecharLeitor(res.getText()); });
    dica('Aponte para o código de barras do rótulo');
    await promessa;
  } catch (e) {
    if (leitor !== l) return;
    pararCamera(l);
    const negado = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    dica(negado ? 'Sem permissão para a câmera. Libere em Ajustes do iPhone ou digite o número abaixo.'
      : 'Não deu para abrir a câmera. Digite o número abaixo.');
    const campo = $('#leitor-num'); if (campo) campo.focus();
  }
}

function pararCamera(l) {
  clearTimeout(l.timer);
  if (l.zxing) { try { l.zxing.reset(); } catch (e) { /* já parado */ } l.zxing = null; }
  if (l.stream) { l.stream.getTracks().forEach((t) => t.stop()); l.stream = null; }
}

/** Fecha o leitor e entrega o código lido (ou null se cancelou). */
function fecharLeitor(codigo) {
  const l = leitor;
  if (!l) return;
  leitor = null;
  pararCamera(l);
  l.el.remove();
  if (codigo) vibrar(15);
  l.fim(codigo ? String(codigo).replace(/\D/g, '') : null);
}

function enviarLeitorManual() {
  const v = ($('#leitor-num').value || '').replace(/\D/g, '');
  if (v.length < 8) { const d = $('#leitor-dica'); if (d) d.textContent = 'O código de barras tem de 8 a 14 dígitos.'; return; }
  fecharLeitor(v);
}

/** Lê o código, consulta o Open Food Facts e preenche (destino 'add' = sheet; 'form' = Novo alimento). */
async function codigoDeBarras(destino) {
  const codigo = await lerCodigoDeBarras();
  if (!codigo) return;
  if (!navigator.onLine) { aviso('Sem conexão: a busca pelo código de barras precisa de internet.'); return; }
  aviso('Buscando o produto…', { duracao: 12000 });
  let d;
  try { d = await buscarCodigoBarras(codigo); } catch (e) { aviso('Não deu para consultar o Open Food Facts. Tente de novo.'); return; }
  const noAdd = destino === 'add' && estado.add && sheetAtual === $('#sheet-add');
  if (!d) {
    aviso(`Produto ${codigo} não encontrado. Preencha pelo rótulo.`, { duracao: 6000 });
    if (noAdd) trocarSheetPorTela('alimento', { id: null, nome: '', voltarAdd: { mealId: estado.add.mealId, data: estado.add.data } });
    return;
  }
  const prefill = { ...d, origem: `Open Food Facts · código ${codigo}. Dados da comunidade: confira com o rótulo.` };
  if (noAdd) {
    const existente = alimentoComNome(d.nome);
    if (existente) { escolherNoAdd(existente); aviso(`${existente.name} já está nos seus alimentos`); return; }
    trocarSheetPorTela('alimento', { id: null, nome: d.nome, voltarAdd: { mealId: estado.add.mealId, data: estado.add.data }, prefill });
    aviso('Produto encontrado. Confira os valores e salve.');
    return;
  }
  if (destino === 'form' && estado.tela === 'alimento' && estado.alimento) {
    estado.alimento = preencherRascunho(estado.alimento, prefill);
    renderAlimento();
    aviso('Produto encontrado. Confira os valores e salve.');
  }
}

/* =====================================================================
   5. NAVEGAÇÃO, EVENTOS GLOBAIS E SERVICE WORKER
   ===================================================================== */

const PROFUNDIDADE = { login: 0, hoje: 0, evolucao: 1, semana: 1, ajustes: 1, refeicao: 2, alimentos: 2, metas: 2, checkin: 2, alimento: 3 };
const ABAS = new Set(['hoje', 'evolucao', 'semana', 'ajustes']);
const RENDER = {
  login: renderLogin, hoje: renderHoje, evolucao: renderEvolucao, semana: renderSemana, ajustes: renderAjustes,
  refeicao: renderRefeicao, alimentos: renderAlimentos, alimento: renderAlimento, metas: renderMetas, checkin: renderCheckin,
};
const rolagens = {};     // posição de rolagem de cada tela
let aposVoltar = null;   // ação para depois de um history.back()

function hashDe(s) {
  if (s.tela === 'refeicao') return `#refeicao/${s.mealId}/${s.data}`;
  if (s.tela === 'alimento') return `#alimento/${s.id || 'novo'}`;
  if (s.tela === 'checkin') return `#checkin/${s.semana}`;
  return '#' + s.tela;
}

function estadoDoHash(hash) {
  const [tela, a, b] = String(hash || '').replace(/^#/, '').split('/');
  if (!RENDER[tela] || tela === 'login') return null;
  if (tela === 'refeicao') return a && /^\d{4}-\d{2}-\d{2}$/.test(b || '') ? { tela, mealId: a, data: b } : null;
  if (tela === 'alimento') return { tela, id: a && a !== 'novo' ? a : null };
  if (tela === 'checkin') return { tela, semana: Number(a) || null };
  return { tela };
}

/**
 * Prepara o contexto de uma tela empilhada a partir do estado do histórico.
 * novo = navegação nova (rascunhos recomeçam); no voltar/avançar o rascunho é mantido.
 */
function aplicarParams(s, novo = false) {
  if (s.tela === 'refeicao') { estado.refeicao = { mealId: s.mealId, data: s.data }; estado.editandoItens = false; }
  if (s.tela === 'alimento' && (novo || !estado.alimento || estado.alimento.id !== (s.id || null))) estado.alimento = rascunhoAlimento(s.id, s.nome || '', s.voltarAdd || null, s.prefill || null);
  if (s.tela === 'metas' && (novo || !estado.metas)) estado.metas = rascunhoMetas();
  if (s.tela === 'checkin' && (novo || !estado.checkin || estado.checkin.w !== (s.semana || semanaAtual()))) estado.checkin = rascunhoCheckin(s.semana || semanaAtual());
}

function mostrar(tela, { animar = true } = {}) {
  const views = $$('.view');
  const saindo = views.find((v) => v.dataset.view === estado.tela);
  const entrando = views.find((v) => v.dataset.view === tela);
  const voltando = (PROFUNDIDADE[tela] || 0) < (PROFUNDIDADE[estado.tela] || 0);
  const entreAbas = ABAS.has(tela) && ABAS.has(estado.tela);   // trocar de aba é imediato

  if (saindo && !saindo.hidden) rolagens[estado.tela] = saindo.scrollTop;

  // Uma troca no meio de outra continua da posição em que as telas estão agora.
  const posicoes = new Map();
  views.forEach((v) => {
    const anims = v.getAnimations ? v.getAnimations() : [];
    if (anims.length) {
      const cs = getComputedStyle(v);
      posicoes.set(v, { transform: cs.transform, opacity: cs.opacity });
    }
    anims.forEach((a) => a.cancel());
    v.classList.remove('is-saindo', 'is-topo');
    v.inert = false;
    v.hidden = v !== entrando && v !== saindo;
  });

  const anterior = estado.tela;
  estado.tela = tela;
  entrando.hidden = false;
  // Voltando de outra aba, o Hoje mostra hoje; voltando de uma refeição, mantém o dia escolhido.
  if (tela === 'hoje' && PROFUNDIDADE[anterior] === 1) estado.data = R.hojeSP();
  if (RENDER[tela]) RENDER[tela]();
  atualizarSync();

  const comAbas = ABAS.has(tela);
  $('#abas').classList.toggle('is-off', !comAbas);
  $('#abas').inert = !comAbas;
  $('.desbotar').classList.toggle('is-off', !comAbas);
  $$('.aba').forEach((a) => {
    if (a.dataset.aba === tela) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });

  entrando.scrollTop = voltando || entreAbas ? (rolagens[tela] || 0) : 0;

  if (!saindo || saindo === entrando) return;
  if (animar && !entreAbas) animarTroca(saindo, entrando, voltando, posicoes);
  else saindo.hidden = true;
}

/* Como no iOS: avançar entra pela direita e voltar sai por onde entrou.
   A tela nova já responde ao toque durante a animação. */
function animarTroca(saindo, entrando, voltando, posicoes) {
  const opcoes = { duration: 380, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' };
  const atras = { transform: 'translateX(-25%)', opacity: 0.6 };
  const fora = { transform: 'translateX(100%)', opacity: 1 };
  const parado = { transform: 'none', opacity: 1 };
  saindo.classList.add('is-saindo');
  saindo.classList.toggle('is-topo', voltando);
  saindo.inert = true;
  const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduzido) {
    opcoes.duration = 180; opcoes.easing = 'ease';
    entrando.animate([{ opacity: 0 }, { opacity: 1 }], opcoes);
  } else {
    entrando.animate([posicoes.get(entrando) || (voltando ? atras : fora), parado], opcoes);
  }
  const fim = reduzido ? { opacity: 0 } : (voltando ? fora : atras);
  saindo.animate([posicoes.get(saindo) || parado, fim], opcoes).finished.then(() => {
    saindo.hidden = true;
    saindo.classList.remove('is-saindo', 'is-topo');
    saindo.inert = false;
  }).catch(() => { /* interrompida por outra troca */ });
}

function irPara(tela, params = {}) {
  const s = { tela, ...params };
  aplicarParams(s, true);
  history.pushState(s, '', hashDe(s));
  mostrar(tela);
}

function voltar() {
  if (history.state && history.state.tela !== 'hoje' && history.length > 1) history.back();
  else { history.replaceState({ tela: 'hoje' }, '', '#hoje'); mostrar('hoje'); const fn = aposVoltar; aposVoltar = null; if (fn) fn(); }
}

/* As abas não empilham: do Hoje entra uma vez no histórico; entre as outras, troca a entrada atual. */
function trocarAba(aba) {
  if (aba === estado.tela) { const v = $(`.view[data-view="${aba}"]`); v.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  vibrar(5);
  if (aba === 'hoje') { voltar(); return; }
  if (estado.tela === 'hoje') irPara(aba);
  else { history.replaceState({ tela: aba }, '', '#' + aba); mostrar(aba); }
}

window.addEventListener('popstate', (e) => {
  if (leitor) fecharLeitor(null);
  const s = e.state || estadoDoHash(location.hash) || { tela: 'hoje' };
  if (sheetAtual && !s.sheet) fecharSheetAgora();
  if (!$('#resumo').hidden && !s.popup) fecharResumoAgora();
  if (s.sheet || s.popup) {
    // Avançar de volta para um sheet já fechado: só limpa a entrada.
    if ((s.sheet && !sheetAtual) || (s.popup && $('#resumo').hidden)) history.replaceState({ ...s, sheet: undefined, popup: undefined }, '');
  }
  if (s.tela !== estado.tela) {
    aplicarParams(s);
    mostrar(s.tela, { animar: !e.hasUAVisualTransition });
  }
  const fn = aposVoltar; aposVoltar = null;
  if (fn) setTimeout(fn, 60);
});

/* ---------- Sheets ---------- */

let sheetAtual = null;

function abrirSheet(el) {
  if (sheetAtual === el) return;
  if (sheetAtual) fecharSheetAgora();
  sheetAtual = el;
  history.pushState({ ...(history.state || { tela: estado.tela }), sheet: el.id }, '');
  const scrim = $('#scrim');
  el.hidden = false; scrim.hidden = false;
  el.style.bottom = '';
  el.getBoundingClientRect();   // parte de translateY(100%)
  el.classList.add('is-aberto'); scrim.classList.add('is-aberto');
  document.body.classList.add('com-sheet');
  $('#palco').inert = true;
  const f = $('.btn-fechar', el);
  if (f) f.focus({ preventScroll: true });
}

/** Fechar pela interface: passa pelo histórico para o "voltar" ficar coerente. */
function fecharSheet() {
  if (!sheetAtual) return;
  if (history.state && history.state.sheet) history.back(); else fecharSheetAgora();
}

function fecharSheetAgora() {
  const el = sheetAtual;
  if (!el) return;
  sheetAtual = null;
  const scrim = $('#scrim');
  if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
  el.classList.remove('is-aberto', 'is-arrastando');
  el.style.transform = '';
  scrim.style.opacity = '';
  scrim.classList.remove('is-aberto');
  document.body.classList.remove('com-sheet');
  $('#palco').inert = false;
  const fim = () => {
    if (sheetAtual !== el) el.hidden = true;
    if (!sheetAtual) scrim.hidden = true;
  };
  el.addEventListener('transitionend', fim, { once: true });
  setTimeout(fim, 520);
}

/* Arrastar para baixo acompanha o dedo 1:1. Fecha com um gesto rápido (> 0,11 px/ms) ou depois
   de 25% da altura; para cima, resistência progressiva; se soltar antes, volta sem quique. */
function ligarArraste(sheet) {
  const zona = $('.sheet-arraste', sheet);
  let a = null;
  zona.addEventListener('pointerdown', (e) => {
    if (a || e.button > 0 || e.target.closest('button, input, a, label')) return;
    const base = new DOMMatrix(getComputedStyle(sheet).transform).m42;
    a = { id: e.pointerId, y0: e.clientY, base, y: base, amostraY: base, amostraT: e.timeStamp, v: 0 };
    e.preventDefault();   // sem seleção de texto nem arrastar nativo, que cancelariam o gesto
    zona.setPointerCapture(e.pointerId);
    sheet.classList.add('is-arrastando');
    sheet.style.transform = `translate3d(0, ${base}px, 0)`;
  });
  zona.addEventListener('pointermove', (e) => {
    if (!a || e.pointerId !== a.id) return;
    const bruto = a.base + e.clientY - a.y0;
    a.y = bruto >= 0 ? bruto : -(Math.abs(bruto) * 120) / (120 + Math.abs(bruto));
    const dt = e.timeStamp - a.amostraT;
    if (dt > 16) {
      a.v = (a.y - a.amostraY) / dt;
      a.amostraY = a.y; a.amostraT = e.timeStamp;
    }
    sheet.style.transform = `translate3d(0, ${a.y}px, 0)`;
    $('#scrim').style.opacity = String(1 - Math.max(0, a.y) / sheet.offsetHeight);
  });
  const soltar = (e, cancelado) => {
    if (!a || e.pointerId !== a.id) return;
    const { y } = a;
    // Dedo parado antes de soltar não conta como gesto rápido.
    const v = e.timeStamp - a.amostraT > 100 ? 0 : a.v;
    a = null;
    sheet.classList.remove('is-arrastando');
    if (!cancelado && (y > sheet.offsetHeight * 0.25 || (y > 10 && v > 0.11))) {
      vibrar(8);
      fecharSheet();
    } else {
      sheet.style.transform = '';
      $('#scrim').style.opacity = '';
    }
  };
  zona.addEventListener('pointerup', (e) => soltar(e, false));
  zona.addEventListener('pointercancel', (e) => soltar(e, true));
}

/* No iOS o teclado cobre elementos fixos: o sheet sobe junto com ele. */
function ajustarAoTeclado() {
  const vv = window.visualViewport;
  if (!vv || !sheetAtual) return;
  const encoberto = window.innerHeight - vv.height - vv.offsetTop;
  sheetAtual.style.bottom = encoberto > 40 ? `${encoberto}px` : '';
}

/* ---------- Pop-up do resumo ---------- */

function abrirResumo(data) {
  if (!cache.settings) return;
  if (sheetAtual) fecharSheetAgora();
  estado.resumoData = data || (estado.tela === 'hoje' ? estado.data : R.hojeSP());
  renderResumo();
  const r = $('#resumo');
  r.classList.remove('is-fechando', 'is-aberto');
  r.hidden = false;
  r.getBoundingClientRect();
  r.classList.add('is-aberto');
  history.pushState({ ...(history.state || { tela: estado.tela }), popup: 'resumo' }, '');
  $('#palco').inert = true;
  $('.rs-fechar', r).focus({ preventScroll: true });
}

function fecharResumo() {
  if (history.state && history.state.popup) history.back(); else fecharResumoAgora();
}

function fecharResumoAgora() {
  const r = $('#resumo');
  if (r.hidden) return;
  r.classList.remove('is-aberto');
  r.classList.add('is-fechando');
  $('#palco').inert = false;
  setTimeout(() => { r.hidden = true; r.classList.remove('is-fechando'); }, 200);
}

/** Abre sozinho depois de summary_time, se o dia ainda não foi fechado (e não foi dispensado há pouco). */
function verificarResumoAutomatico() {
  if (!cache.settings || !usuario || estado.tela === 'login' || sheetAtual || !$('#resumo').hidden) return;
  const { data: hoje, hora } = R.agoraSP();
  const min = R.minutos(hora);
  let alvo = null;
  if (min >= R.minutos(cache.settings.summary_time)) alvo = hoje;
  else if (min < 240) alvo = R.somarDias(hoje, -1);   // madrugada: ainda vale o dia anterior
  if (!alvo || !entradasDo(alvo).length) return;
  const log = logDo(alvo);
  if (log && log.closed_at) return;
  const disp = store.ler(CHAVES.resumo, null);
  if (disp && disp.data === alvo && Date.now() - disp.t < 30 * 60000) return;
  abrirResumo(alvo);
}

/* ---------- Ações (delegação de eventos) ---------- */

function renderTelaAtual() {
  const f = RENDER[estado.tela];
  if (f) f();
}

/* Dados novos do servidor: redesenha, menos uma tela em que você está digitando. */
function atualizarTelaComDados() {
  const view = $(`.view[data-view="${estado.tela}"]`);
  const digitando = document.activeElement && document.activeElement.matches('input') && view && view.contains(document.activeElement);
  if (!digitando && !['alimento', 'metas', 'checkin'].includes(estado.tela)) renderTelaAtual();
  if (sheetAtual === $('#sheet-peso') && estado.peso && !$('#sheet-peso').contains(document.activeElement)) renderPeso();
  if (estado.tela !== 'login' && !$('#resumo').hidden) renderResumo();
  atualizarSync();
}

const ACOES = {
  aba: (el) => trocarAba(el.dataset.aba),
  ir: (el) => {
    irPara(el.dataset.tela);
  },
  voltar: () => voltar(),
  sync: () => {
    if (semSessao && !MODO_LOCAL) { history.replaceState({ tela: 'login' }, '', '#login'); mostrar('login', { animar: false }); return; }
    sincronizar({ forcar: true });
  },
  'escolher-dia': (el) => { estado.data = el.dataset.data; vibrar(5); renderHoje(); },
  'abrir-peso': (el) => abrirPeso({ manual: el.dataset.manual === '1' }),
  'abrir-add': (el) => abrirAdd({ mealId: el.dataset.meal || null }),
  'abrir-refeicao': (el) => irPara('refeicao', { mealId: el.dataset.meal, data: estado.data }),
  'abrir-checkin': (el) => irPara('checkin', { semana: Number(el.dataset.semana) || semanaAtual() }),
  'abrir-resumo': () => abrirResumo(estado.data),
  'fechar-sheet': () => fecharSheet(),

  'peso-passo': (el) => {
    const p = estado.peso;
    const n = num(p.texto) || 0;
    p.texto = fmt.d1(Math.max(0, arred(n + Number(el.dataset.passo), 1)));
    p.tocado = true;
    $('#peso-input').value = p.texto;
    $('#peso-nota').textContent = notaPeso();
    vibrar(5);
  },
  'peso-tag': (el) => {
    const t = el.dataset.tag;
    if (estado.peso.tags.has(t)) estado.peso.tags.delete(t); else estado.peso.tags.add(t);
    el.setAttribute('aria-pressed', String(estado.peso.tags.has(t)));
    vibrar(5);
  },
  'peso-salvar': () => salvarPeso(),
  'garmin-atualizar': () => atualizarGarmin(),

  'add-refeicao': (el) => {
    estado.add.mealId = el.dataset.meal;
    $$('#add-refeicoes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.meal === estado.add.mealId)));
    renderAddLista(); renderAddPainel();
  },
  'add-escolher': (el) => {
    const a = estado.add;
    if (a.foodId !== el.dataset.id) {
      a.foodId = el.dataset.id;
      a.gramas = gramasSugeridas(derivados().alimentos.get(a.foodId));
    }
    $$('#add-lista .item-alimento').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === a.foodId)));
    renderAddPainel();
    vibrar(5);
  },
  'add-passo': (el) => {
    const a = estado.add;
    a.gramas = paraCampo(Math.max(0, Math.round((num(a.gramas) || 0) + Number(el.dataset.passo))));
    $('#add-gramas').value = a.gramas;
    atualizarAddResultado();
    vibrar(5);
  },
  'add-usar': (el) => {
    estado.add.gramas = paraCampo(Number(el.dataset.g));
    $('#add-gramas').value = estado.add.gramas;
    atualizarAddResultado();
  },
  'add-confirmar': () => confirmarAdd(),
  'add-novo': () => {
    const a = estado.add;
    const nome = a.busca.trim();
    trocarSheetPorTela('alimento', { id: null, nome, voltarAdd: { mealId: a.mealId, data: a.data } });
  },
  'ver-alimentos': () => trocarSheetPorTela('alimentos', {}),
  'add-taco': (el) => {
    const t = tacoMostrados[Number(el.dataset.i)];
    if (!t) return;
    const existente = alimentoComNome(t.nome);
    escolherNoAdd(existente || criarAlimentoDe(t));
    if (!existente) aviso(`Copiado da TACO para seus alimentos`);
  },
  'add-codigo': () => codigoDeBarras('add'),
  'alimentos-taco': (el) => {
    const t = tacoMostrados[Number(el.dataset.i)];
    if (!t) return;
    const existente = alimentoComNome(t.nome);
    if (existente) { irPara('alimento', { id: existente.id }); return; }
    irPara('alimento', { id: null, nome: t.nome, prefill: { nome: t.nome, kcal: t.kcal, p: t.p, c: t.c, g: t.g, origem: 'Valores da TACO (4ª ed., NEPA/UNICAMP), por 100 g.' } });
  },
  'al-codigo': () => codigoDeBarras('form'),
  'leitor-fechar': () => fecharLeitor(null),

  'refeicao-editar': () => { estado.editandoItens = !estado.editandoItens; renderRefeicao(); },
  'item-apagar': (el) => apagarItem(el.dataset.id),

  'alimentos-ordem': (el) => {
    estado.alimentos.ordem = Number(el.dataset.i);
    $('#alimentos-ordem').innerHTML = segmentadoHTML({ acao: 'alimentos-ordem', opcoes: ['A–Z', 'Mais usados'], sel: estado.alimentos.ordem, rotulo: 'Ordenar', escuro: true });
    renderListaAlimentos();
  },
  'novo-alimento': (el) => irPara('alimento', { id: null, nome: el.dataset.nome || '' }),
  'editar-alimento': (el) => irPara('alimento', { id: el.dataset.id }),
  'al-base': (el) => { estado.alimento.base = Number(el.dataset.i); renderAlimento(); },
  'alimento-salvar': () => salvarAlimento(),
  'alimento-arquivar': () => arquivarAlimento(),

  'metas-regra': (el) => { estado.metas[el.dataset.k].regra = Number(el.dataset.i); renderMetas(); },
  'metas-carbo': () => {
    const m = estado.metas;
    m.carb.meta = String(R.carboParaFechar(metaKcalEm(R.hojeSP()), num(m.protein.meta), num(m.fat.meta)));
    renderMetas();
  },
  'metas-salvar': () => salvarMetas(),

  'checkin-salvar': () => salvarCheckin(),
  'semana-mudar': (el) => { estado.semana += Number(el.dataset.d); renderSemana(); },
  'aplicar-meta': () => aplicarMeta(),
  'evo-modo': (el) => {
    estado.evoModo = Number(el.dataset.i);
    const seg = el.closest('.segmentado');
    $('.seg-ind', seg).style.transform = `translateX(${estado.evoModo * 100}%)`;
    $$('.seg-btn', seg).forEach((b, i) => b.setAttribute('aria-pressed', String(i === estado.evoModo)));
    const largura = Math.min(480, $('#evolucao').clientWidth) - 76;
    $('#evo-grafico').innerHTML = graficoHTML(estado.evoModo, largura);
  },

  editar: (el) => abrirEditor(EDITORES[el.dataset.ed](el.dataset.id)),
  'editor-apagar': () => { const ed = estado.editor; if (ed && ed.apagar && ed.apagar.fn() !== false) { fecharSheet(); renderTelaAtual(); } },
  'ativar-push': async () => { await ativarNotificacoes(); renderAjustes(); },
  importar: () => { carregarXLSX().catch(() => {}); $('#arquivo-importar').click(); },
  exportar: (el) => exportar(el.dataset.tipo),
  sair: () => sair(),

  'resumo-revisar': () => {
    store.gravar(CHAVES.resumo, { data: estado.resumoData, t: Date.now() });
    fecharResumo();
  },
  'resumo-fechar-dia': () => {
    const log = logDo(estado.resumoData);
    if (!log || !log.closed_at) { salvarDia(estado.resumoData, { closed_at: new Date().toISOString() }); vibrar(15); }
    fecharResumo();
    renderTelaAtual();
  },
};

/* Do sheet para uma tela empilhada: a entrada do sheet no histórico vira a da tela. */
function trocarSheetPorTela(tela, params) {
  const s = { tela, ...params };
  aplicarParams(s, true);
  history.replaceState(s, '', hashDe(s));
  fecharSheetAgora();
  mostrar(tela);
}

/* Campos: cada tecla atualiza só o que depende dela (sem redesenhar a tela e perder o foco). */
const CAMPOS = {
  peso: (el) => {
    el.value = limparNum(el.value, 5);
    estado.peso.texto = el.value;
    estado.peso.tocado = true;
    $('#peso-nota').textContent = notaPeso();
  },
  'peso-kout': (el) => {
    el.value = el.value.replace(/\D/g, '').slice(0, 5);
    estado.peso.kout = el.value;
    atualizarSaldoPeso();
  },
  'peso-nota': (el) => { estado.peso.nota = el.value; },
  'add-busca': (el) => { estado.add.busca = el.value.slice(0, 40); renderAddLista(); },
  'add-gramas': (el) => { el.value = limparNum(el.value, 5); estado.add.gramas = el.value; atualizarAddResultado(); },
  'item-gramas': (el) => editarGramasItem(el, false),
  'alimentos-busca': (el) => { estado.alimentos.busca = el.value.slice(0, 40); renderListaAlimentos(); },
  al: (el) => {
    const k = el.dataset.k;
    if (k === 'nome') estado.alimento.nome = el.value.slice(0, 60);
    else { el.value = limparNum(el.value); estado.alimento[k] = el.value; }
    if (k !== 'nome' && k !== 'unidade') atualizarConferencia();
  },
  metas: (el) => {
    el.value = limparNum(el.value, 5);
    estado.metas[el.dataset.k][el.dataset.c] = el.value;
    atualizarMetas();
  },
  'ck-fita': (el) => { el.value = limparNum(el.value, 5); estado.checkin.v[el.dataset.k] = el.value; atualizarCheckin(); },
  'ck-dobra': (el) => { el.value = limparNum(el.value, 5); estado.checkin.r[Number(el.dataset.i)] = el.value; atualizarCheckin(); },
};

const MUDANCAS = {
  'peso-manual': (el) => {
    estado.peso.manual = el.checked;
    if (el.checked && !estado.peso.kout) { const g = garminTotal(logDo(estado.peso.data)); if (g) estado.peso.kout = String(Math.round(g)); }
    renderPeso();
    if (el.checked) setTimeout(() => { const k = $('#peso-kout'); if (k) k.focus(); }, 50);
  },
  'item-gramas': (el) => editarGramasItem(el, true),
  'refeicao-ativa': (el) => {
    const m = derivados().refeicoes.get(el.dataset.id);
    if (m) { gravarLinha('meal_types', { ...m, active: el.checked }); processarFila(); }
    renderAjustes();
  },
  'ajuste-bool': (el) => salvarSettings({ [el.dataset.k]: el.checked }),
  lembrete: (el) => mudarLembrete(el),
};

function ligarEventos() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-acao]');
    if (!el || el.disabled) return;
    const fn = ACOES[el.dataset.acao];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    fn(el, e);
  });
  // Links das abas (href="#…" serve de alternativa sem JS)
  $$('.aba').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); trocarAba(a.dataset.aba); }));
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-campo]');
    if (el && CAMPOS[el.dataset.campo]) CAMPOS[el.dataset.campo](el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-muda]');
    if (el && MUDANCAS[el.dataset.muda]) MUDANCAS[el.dataset.muda](el, e);
  });
  // Campos numéricos selecionam o valor ao tocar, para só digitar o novo.
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.matches && el.matches('input[data-seleciona]')) setTimeout(() => { try { el.setSelectionRange(0, el.value.length); } catch (err) { /* tipo sem seleção */ } }, 0);
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.dataset.form === 'login') enviarLogin();
    if (e.target.id === 'editor-corpo') enviarEditor();
    if (e.target.dataset.form === 'leitor') enviarLeitorManual();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (leitor) fecharLeitor(null);
      else if (!$('#resumo').hidden) fecharResumo();
      else if (sheetAtual) fecharSheet();
    }
    // Enter num campo do sheet de adicionar confirma.
    if (e.key === 'Enter' && e.target.id === 'add-gramas') { e.preventDefault(); confirmarAdd(); }
  });
  $('#arquivo-importar').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importarPlanilha(f);
  });
  ['#sheet-peso', '#sheet-add', '#sheet-editor'].forEach((s) => ligarArraste($(s)));
  ligarDeslizarItens();
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', ajustarAoTeclado);
    visualViewport.addEventListener('scroll', ajustarAoTeclado);
  }

  // Conexão: reenvia a fila quando volta e quando o app volta para a frente.
  window.addEventListener('online', () => sincronizar({ forcar: true }));
  window.addEventListener('offline', atualizarSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const hoje = R.hojeSP();
    if (estado.data !== hoje && estado.tela === 'hoje' && R.diasEntre(estado.data, hoje) > 6) estado.data = hoje;
    sincronizar();
    if (estado.tela === 'hoje') renderHoje();   // a data pode ter mudado
    verificarResumoAutomatico();
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  });
}

/* ---------- Service worker e versão ---------- */

function pedirVersao() {
  const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (ctrl) ctrl.postMessage({ tipo: 'versao' });
}

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Versão nova assumiu o controle: recarrega para usar o código novo (não na primeira instalação).
  if (navigator.serviceWorker.controller) {
    let recarregando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recarregando || sheetAtual || fila.length && !navigator.onLine) return;
      recarregando = true;
      location.reload();
    });
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.tipo === 'versao') { const el = $('#versao'); if (el) el.textContent = `BodyEvo · ${m.versao}`; }
    if (m.tipo === 'abrir' && m.abrir === 'resumo') abrirResumo(R.hojeSP());
  });
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker não registrado', e));
}

/* ---------- Início ---------- */

function iniciar() {
  // Sem um listener de toque, o Safari do iPhone não aplica :active.
  document.addEventListener('touchstart', () => {}, { passive: true });
  ligarEventos();

  // A notificação do resumo abre ./?abrir=resumo#hoje
  const params = new URLSearchParams(location.search);
  const abrir = params.get('abrir');
  if (abrir) history.replaceState(history.state, '', location.pathname + location.hash);

  if (!MODO_LOCAL) {
    sb.auth.onAuthStateChange((evento, sessao) => {
      if (sessao && sessao.user && (!usuario || usuario.id !== sessao.user.id || estado.tela === 'login')) setTimeout(() => entrar(sessao.user), 0);
      if (sessao) { semSessao = false; atualizarSync(); }
      if (evento === 'SIGNED_OUT' && usuario) { semSessao = true; atualizarSync(); }
    });
  }

  if (!usuario) {
    history.replaceState({ tela: 'login' }, '', '#login');
    mostrar('login', { animar: false });
  } else {
    if (MODO_LOCAL && !cache.settings) { cache = criarSemente(usuario.id); gravarCache(); }
    const alvo = estadoDoHash(location.hash) || { tela: 'hoje' };
    history.replaceState({ tela: 'hoje' }, '', '#hoje');
    mostrar('hoje', { animar: false });
    if (alvo.tela !== 'hoje' && cache.settings) {
      if (ABAS.has(alvo.tela)) { history.pushState({ tela: alvo.tela }, '', '#' + alvo.tela); mostrar(alvo.tela, { animar: false }); }
      else {
        aplicarParams(alvo);
        history.pushState(alvo, '', hashDe(alvo));
        mostrar(alvo.tela, { animar: false });
      }
    }
    sincronizar({ forcar: true });
    if (abrir === 'resumo') setTimeout(() => abrirResumo(R.hojeSP()), 250);
    else setTimeout(verificarResumoAutomatico, 400);
  }
  registrarServiceWorker();
}

iniciar();
