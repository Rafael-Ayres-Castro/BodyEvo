'use strict';

// Rodar com: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../regras.js');

const CFG = {
  inicio: '2026-10-28',
  pesoInicial: 74.0,
  pesoAlvo: 80.0,
  ganhoMin: 0.10,
  ganhoIdeal: 0.25,
  ganhoMax: 0.40,
  ajusteKcal: 175,
  limiteDobra: 1.0,
  saldoMin: 200,
  saldoMax: 300,
};

// Seção 5.6: pesos de 28/10 a 08/12 (null = sem pesagem).
const PESOS_SEMANAS = [
  [74.0, 74.3, 74.1, 74.5, 74.6, 74.2, 74.4],
  [74.5, 74.8, 74.6, 74.7, 74.9, 74.5, 74.6],
  [74.7, 74.9, 74.6, 74.8, 75.0, 74.7, 74.7],
  [74.8, 74.7, 74.9, 75.0, 74.8, 74.7, 74.9],
  [75.0, 75.2, 74.9, 75.1, 75.3, 75.0, 75.2],
  [75.3, 75.4, 75.2, null, 75.6, 75.3, 75.4],
];
const DOBRA = [14.0, 14.4, 14.3, 14.4, 14.8, 14.9];
const BRACO = [35.5, 35.6, 35.6, 35.8, 36.0, 36.1];

function pesosPorDia(semanas = PESOS_SEMANAS, inicio = CFG.inicio) {
  const pesos = {};
  semanas.forEach((sem, w) => sem.forEach((p, i) => {
    if (p !== null) pesos[R.somarDias(inicio, w * 7 + i)] = p;
  }));
  return pesos;
}

function medidas(dobra = DOBRA, braco = BRACO) {
  const m = {};
  dobra.forEach((d, i) => { m[i + 1] = { dobra: d, braco: braco[i] }; });
  return m;
}

const perto = (real, esperado, casas = 3) =>
  assert.equal(Number(real.toFixed(casas)), esperado, `${real} ≠ ${esperado}`);

/* ---------- Datas e semana ---------- */

test('semana começa no dia de início (quarta), não na segunda', () => {
  assert.equal(R.semana('2026-10-28', CFG.inicio), 1);
  assert.equal(R.semana('2026-11-03', CFG.inicio), 1);
  assert.equal(R.semana('2026-11-04', CFG.inicio), 2);
  assert.equal(R.semana('2026-12-09', CFG.inicio), 7);
  assert.equal(R.diaDaSemana('2026-10-28'), 3); // quarta
  assert.equal(R.inicioDaSemana(7, CFG.inicio), '2026-12-09');
  assert.equal(R.fimDaSemana(6, CFG.inicio), '2026-12-08');
});

test('dia de check-in é o 1º dia de cada semana', () => {
  assert.equal(R.ehDiaDeCheckin('2026-10-28', CFG.inicio), true);
  assert.equal(R.ehDiaDeCheckin('2026-12-09', CFG.inicio), true);
  assert.equal(R.ehDiaDeCheckin('2026-12-10', CFG.inicio), false);
  assert.equal(R.ehDiaDeCheckin('2026-10-21', CFG.inicio), false);
});

test('data de hoje usa o fuso de São Paulo, não UTC', () => {
  // 02:30 UTC de 29/10 ainda é 23:30 de 28/10 em São Paulo (UTC−3).
  const agora = new Date(Date.UTC(2026, 9, 29, 2, 30));
  assert.equal(R.hojeSP(agora), '2026-10-28');
  assert.equal(R.horaSP(agora), '23:30');
  assert.equal(R.somarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(R.diasEntre('2026-10-28', '2026-12-09'), 42);
});

/* ---------- Seção 5.6: tabela esperada ---------- */

test('médias, variação, ritmo e status das semanas 1 a 6', () => {
  const kcal = {};
  for (let i = 0; i < 7; i++) kcal[R.somarDias(R.inicioDaSemana(4, CFG.inicio), i)] = 2900;
  const s = R.calcularSemanas(CFG, { pesos: pesosPorDia(), kcal, medidas: medidas(), meta: () => 2900 }, 6);

  const esperado = [
    { media: 74.300, variacao: null, ritmo: null, status: null },
    { media: 74.657, variacao: 0.357, ritmo: 0.357, status: 'adaptacao' },
    { media: 74.771, variacao: 0.114, ritmo: 0.236, status: 'no_ritmo' },
    { media: 74.829, variacao: 0.057, ritmo: 0.086, status: 'abaixo' },
    { media: 75.100, variacao: 0.271, ritmo: 0.164, status: 'no_ritmo' },
    { media: 75.367, variacao: 0.267, ritmo: 0.269, status: 'no_ritmo' },
  ];
  esperado.forEach((e, i) => {
    const w = s[i];
    perto(w.media, e.media);
    if (e.variacao === null) assert.equal(w.variacao, null); else perto(w.variacao, e.variacao);
    if (e.ritmo === null) assert.equal(w.ritmo, null); else perto(w.ritmo, e.ritmo);
    assert.equal(w.status ? w.status.codigo : null, e.status, `status da semana ${i + 1}`);
  });

  assert.equal(s[0].status, null); // "Semana de base"
  assert.equal(s[1].status.texto, 'Adaptação (água/glicogênio) — aguarde');
  assert.equal(s[3].status.texto, 'Abaixo do ritmo — some 150–200 kcal (carbo)');
  assert.equal(s[5].diasPesados, 6);
  perto(s[5].ganhoTotal, 1.367);
  perto(s[5].esperado, 75.5, 2);
});

test('leitura das medidas: S1 estável, S2 a S6 ganho de qualidade', () => {
  const s = R.calcularSemanas(CFG, { pesos: pesosPorDia(), medidas: medidas(), meta: () => 2900 }, 6);
  assert.equal(s[0].leitura.codigo, 'estavel');
  assert.equal(s[0].leitura.texto, 'Estável — continue medindo');
  for (let i = 1; i < 6; i++) {
    assert.equal(s[i].leitura.codigo, 'qualidade', `semana ${i + 1}`);
  }
  assert.equal(s[1].leitura.texto, 'Ganho de qualidade — braço sobe, dobra controlada');
  perto(s[5].dBracoS1, 0.6, 1);
  perto(s[5].dDobraS1, 0.9, 1);
  perto(s[5].dDobraAnt, 0.1, 1);
});

test('média de 2.900 kcal na S4 sugere 3.075 para a S5', () => {
  const kcal = {};
  [2800, 2950, 2900, 3000, 2850, 2900, 2900].forEach((k, i) => {
    kcal[R.somarDias(R.inicioDaSemana(4, CFG.inicio), i)] = k;
  });
  const s = R.calcularSemanas(CFG, { pesos: pesosPorDia(), kcal, medidas: medidas(), meta: () => 2900 }, 6);
  assert.equal(s[3].mediaKcal, 2900);
  assert.equal(s[3].diasKcal, 7);
  assert.equal(s[3].sugestao.ajuste, 175);
  assert.equal(s[3].sugestao.valor, 3075);
});

test('sugestão: semana sem registro de kcal usa a meta vigente', () => {
  const s = R.calcularSemanas(CFG, { pesos: pesosPorDia(), medidas: medidas(), meta: () => 2900 }, 6);
  assert.equal(s[3].mediaKcal, null);
  assert.equal(s[3].sugestao.valor, 3075);       // 2.900 (meta) + 175
  assert.equal(s[3].sugestao.usouMeta, true);
  assert.equal(s[0].sugestao.valor, 2900);       // S1: só a leitura existe → base + 0
  assert.equal(s[0].sugestao.ajuste, 0);
});

/* ---------- Bordas ---------- */

test('semana sem nenhuma pesagem fica vazia e quebra a variação', () => {
  const semanas = PESOS_SEMANAS.map((s) => s.slice());
  semanas[2] = [null, null, null, null, null, null, null];
  const s = R.calcularSemanas(CFG, { pesos: pesosPorDia(semanas) }, 6);
  assert.equal(s[2].diasPesados, 0);
  assert.equal(s[2].media, null);
  assert.equal(s[2].variacao, null);
  assert.equal(s[2].ritmo, null);
  assert.equal(s[2].status, null);
  // S4: há variação, mas não a da S3 → ritmo usa só a da própria semana.
  assert.equal(s[3].variacao, null);   // a S3 não tem média
  assert.equal(s[4].ritmo, s[4].variacao);
  assert.equal(s[2].ganhoTotal, null);
});

test('só uma semana de dados: sem variação, sem status, sem sugestão', () => {
  const s = R.calcularSemanas(CFG, { pesos: pesosPorDia([PESOS_SEMANAS[0]]) }, 1);
  assert.equal(s.length, 1);
  perto(s[0].media, 74.3);
  assert.equal(s[0].variacao, null);
  assert.equal(s[0].status, null);
  assert.equal(s[0].leitura, null);
  assert.equal(s[0].sugestao, null);
});

test('dobra subindo mais de 1,0 mm na semana gera −175', () => {
  const dobra = [14.0, 14.4, 14.3, 14.4, 15.6, 15.8];   // S5: +1,2 mm vs S4
  const kcal = {};
  for (let i = 0; i < 7; i++) kcal[R.somarDias(R.inicioDaSemana(5, CFG.inicio), i)] = 3075;
  const s = R.calcularSemanas(CFG, { pesos: pesosPorDia(), kcal, medidas: medidas(dobra), meta: () => 3075 }, 6);
  assert.equal(s[4].leitura.codigo, 'dobra_subindo');
  assert.equal(s[4].leitura.texto, 'Dobra subindo rápido — atenção à gordura');
  assert.equal(s[4].status.codigo, 'no_ritmo');
  assert.equal(s[4].sugestao.ajuste, -175);
  assert.equal(s[4].sugestao.motivo, 'dobra');
  assert.equal(s[4].sugestao.valor, 2900);
  // S6: subiu só 0,2 vs S5, mas está 1,8 acima da S1 → não é "qualidade".
  assert.equal(s[5].leitura.codigo, 'estavel');
});

test('ritmo acima de 0,40 kg/sem: "Rápido demais" e −175', () => {
  const st = R.statusSemana(4, 0.45, CFG);
  assert.equal(st.codigo, 'rapido');
  assert.equal(st.texto, 'Rápido demais — reduza 150–200 kcal');
  const sug = R.sugestaoKcal(st, null, 3100, 3075, CFG);
  assert.equal(sug.valor, 2925);
  assert.equal(sug.motivo, 'rapido');
  // Limites exatos contam como "no ritmo".
  assert.equal(R.statusSemana(4, 0.40, CFG).codigo, 'no_ritmo');
  assert.equal(R.statusSemana(4, 74.4 - 74.3, CFG).codigo, 'no_ritmo');
  assert.equal(R.statusSemana(2, 0.9, CFG).codigo, 'adaptacao');
});

test('dia sem refeições soma zero e o saldo depende do gasto', () => {
  const t = R.somarItens([]);
  assert.deepEqual(t, { kcal: 0, p: 0, c: 0, g: 0 });
  assert.equal(R.saldoDia(t.kcal, 2500), -2500);
  assert.equal(R.saldoDia(t.kcal, null), null);
  assert.equal(R.faixaSaldo(-2500, CFG), 'deficit');
  assert.equal(R.faixaSaldo(250, CFG), 'faixa');
  assert.equal(R.faixaSaldo(150, CFG), 'abaixo');
  assert.equal(R.faixaSaldo(301, CFG), 'acima');
});

test('itens de refeição: gramas/100 × valores por 100 g', () => {
  const arroz = { grams: 220, kcal_100g: 128, protein_100g: 2.5, carb_100g: 28.1, fat_100g: 0.2 };
  const frango = { grams: 150, kcal_100g: 159, protein_100g: 32.0, carb_100g: 0, fat_100g: 2.5 };
  const t = R.somarItens([arroz, frango]);
  perto(t.kcal, 520.1, 1);
  perto(t.p, 53.5, 1);
  perto(t.c, 61.82, 2);
  perto(t.g, 4.19, 2);
});

test('alimento com porção é convertido para 100 g ao salvar', () => {
  // Rótulo do design: whey baunilha, porção de 30 g.
  const por100 = R.paraCem({ kcal: 120, p: 24, c: 2.4, g: 1.8 }, 30);
  perto(por100.kcal, 400, 1);
  perto(por100.p, 80, 1);
  perto(por100.c, 8, 1);
  perto(por100.g, 6, 1);
  const chk = R.conferirRotulo(120, 24, 2.4, 1.8);
  perto(chk.calc, 121.8, 1);
  assert.equal(chk.ok, true);
  const ruim = R.conferirRotulo(120, 30, 10, 5);   // 205 kcal pelos macros
  assert.equal(ruim.ok, false);
  assert.ok(ruim.diff > 0.08);
  assert.equal(R.conferirRotulo(0, 1, 1, 1).ok, false);
});

test('status dos macros: mínimo, faixa e máximo', () => {
  const prot = { rule: 'min', target_g: 166 };
  const carb = { rule: 'range', target_g: 400, low_g: 360, high_g: 440 };
  const gord = { rule: 'max', target_g: 90, high_g: 100 };
  assert.equal(R.statusMacro(prot, 179).ok, true);
  assert.equal(R.statusMacro(prot, 150).falta, 16);
  assert.equal(R.statusMacro(carb, 282).ok, false);
  assert.equal(R.statusMacro(carb, 282).falta, 118);
  assert.equal(R.statusMacro(carb, 403).ok, true);
  assert.equal(R.statusMacro(carb, 455).excesso, 15);
  assert.equal(R.statusMacro(gord, 69).ok, true);
  assert.equal(R.statusMacro(gord, 69).falta, 21);
  assert.equal(R.statusMacro(gord, 112).ok, false);
  assert.equal(R.statusMacro(gord, 112).excesso, 12);
});

test('metas de macros: kcal, g/kg e carboidrato para fechar', () => {
  assert.equal(R.kcalDosMacros(166, 400, 90), 3074);
  assert.equal(R.carboParaFechar(3075, 166, 90), 400);
  assert.equal(R.carboParaFechar(2900, 166, 90), 357);
  const pesos = pesosPorDia();
  perto(R.mediaPeso7(pesos, '2026-12-08'), 75.367);   // 6 pesagens na janela
  assert.deepEqual(R.pesoAnterior(pesos, '2026-12-06'), { data: '2026-12-04', peso: 75.2 });
});

test('meta de kcal vigente pela data', () => {
  const metas = [
    { effective_from: '2026-10-28', kcal: 2900 },
    { effective_from: '2026-11-25', kcal: 3075 },
  ];
  assert.equal(R.metaVigente(metas, '2026-11-24').kcal, 2900);
  assert.equal(R.metaVigente(metas, '2026-11-25').kcal, 3075);
  assert.equal(R.metaVigente(metas, '2026-10-01'), null);
});

test('projeção até 80 kg no ritmo atual', () => {
  const p = R.projecaoAlvo(CFG, 6, 75.367, 0.269);
  perto(p.x, 23.2, 1);
  // 6 + 4,633/0,269 = 23,22 semanas → 162,6 dias depois de 28/10 (o design arredonda para 8/abr).
  assert.equal(p.data, '2027-04-09');
  assert.equal(R.projecaoAlvo(CFG, 6, 75.367, 0), null);
  assert.equal(R.projecaoAlvo(CFG, 6, 75.367, -0.1), null);
});

test('resumo do dia: variante, macro que mais pesou e dias seguidos', () => {
  assert.equal(R.varianteDoDia(3069, 3075), 'na_meta');
  assert.equal(R.varianteDoDia(2480, 3075), 'abaixo');
  assert.equal(R.varianteDoDia(3620, 3075), 'acima');
  const metas = {
    protein: { target_g: 166 }, carb: { target_g: 400 }, fat: { target_g: 90 },
  };
  assert.equal(R.macroQueMaisPesou({ p: 172, c: 290, g: 66 }, metas, 'abaixo'), 'carb');
  assert.equal(R.macroQueMaisPesou({ p: 205, c: 455, g: 112 }, metas, 'acima'), 'carb');
  assert.equal(R.macroQueMaisPesou({ p: 170, c: 410, g: 140 }, metas, 'acima'), 'fat');
  const dias = ['2026-12-05', '2026-12-06', '2026-12-07', '2026-12-08'];
  assert.equal(R.diasSeguidos(dias, '2026-12-08'), 4);
  assert.equal(R.diasSeguidos(dias, '2026-12-09'), 4);   // hoje ainda sem registro
  assert.equal(R.diasSeguidos(dias, '2026-12-11'), 0);
});

test('busca ignora acentos e maiúsculas', () => {
  assert.equal(R.normalizar('Feijão Carioca'), 'feijao carioca');
  assert.ok(R.normalizar('Brócolis cozido').includes(R.normalizar('BROCOLIS')));
});
