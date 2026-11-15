# BodyEvo — notas para quem for mexer no código

PWA pessoal de bulking (um usuário). JS puro, sem build. Modelo do FastRep (`~/dev/FastRep/serie-pwa`).

- O app se chamava Rumo. As chaves de armazenamento (`rumo.cache`, `rumo.auth`, `rumo.fila`…) e os nomes de infraestrutura (`rumo-api`, `RUMO_*`) continuam assim de propósito: trocar as chaves apaga a sessão e os dados do aparelho. "Rumo aos X kg" no resumo é frase, não o nome.

- Regras da planilha: só em `regras.js` (funções puras) + `tests/regras.test.js` (`node --test`). Cite a coluna da planilha (`referencia/AcompanhamentoPeso.xlsx`, fora do git) ao mexer numa regra.
- `app.js` em seções: 1 dados (único lugar que fala com o Supabase) · 2 fila offline · 3 estado/utilidades · 4 telas (`renderX`) · 5 navegação/eventos.
- Eventos por delegação: `data-acao` (clique, mapa `ACOES`), `data-campo` (input, `CAMPOS`), `data-muda` (change, `MUDANCAS`). Campos digitáveis atualizam só os dependentes para não perder o foco.
- `daily_logs` é enviado só com as colunas alteradas (`salvarDia`): a api/ grava as colunas `garmin_*` e nunca sobrescreve `burned_source='manual'`.
- Cores e medidas só por variáveis em `:root` (`style.css`). Valores visuais vêm de `design/*.dc.html` (o bloco "Polimento" do `<helmet>` sobrescreve os anteriores).
- Toda entrega: aumentar `VERSAO` em `sw.js`.
- Git: ao terminar qualquer mudança, fazer commit e push automático (sem pedir confirmação) para `https://github.com/Rafael-Ayres-Castro/BodyEvo.git`, branch `main`. Autorização permanente do usuário.
- Commits e PRs **sem** Claude como coautor: nunca adicionar `Co-Authored-By`, "Generated with Claude Code" ou qualquer atribuição ao Claude. O autor é só o usuário.
- Login por e-mail e senha (`signInWithPassword`). O usuário é criado no painel do Supabase e o cadastro público fica desligado. Sem OTP e sem magic link: dispensa SMTP e template de e-mail.
- Garmin: endpoints e campos confirmados no Swagger oficial (ver `api/garmin.py`). Não inventar outros.
- Alimentos externos só preenchem, nunca gravam sozinhos no histórico: TACO (`dados/taco.json`, gerado por `ferramentas/gerar_taco.py`, não editar à mão) e Open Food Facts (`buscarCodigoBarras`, `world.openfoodfacts.org/api/v2/product/{código}`, campos `*_100g`). A ZXing (`vendor/zxing.min.js`) carrega só ao abrir o leitor.
