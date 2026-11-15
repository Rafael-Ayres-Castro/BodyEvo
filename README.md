# BodyEvo

App pessoal (PWA) para acompanhar um bulking leve no iPhone: peso, refeições pesadas na balança, macros, check-in semanal com fita e adipômetro, resumo da semana com sugestão de calorias e evolução em gráficos. As regras vêm da planilha `AcompanhamentoPeso.xlsx`.

- **App:** HTML, CSS e JavaScript puro, sem framework e sem build. Publicado no GitHub Pages.
- **Dados:** Supabase (Auth + Postgres + RLS), acessado direto do navegador. Funciona offline: grava primeiro no aparelho e sincroniza depois.
- **`api/`:** uma FastAPI mínima, usada só para o Garmin e para enviar notificações. O app funciona sem ela.

```
index.html  style.css  app.js  regras.js  sw.js  manifest.json   → o app (estático)
vendor/  fonts/  icons/                                         → dependências guardadas no projeto
tests/regras.test.js                                            → testes das regras (node --test)
supabase/001_schema.sql  supabase/002_seed.sql                  → tabelas, RLS e dados iniciais
api/                                                            → FastAPI (Garmin + push)
.github/workflows/agendador.yml                                 → chama a api/ nos horários
render.yaml                                                     → hospedagem da api/ no Render
design/                                                         → telas de referência
```

## Rodar no computador

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

Sem `SUPABASE_URL` e `SUPABASE_KEY` em `app.js`, o app roda em **modo local**: não pede login e guarda tudo só no navegador. Serve para testar. Quando você configurar o Supabase e entrar, o que estiver no aparelho sobe para o servidor, desde que o servidor ainda esteja vazio.

Testes das regras da planilha (não precisam de instalar nada):

```bash
node --test
```

## 1. Supabase

1. Crie um projeto em [supabase.com](https://supabase.com). Recomendo um projeto só para o BodyEvo, separado do FastRep; o plano gratuito permite dois.
2. **SQL Editor › New query:** cole `supabase/001_schema.sql` e clique em **Run**. Pode rodar de novo sem problema.
3. **Authentication › Users › Add user › Create new user:** coloque seu e-mail e uma senha e marque **Auto Confirm User**. O login do app é por **e-mail e senha**; não precisa de SMTP, de template de e-mail nem de URLs de redirecionamento.
4. **Authentication › Sign In / Providers:** desligue **Allow new users to sign up**. O app não cria contas; só o usuário do passo 3 entra.
5. **Project Settings › API:** copie a *Project URL* e a chave **publishable** para o topo de `app.js`:
   ```js
   const SUPABASE_URL = 'https://xxxx.supabase.co';
   const SUPABASE_KEY = 'sb_publishable_…';
   ```
   A chave publishable é pública por natureza. Quem protege os dados é a RLS: cada linha tem `user_id` e só o dono da sessão lê e grava.
6. Abra o app e entre com o e-mail e a senha. No primeiro acesso, o app cria os parâmetros, a meta de 2.900 kcal, as metas de macros, as 7 refeições e os 16 alimentos. Se preferir criar pelo SQL, use `supabase/002_seed.sql`. A sessão fica salva: não é preciso entrar de novo a cada uso.

## 2. GitHub Pages

1. O repositório é **`Rafael-Ayres-Castro/BodyEvo`**. Ele pode ser público: nenhum segredo vai para o git, e `referencia/` (a planilha com seus dados) fica fora pelo `.gitignore`.
2. Faça o push da branch `main`.
3. **Settings › Pages › Source:** *Deploy from a branch*, branch `main`, pasta `/ (root)`. O `.nojekyll` já está no projeto.
4. O app fica em `https://rafael-ayres-castro.github.io/BodyEvo/`. Todos os caminhos são relativos (sem `/` no começo) para funcionar nesse subcaminho.

**A cada mudança no app, aumente a `VERSAO` em `sw.js`** (`bodyevo-v4` → `bodyevo-v5`…). É ela que faz o iPhone baixar a versão nova. A versão instalada aparece no fim da tela Ajustes.

## 3. iPhone

- Abra a URL do Pages no Safari, toque em **Compartilhar › Adicionar à Tela de Início** e abra o BodyEvo pelo ícone.
- Para testar no iPhone direto do computador, o Safari exige HTTPS (o service worker e as notificações não funcionam em `http://` pela rede local). O jeito mais simples é um túnel:
  ```bash
  python3 -m http.server 8000
  npx localtunnel --port 8000          # ou: cloudflared tunnel --url http://localhost:8000
  ```
  Adicione a URL do túnel às *Redirect URLs* do Supabase enquanto estiver testando.

## 4. `api/` (Garmin e notificações) no Render

O GitHub Pages não roda Python. A `api/` fica no **Render**, no plano gratuito com HTTPS. A hospedagem gratuita desliga a API quando ela fica parada, e o primeiro pedido depois disso leva cerca de 1 minuto. Por isso o agendador fica no GitHub Actions, e o app nunca depende da API.

1. Em [render.com](https://render.com), escolha **New › Blueprint** e aponte para o repositório. Ele lê o `render.yaml`.
2. Preencha as variáveis (veja `api/.env.example`):
   - `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`: a chave **service-role** fica **só** aqui.
   - `RUMO_USER_ID`: seu UID, em Supabase › Authentication › Users.
   - `GARMIN_API_KEY`: gere a chave pessoal em *Garmin Connect › Configurações › Personal API Token* (`connect.garmin.com/app/settings/personalApiToken`). A chave aparece uma vez só; ela vence em 30, 90 ou 180 dias, ou em 1 ano.
   - `VAPID_PRIVATE_KEY` e `INTERNAL_TOKEN`: **já gerados** em `api/.env`, que fica fora do git. Copie de lá. A chave VAPID pública correspondente já está em `app.js`.
   - `VAPID_SUBJECT`: `mailto:` com o seu e-mail.
3. Copie a URL do serviço (ex.: `https://rumo-api.onrender.com`) para `API_URL` em `app.js` e aumente a `VERSAO` do `sw.js`.
4. No GitHub, em **Settings › Secrets and variables › Actions**, crie os segredos `RUMO_API_URL` (a URL do passo 3) e `RUMO_INTERNAL_TOKEN` (o mesmo `INTERNAL_TOKEN`).
5. Em **Actions › Agendador › Run workflow**, rode uma vez para testar.

O agendador roda a cada 30 min, das 06:00 às 23:59 de São Paulo:
- **Garmin:** grava `kcal_burned`, as ativas, o repouso e a hora em `daily_logs`. Ele **nunca** sobrescreve um gasto que você informou manualmente.
- **Notificações:** pesagem no horário configurado (no dia de check-in, a mensagem inclui as medidas) e "Seu dia está pronto" no horário do resumo. Cada uma sai no máximo uma vez por dia.

> Repositórios públicos sem nenhum commit por 60 dias têm os workflows agendados desligados pelo GitHub. Se as notificações pararem, reative em Actions.

Para rodar a API no computador:

```bash
cd api && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
set -a; . ./.env; set +a
uvicorn main:app --reload --port 8001
```

Endpoints do Garmin usados, conferidos no Swagger oficial e no [cliente Python da Garmin](https://github.com/garmin/connect-personal-api-python):
- `POST /personalapitoken-service/personal-api/personal-api-key/token` com `Authorization: ApiKey …`, que devolve um JWT válido por 24 h;
- `GET /usersummary-service/usersummary/daily?calendarDate=AAAA-MM-DD`, de onde saem `totalKilocalories`, `activeKilocalories`, `bmrKilocalories` e `lastSyncTimestampGMT`.

## 5. Notificações no iPhone

1. Instale o app na Tela de Início (iOS 16.4 ou mais novo).
2. Em **Ajustes › Notificações neste aparelho**, toque em *Ativar* e permita.
3. Os interruptores de Lembretes controlam o que a `api/` envia.

## Importar e exportar

- **Importar** (Ajustes › Dados) lê o `.xlsx` no próprio navegador, com o SheetJS em `vendor/`:
  - Configuracao → parâmetros;
  - Diario → peso, gasto e observação;
  - as kcal ingeridas de cada dia viram um item "Importado da planilha";
  - as medidas diárias viram a média semanal do check-in.
- **Exportar** gera o `.xlsx` com as abas Configuracao, Diario e Semanal, nas colunas da planilha, e um `.csv` do diário no padrão do Excel brasileiro (`;` e vírgula decimal).

## Dependências (versões fixas, no projeto)

| Arquivo | Versão | Por quê |
|---|---|---|
| `vendor/supabase.min.js` | supabase-js 2.45.4 | banco e login; a mesma versão do FastRep |
| `vendor/xlsx.full.min.js` | SheetJS 0.20.3 (cdn.sheetjs.com) | importar e exportar .xlsx sem servidor; a 0.18.5 do npm tem falha conhecida ao ler arquivos |
| `fonts/plus-jakarta-sans-latin-wght-normal.woff2` | @fontsource-variable 5.1.1 | fonte do design, pesos 200–800, licença OFL |
| `api/requirements.txt` | FastAPI, uvicorn, httpx, pywebpush | só na `api/` |
# BodyEvo
