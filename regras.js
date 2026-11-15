'use strict';

/* =====================================================================
   Rumo — regras de negócio (funções puras, sem DOM e sem rede)
   ---------------------------------------------------------------------
   Vêm da planilha referencia/AcompanhamentoPeso.xlsx. Quando a regra
   sai de uma coluna, o comentário cita a aba e a coluna.

   Datas são sempre texto 'AAAA-MM-DD' (dia civil em São Paulo). As
   contas de dias usam Date.UTC para não depender do fuso do aparelho:
   new Date('2026-10-28') seria meia-noite UTC, que em São Paulo ainda
   é o dia 27.

   cfg (parâmetros, aba Configuracao):
     { inicio, pesoInicial, pesoAlvo, ganhoMin, ganhoIdeal, ganhoMax,
       ajusteKcal, limiteDobra, saldoMin, saldoMax }
   ===================================================================== */

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86400000;

/* ---------- Datas ---------- */

function diaNum(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(a, m - 1, d) / DIA_MS);
}

function isoDeNum(n) {
  return new Date(n * DIA_MS).toISOString().slice(0, 10);
}

function somarDias(iso, n) { return isoDeNum(diaNum(iso) + n); }

function diasEntre(de, ate) { return diaNum(ate) - diaNum(de); }

/** 0 = domingo … 6 = sábado. */
function diaDaSemana(iso) { return new Date(diaNum(iso) * DIA_MS).getUTCDay(); }

const FORMATO_SP = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Data e hora de agora no fuso de São Paulo: { data: 'AAAA-MM-DD', hora: 'HH:MM' }. */
function agoraSP(agora = new Date()) {
  const p = {};
  FORMATO_SP.formatToParts(agora).forEach((x) => { p[x.type] = x.value; });
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

function hojeSP(agora) { return agoraSP(agora).data; }
function horaSP(agora) { return agoraSP(agora).hora; }

/** 'HH:MM' ou 'HH:MM:SS' → minutos desde a meia-noite. */
function minutos(hora) {
  if (!hora) return null;
  const [h, m] = String(hora).split(':').map(Number);
  return h * 60 + (m || 0);
}

/* ---------- Semana do bulking ---------- */

/** Diario B: INT((data − início)/7) + 1. As semanas começam no dia de início, não na segunda. */
function semana(iso, inicio) { return Math.floor(diasEntre(inicio, iso) / 7) + 1; }

/** Semanal B e C. */
function inicioDaSemana(w, inicio) { return somarDias(inicio, (w - 1) * 7); }
function fimDaSemana(w, inicio) { return somarDias(inicio, (w - 1) * 7 + 6); }

/** O check-in semanal é no 1º dia de cada semana. */
function ehDiaDeCheckin(iso, inicio) {
  const d = diasEntre(inicio, iso);
  return d >= 0 && d % 7 === 0;
}

/* ---------- Números ---------- */

/* Variações como 74,4 − 74,3 dão 0,0999999… em ponto flutuante; a comparação com os
   limites usa o valor arredondado para não errar o status por um bit. */
function q(x) { return Math.round(x * 1e9) / 1e9; }

function media(valores) {
  const v = valores.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function numOuNulo(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Busca sem diferenciar maiúsculas e acentos. */
function normalizar(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/* ---------- Status da semana (Semanal K) ---------- */

const TEXTO_STATUS = {
  adaptacao: 'Adaptação (água/glicogênio) — aguarde',
  abaixo: 'Abaixo do ritmo — some 150–200 kcal (carbo)',
  rapido: 'Rápido demais — reduza 150–200 kcal',
  no_ritmo: 'No ritmo — mantenha',
};

function statusSemana(w, ritmo, cfg) {
  let codigo;
  if (ritmo === null || ritmo === undefined) return null;   // "Semana de base"
  if (w < 3) codigo = 'adaptacao';
  else if (q(ritmo) < q(cfg.ganhoMin)) codigo = 'abaixo';
  else if (q(ritmo) > q(cfg.ganhoMax)) codigo = 'rapido';
  else codigo = 'no_ritmo';
  return { codigo, texto: TEXTO_STATUS[codigo] };
}

/* ---------- Leitura das medidas (Semanal Z) ---------- */

const TEXTO_LEITURA = {
  dobra_subindo: 'Dobra subindo rápido — atenção à gordura',
  qualidade: 'Ganho de qualidade — braço sobe, dobra controlada',
  estavel: 'Estável — continue medindo',
};

/**
 * dobra: média da dobra na semana (T); dBracoS1 (U); dDobraS1 (W); dDobraAnt (X).
 * =IF(T="","",IF(AND(X<>"",X>lim),subindo,IF(AND(U<>"",U>0,OR(W="",W<=lim)),qualidade,estável)))
 */
function leituraMedidas({ dobra, dBracoS1, dDobraS1, dDobraAnt }, cfg) {
  let codigo;
  if (dobra === null || dobra === undefined) return null;
  if (dDobraAnt !== null && dDobraAnt !== undefined && q(dDobraAnt) > q(cfg.limiteDobra)) codigo = 'dobra_subindo';
  else if (dBracoS1 !== null && dBracoS1 !== undefined && q(dBracoS1) > 0
    && (dDobraS1 === null || dDobraS1 === undefined || q(dDobraS1) <= q(cfg.limiteDobra))) codigo = 'qualidade';
  else codigo = 'estavel';
  return { codigo, texto: TEXTO_LEITURA[codigo] };
}

/* ---------- Calorias sugeridas para a próxima semana (Semanal AA) ---------- */

/**
 * =IF(AND(K="",Z=""),"", IF(J="",meta,J) + IF(OR(reduza, dobra subindo), −ajuste, IF(some, +ajuste, 0)))
 * mediaKcal: média das kcal ingeridas na semana (J) ou null; meta: meta vigente.
 */
function sugestaoKcal(status, leitura, mediaKcal, meta, cfg) {
  if (!status && !leitura) return null;
  const base = mediaKcal === null || mediaKcal === undefined ? meta : mediaKcal;
  let ajuste = 0;
  let motivo = null;
  if ((status && status.codigo === 'rapido') || (leitura && leitura.codigo === 'dobra_subindo')) {
    ajuste = -cfg.ajusteKcal;
    motivo = status && status.codigo === 'rapido' ? 'rapido' : 'dobra';
  } else if (status && status.codigo === 'abaixo') {
    ajuste = cfg.ajusteKcal;
    motivo = 'abaixo';
  }
  return { base, ajuste, motivo, valor: Math.round(base + ajuste), usouMeta: mediaKcal === null || mediaKcal === undefined };
}

/* ---------- Aba Semanal inteira ---------- */

const MEDIDAS = ['braco', 'ombros', 'peitoral', 'abdomen', 'coxa', 'gluteos', 'panturrilha', 'dobra'];

/**
 * Calcula as semanas 1..ateSemana, como a aba Semanal.
 * dados = {
 *   pesos:  { 'AAAA-MM-DD': kg },           dias sem pesagem ficam de fora
 *   kcal:   { 'AAAA-MM-DD': kcal },         ingeridas, só dias com registro
 *   gasto:  { 'AAAA-MM-DD': kcal },
 *   medidas:{ w: { braco, ombros, …, dobra } },
 *   meta:   (iso) => kcal da meta vigente nesse dia
 * }
 */
function calcularSemanas(cfg, dados, ateSemana) {
  const semanas = [];
  const pesos = dados.pesos || {};
  const kcal = dados.kcal || {};
  const gasto = dados.gasto || {};
  const medidas = dados.medidas || {};
  const meta = dados.meta || (() => null);

  for (let w = 1; w <= ateSemana; w++) {
    const ini = inicioDaSemana(w, cfg.inicio);
    const fim = fimDaSemana(w, cfg.inicio);
    const dias = Array.from({ length: 7 }, (_, i) => somarDias(ini, i));

    const pesosSemana = dias.map((d) => numOuNulo(pesos[d])).filter((x) => x !== null);
    const mediaPeso = media(pesosSemana);                                 // E
    const anterior = semanas[w - 2] || null;
    const variacao = mediaPeso !== null && anterior && anterior.media !== null
      ? mediaPeso - anterior.media : null;                                // G
    let ritmo = null;                                                     // H
    if (variacao !== null) {
      ritmo = anterior && anterior.variacao !== null ? (variacao + anterior.variacao) / 2 : variacao;
    }

    const kcalSemana = dias.map((d) => numOuNulo(kcal[d])).filter((x) => x !== null);
    const mediaKcal = media(kcalSemana);                                  // J
    const gastoSemana = dias.map((d) => numOuNulo(gasto[d])).filter((x) => x !== null);
    const saldos = dias.map((d) => {
      const k = numOuNulo(kcal[d]);
      const g = numOuNulo(gasto[d]);
      return k !== null && g !== null ? k - g : null;
    }).filter((x) => x !== null);
    const metaSemana = meta(fim);

    const m = {};
    MEDIDAS.forEach((k) => { m[k] = medidas[w] ? numOuNulo(medidas[w][k]) : null; });
    const s1 = semanas[0] ? semanas[0].medidas : (w === 1 ? m : {});
    const delta = (a, b) => (a !== null && a !== undefined && b !== null && b !== undefined ? a - b : null);
    const dBracoS1 = delta(m.braco, s1.braco);                            // U
    const dAbdomenS1 = delta(m.abdomen, s1.abdomen);                      // V
    const dDobraS1 = delta(m.dobra, s1.dobra);                            // W
    const dDobraAnt = anterior ? delta(m.dobra, anterior.medidas.dobra) : null; // X

    const status = statusSemana(w, ritmo, cfg);                           // K
    const leitura = leituraMedidas({ dobra: m.dobra, dBracoS1, dDobraS1, dDobraAnt }, cfg); // Z
    const sugestao = sugestaoKcal(status, leitura, mediaKcal, metaSemana, cfg); // AA

    semanas.push({
      n: w,
      inicio: ini,
      fim,
      diasPesados: pesosSemana.length,                                    // D
      media: mediaPeso,
      esperado: cfg.pesoInicial + cfg.ganhoIdeal * w,                     // F
      variacao,
      ritmo,
      ganhoTotal: mediaPeso === null ? null : mediaPeso - cfg.pesoInicial, // I
      mediaKcal,
      diasKcal: kcalSemana.length,                                        // S
      metaKcal: metaSemana,
      kcalVsMeta: mediaKcal === null || metaSemana === null ? null : mediaKcal - metaSemana, // Y
      status,
      medidas: m,                                                         // L–R, T
      dBracoS1,
      dAbdomenS1,
      dDobraS1,
      dDobraAnt,
      leitura,
      sugestao,
      mediaGasto: media(gastoSemana),                                     // AB
      diasGasto: gastoSemana.length,
      saldoMedio: media(saldos),                                          // AC
      diasSaldo: saldos.length,
    });
  }
  return semanas;
}

/* ---------- Peso ---------- */

/** Média dos pesos registrados nos 7 dias que terminam em iso (inclusive). */
function mediaPeso7(pesos, iso) {
  const v = [];
  for (let i = 0; i < 7; i++) {
    const p = numOuNulo(pesos[somarDias(iso, -i)]);
    if (p !== null) v.push(p);
  }
  return media(v);
}

/** Último peso registrado antes de iso (exclusive), olhando até 30 dias para trás. */
function pesoAnterior(pesos, iso) {
  for (let i = 1; i <= 30; i++) {
    const d = somarDias(iso, -i);
    const p = numOuNulo(pesos[d]);
    if (p !== null) return { data: d, peso: p };
  }
  return null;
}

/**
 * Projeção até o alvo no ritmo atual. A média da semana n fica no fim da semana n,
 * então a semana "contínua" x corresponde à data início + 7x.
 */
function projecaoAlvo(cfg, n, mediaPeso, ritmo) {
  if (mediaPeso === null || ritmo === null || ritmo === undefined || q(ritmo) <= 0) return null;
  if (mediaPeso >= cfg.pesoAlvo) return { semanas: n, x: n, data: somarDias(cfg.inicio, n * 7) };
  const faltam = (cfg.pesoAlvo - mediaPeso) / ritmo;
  const x = n + faltam;
  return { semanas: faltam, x, data: somarDias(cfg.inicio, Math.round(x * 7)) };
}

/* ---------- Alimentação ---------- */

/** Valores de um item: gramas/100 × valor por 100 g. */
function macrosDoItem(gramas, por100) {
  const r = (numOuNulo(gramas) || 0) / 100;
  return {
    kcal: r * (numOuNulo(por100.kcal_100g) || 0),
    p: r * (numOuNulo(por100.protein_100g) || 0),
    c: r * (numOuNulo(por100.carb_100g) || 0),
    g: r * (numOuNulo(por100.fat_100g) || 0),
  };
}

/** Soma de itens (meal_entries). Sem itens, tudo zero. */
function somarItens(itens) {
  const t = { kcal: 0, p: 0, c: 0, g: 0 };
  (itens || []).forEach((it) => {
    const v = macrosDoItem(it.grams, it);
    t.kcal += v.kcal; t.p += v.p; t.c += v.c; t.g += v.g;
  });
  return t;
}

/** Saldo do dia = ingeridas − gastas (Diario N). */
function saldoDia(ingeridas, gastas) {
  if (ingeridas === null || ingeridas === undefined || gastas === null || gastas === undefined) return null;
  return ingeridas - gastas;
}

function faixaSaldo(saldo, cfg) {
  if (saldo === null || saldo === undefined) return null;
  if (saldo < 0) return 'deficit';
  if (saldo < cfg.saldoMin) return 'abaixo';
  if (saldo > cfg.saldoMax) return 'acima';
  return 'faixa';
}

function kcalDosMacros(p, c, g) { return 4 * (p || 0) + 4 * (c || 0) + 9 * (g || 0); }

/**
 * Status de um macro no dia.
 *   min   → ok se valor ≥ meta
 *   range → ok se mínimo ≤ valor ≤ máximo
 *   max   → ok se valor ≤ máximo
 * falta: quanto falta até a meta (≥ 0). excesso: quanto passou do limite (≥ 0).
 */
function statusMacro(meta, valor) {
  const alvo = numOuNulo(meta.target_g) || 0;
  const lo = numOuNulo(meta.low_g);
  const hi = numOuNulo(meta.high_g);
  let ok;
  let excesso = 0;
  if (meta.rule === 'range') {
    ok = (lo === null || valor >= lo) && (hi === null || valor <= hi);
    if (hi !== null && valor > hi) excesso = valor - hi;
  } else if (meta.rule === 'max') {
    const lim = hi === null ? alvo : hi;
    ok = valor <= lim;
    if (valor > lim) excesso = valor - lim;
  } else {
    ok = valor >= alvo;
  }
  return { ok, falta: Math.max(0, alvo - valor), excesso };
}

/** Novo alimento: confere 4P + 4C + 9G contra as kcal do rótulo. */
function conferirRotulo(kcal, p, c, g, tolerancia = 0.08) {
  const calc = kcalDosMacros(p, c, g);
  const diff = kcal > 0 ? Math.abs(calc - kcal) / kcal : 1;
  return { calc, diff, ok: kcal > 0 && diff <= tolerancia };
}

/** Rótulo "por porção" → valores por 100 g. */
function paraCem(valores, porcaoG) {
  const k = porcaoG > 0 ? 100 / porcaoG : 1;
  const r = {};
  Object.keys(valores).forEach((key) => {
    const v = numOuNulo(valores[key]);
    r[key] = v === null ? null : v * k;
  });
  return r;
}

/** Carboidrato que fecha a meta de kcal mantendo proteína e gordura. */
function carboParaFechar(metaKcal, p, g) {
  return Math.max(0, Math.round((metaKcal - 4 * (p || 0) - 9 * (g || 0)) / 4));
}

/** Meta de kcal vigente numa data: a última com effective_from ≤ data. */
function metaVigente(metas, iso) {
  let melhor = null;
  (metas || []).forEach((m) => {
    if (m.effective_from <= iso && (!melhor || m.effective_from > melhor.effective_from)) melhor = m;
  });
  return melhor;
}

/* ---------- Resumo do dia ---------- */

/** "Na meta" se ficar a até 5% da meta de kcal. */
function varianteDoDia(ingeridas, meta, tolerancia = 0.05) {
  if (!meta) return 'na_meta';
  if (Math.abs(ingeridas - meta) <= meta * tolerancia) return 'na_meta';
  return ingeridas < meta ? 'abaixo' : 'acima';
}

/**
 * Qual macro explica a maior parte da diferença de kcal em relação às metas.
 * sentido: 'abaixo' procura o que faltou; 'acima' o que passou.
 */
function macroQueMaisPesou(totais, metas, sentido) {
  const fatores = { protein: 4, carb: 4, fat: 9 };
  const valores = { protein: totais.p, carb: totais.c, fat: totais.g };
  let melhor = null;
  let maior = 0;
  Object.keys(fatores).forEach((k) => {
    const meta = metas[k];
    if (!meta) return;
    const diff = (valores[k] - (numOuNulo(meta.target_g) || 0)) * fatores[k];
    const peso = sentido === 'abaixo' ? -diff : diff;
    if (peso > maior) { maior = peso; melhor = k; }
  });
  return melhor;
}

/** Dias seguidos com registro até hoje (se hoje ainda não tem, conta a partir de ontem). */
function diasSeguidos(datas, hoje) {
  const set = datas instanceof Set ? datas : new Set(datas);
  let d = set.has(hoje) ? hoje : somarDias(hoje, -1);
  let n = 0;
  while (set.has(d)) { n++; d = somarDias(d, -1); }
  return n;
}

const REGRAS = {
  FUSO, diaNum, isoDeNum, somarDias, diasEntre, diaDaSemana, agoraSP, hojeSP, horaSP, minutos,
  semana, inicioDaSemana, fimDaSemana, ehDiaDeCheckin,
  media, numOuNulo, normalizar,
  TEXTO_STATUS, TEXTO_LEITURA, MEDIDAS,
  statusSemana, leituraMedidas, sugestaoKcal, calcularSemanas,
  mediaPeso7, pesoAnterior, projecaoAlvo,
  macrosDoItem, somarItens, saldoDia, faixaSaldo, kcalDosMacros, statusMacro,
  conferirRotulo, paraCem, carboParaFechar, metaVigente,
  varianteDoDia, macroQueMaisPesou, diasSeguidos,
};

if (typeof window !== 'undefined') window.REGRAS = REGRAS;
if (typeof module !== 'undefined') module.exports = REGRAS;
