# WhatsApp Bot Wilson Sanches

Aplicacao full-stack com React/Vite no front e Express no backend. A tela e simples: gerar QR Code, escanear no WhatsApp e deixar o bot respondendo automaticamente.

## Rodar localmente

```bash
npm install
npm run dev
```

Depois abra `http://localhost:5173`, clique em `Gerar QR Code` e escaneie pelo WhatsApp.

Por padrao o bot nao responde mensagens em grupos:

```bash
WHATSAPP_RESPOND_TO_GROUPS=false
```

## Scripts

- `npm run dev`: backend em `http://localhost:3001` e front em `http://localhost:5173`.
- `npm run build`: gera o build do React.
- `npm run start`: serve API e build em modo producao.

## Resposta automatica

Com `GEMINI_API_KEY` configurada, toda mensagem privada recebida passa pelo Gemini antes de ser respondida.
Mensagens seguidas do mesmo contato sao agrupadas por 20 segundos antes da resposta, para evitar varias respostas quando o cliente manda textos quebrados. Ajuste com `AUTO_REPLY_DEBOUNCE_MS`.

Crie um `.env` com:

```bash
GEMINI_API_KEY=sua_chave_aqui
GEMINI_MODEL=gemini-2.5-flash
AUTO_REPLY_DEBOUNCE_MS=20000
```

Sem chave do Gemini, o bot usa o fallback:

```txt
Ola! Recebemos sua mensagem. Ja vamos te responder.
```

Para trocar o fallback, ajuste `AUTO_REPLY_TEXT`. A personalidade e as regras comerciais da IA ficam versionadas no codigo em [server/geminiClient.js](/Users/thalesmenzner/Documents/contabsquad/server/geminiClient.js).

## Fluxo comercial

O bot atende de forma formal e direta para reintegracao de credito e regularizacao de restricoes em CPF e CNPJ.

- CPF: analise completa por R$150, roteada como `low_ticket` para a agenda Andre.
- CNPJ: analise completa por R$250, roteada como `high_ticket` para a agenda Wilson.
- A analise cobre apontamentos como Serasa, SPC, Boa Vista, Bacen, Cadin, cheque motivo 12 e outros bloqueios que impactam credito, financiamento, rating bancario e linhas de credito.
- Quem nao aceita pagar a analise e classificado como curioso/descartado e nao vai para agenda.
- O bot nao promete limpeza garantida, prazo fechado, aprovacao de credito ou financiamento antes da analise.
- Para marcar, o cliente precisa aceitar a analise paga e informar data, horario e email do convite.

## Google Agenda

O bot tambem entende pedidos de reuniao pelo WhatsApp. Exemplo:

```txt
Quero marcar uma reuniao amanha as 15h com cliente@email.com
```

Ele coleta data, horario e email, pede confirmacao e cria o evento no Google Agenda com link do Meet.

Configuracao recomendada via OAuth:

```bash
GOOGLE_OAUTH_CLIENT_ID=client_id_do_google
GOOGLE_OAUTH_CLIENT_SECRET=client_secret_do_google
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/api/google/callback
GOOGLE_OAUTH_TOKEN_DIR=.secrets
GOOGLE_CALENDAR_ID=primary
GOOGLE_CALENDAR_TIME_ZONE=America/Sao_Paulo
GOOGLE_CALENDAR_EVENT_DURATION_MINUTES=30
```

Depois suba o app, clique em `Conectar Google` na dashboard e aceite o acesso ao Google Agenda. O token fica salvo localmente em `.secrets/`, que nao entra no Git. No Render, use Render Disk e configure `GOOGLE_OAUTH_TOKEN_DIR=/var/data/secrets` para nao perder os tokens em restart/deploy.

Se quiser duas contas diferentes, conecte uma por lead type usando as URLs:

```txt
http://localhost:3001/api/google/auth-url?leadType=low_ticket
http://localhost:3001/api/google/auth-url?leadType=high_ticket
```

Ou compartilhe as duas agendas com uma unica conta Google conectada e preencha:

```bash
GOOGLE_CALENDAR_LOW_TICKET_ID=agenda-do-andre@group.calendar.google.com
GOOGLE_CALENDAR_HIGH_TICKET_ID=agenda-do-wilson@group.calendar.google.com
```

Configuracao alternativa via service account:

```bash
GOOGLE_CALENDAR_ID=agenda@empresa.com
GOOGLE_CALENDAR_LOW_TICKET_ID=agenda-low@empresa.com
GOOGLE_CALENDAR_HIGH_TICKET_ID=agenda-high@empresa.com
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=.secrets/google-service-account.json
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@projeto.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_CALENDAR_TIME_ZONE=America/Sao_Paulo
GOOGLE_CALENDAR_EVENT_DURATION_MINUTES=30
```

Compartilhe as agendas low e high com o email da service account. Para gerar Meet, a conta/agenda precisa permitir criacao de conferencias pelo Google Calendar.

O Gemini classifica `CPF` como `low_ticket`, `CNPJ` como `high_ticket` e quem nao aceita pagar a analise como `curious`/descartado. Se vier `unknown`, o bot pergunta se o caso e CPF ou CNPJ antes de escolher a agenda.

## Supabase e follow-up

Para os lembretes nao dependerem do filesystem do Render, os agendamentos sao salvos no Supabase.

1. Crie um projeto no Supabase.
2. Abra o SQL Editor.
3. Rode o arquivo [supabase/schema.sql](/Users/thalesmenzner/Documents/contabsquad/supabase/schema.sql).
4. Pegue `Project URL` e `service_role key`.
5. Configure no `.env`:

```bash
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key
SUPABASE_APPOINTMENTS_TABLE=whatsapp_appointments
FOLLOWUP_ENABLED=true
FOLLOWUP_DAY_REMINDER_TIME=08:00
FOLLOWUP_CHECK_INTERVAL_MS=60000
```

Quando uma reuniao e criada, o bot salva no Supabase. O worker verifica a cada minuto e envia:

- confirmacao no dia da reuniao, a partir de `FOLLOWUP_DAY_REMINDER_TIME`;
- lembrete 30 minutos antes.

Se o servidor reiniciar, os agendamentos continuam no Supabase. Se o WhatsApp estiver desconectado no horario do lembrete, o envio falha e o lembrete fica pendente para uma proxima checagem.

## Dados locais

- Sessao do WhatsApp: `WHATSAPP_SESSION_DIR` ou `server/sessions/baileys`.
- Preferencias do painel: `APP_SETTINGS_PATH` ou `server/data/settings.json`.
- Conversas recentes locais: `server/data/`.

Essas pastas ficam fora do Git para evitar subir credenciais e historico local.

No Render, adicione um Disk e use caminhos persistentes:

```bash
WHATSAPP_SESSION_DIR=/var/data/baileys
GOOGLE_OAUTH_TOKEN_DIR=/var/data/secrets
APP_SETTINGS_PATH=/var/data/settings.json
```

## Observacao

Baileys e Venom nao sao APIs oficiais da Meta. Use com uma conta autorizada, mensagens consentidas e baixo volume. Para operacao comercial em producao, a opcao mais estavel e usar a WhatsApp Business Platform oficial.
