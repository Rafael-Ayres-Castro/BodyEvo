# Rumo — notas para quem for mexer no código

PWA pessoal de bulking (um usuário). JS puro, sem build. Modelo do FastRep (`~/dev/FastRep/serie-pwa`).

- Regras da planilha: só em `regras.js` (funções puras) + `tests/regras.test.js` (`node --test`). Cite a coluna da planilha (`referencia/AcompanhamentoPeso.xlsx`, fora do git) ao mexer numa regra.
- `app.js` em seções: 1 dados (único lugar que fala com o Supabase) · 2 fila offline · 3 estado/utilidades · 4 telas (`renderX`) · 5 navegação/eventos.
- Eventos por delegação: `data-acao` (clique, mapa `ACOES`), `data-campo` (input, `CAMPOS`), `data-muda` (change, `MUDANCAS`). Campos digitáveis atualizam só os dependentes para não perder o foco.
- `daily_logs` é enviado só com as colunas alteradas (`salvarDia`): a api/ grava as colunas `garmin_*` e nunca sobrescreve `burned_source='manual'`.
- Cores e medidas só por variáveis em `:root` (`style.css`). Valores visuais vêm de `design/*.dc.html` (o bloco "Polimento" do `<helmet>` sobrescreve os anteriores).
- Toda entrega: aumentar `VERSAO` em `sw.js`. Commit/push só quando o usuário pedir.
- Login por código OTP de e-mail (o magic link abre no Safari, fora do PWA instalado).
- Garmin: endpoints e campos confirmados no Swagger oficial (ver `api/garmin.py`). Não inventar outros.
