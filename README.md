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
WHATSAPP_AUTO_CONNECT=true
```

Em producao, `WHATSAPP_AUTO_CONNECT` tenta religar o WhatsApp automaticamente quando o Render reinicia usando a sessao salva em `WHATSAPP_SESSION_DIR`.

## Scripts

- `npm run dev`: backend em `http://localhost:3001` e front em `http://localhost:5173`.
- `npm run build`: gera o build do React.
- `npm run start`: serve API e build em modo producao.

## Resposta automatica

Com `GEMINI_API_KEY` configurada, toda mensagem privada recebida passa pelo Gemini antes de ser respondida.
Mensagens seguidas do mesmo contato sao agrupadas por 2,5 segundos antes da resposta, para evitar varias respostas quando o cliente manda textos quebrados. Ajuste com `AUTO_REPLY_DEBOUNCE_MS`.

Crie um `.env` com:

```bash
GEMINI_API_KEY=sua_chave_aqui
GEMINI_MODEL=gemini-2.5-flash
GEMINI_AUDIO_MODEL=gemini-2.5-flash
AUTO_REPLY_DEBOUNCE_MS=2500
AUTO_REPLY_DELAY_MS=0
```

Sem chave do Gemini, o bot usa a abordagem inicial:

```txt
Cresce Mais, Consultoria Financeira!
Somos especializados em reintegracao de credito para destravar o seu financiamento.
Atuamos com:
- Limpa nome / renegociacao de dividas
- Rating bancario
- Consulta Bacen
- Devolutiva de cheque
- Cadin
- CPF e CNPJ
Me conta: o que voce precisa resolver hoje?
Responda com o numero:
1 - Quero uma consulta tecnica na plataforma pra entender minha real situacao de dividas (investimento: R$150)
2 - So quero entender como funciona
3 - E urgente, preciso resolver hoje (me passa seu numero que eu te ligo pra alinharmos)
```

Para trocar o fallback, ajuste `AUTO_REPLY_TEXT`. A personalidade e as regras comerciais da IA ficam versionadas no codigo em [server/geminiClient.js](/Users/thalesmenzner/Documents/contabsquad/server/geminiClient.js).

No painel de `Clientes`, use `Assumir` para pausar a IA em uma conversa especifica. Enquanto estiver em modo manual, novas mensagens continuam sendo salvas no historico, mas nenhuma resposta automatica e enviada para aquele contato. Use `Retomar IA` para ligar o atendimento automatico novamente.

## WhatsApp Oficial Meta

O projeto tambem pode rodar pela WhatsApp Business Platform oficial, usando a Cloud API da Meta junto com o QR Code/Baileys atual. Os dois modulos convivem no servidor; no painel em `Conexoes`, selecione qual canal fica ativo para envio manual e follow-ups.

`WHATSAPP_PROVIDER` define apenas o canal inicial quando o servidor sobe. Depois, a selecao feita no painel fica salva em `APP_SETTINGS_PATH` ou `server/data/settings.json`.

Configure a Meta quando tiver a conta pronta:

```bash
WHATSAPP_PROVIDER=meta
META_WHATSAPP_ACCESS_TOKEN=token_de_sistema_ou_permanente
META_WHATSAPP_PHONE_NUMBER_ID=id_do_numero_no_whatsapp_manager
META_WHATSAPP_VERIFY_TOKEN=um_token_secreto_para_validar_o_webhook
META_WHATSAPP_APP_SECRET=app_secret_opcional_para_validar_x_hub_signature_256
META_WHATSAPP_GRAPH_API_VERSION=v25.0
META_WHATSAPP_AUDIO_TRANSCRIPTION_ENABLED=true
META_WHATSAPP_AUDIO_MAX_BYTES=14680064
```

No painel da Meta, configure o callback URL para:

```txt
https://seu-dominio.com/api/meta/webhook
```

Use o mesmo valor de `META_WHATSAPP_VERIFY_TOKEN` no campo `Verify Token` da Meta. Assine o campo `messages` do produto WhatsApp para receber mensagens e status.

O modulo oficial ja cobre:

- webhook GET de verificacao e POST de eventos da Meta;
- envio de texto pelo endpoint oficial da Graph API;
- leitura de texto, botoes/listas interativas e captions de midia;
- transcricao de audio via Gemini quando configurado;
- registro de falhas de entrega enviadas pela Meta;
- endpoint interno para template oficial: `POST /api/meta/templates/send`.

O envio manual, follow-ups, funil com IA, agendamento e historico continuam usando as mesmas telas do painel. O canal nao selecionado continua podendo registrar mensagens recebidas, mas nao envia resposta automatica enquanto estiver inativo.

Referencias oficiais:

- [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [Envio de mensagens](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages)
- [Webhooks da Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks)

### Reducao de risco operacional

O bot usa pausas e indicador de digitacao antes de enviar mensagens. Por padrao, cada resposta espera entre 5 e 15 segundos antes do envio, alem dos limites de cadencia para evitar rajadas quando o trafego pago traz muitos leads ao mesmo tempo:

```bash
OUTBOUND_MIN_DELAY_MS=5000
OUTBOUND_MAX_DELAY_MS=15000
OUTBOUND_TYPING_CHARS_PER_SECOND=38
OUTBOUND_TYPING_MIN_MS=5000
OUTBOUND_TYPING_MAX_MS=15000
OUTBOUND_MAX_PER_MINUTE=12
OUTBOUND_MAX_PER_CONTACT_HOUR=8
OUTBOUND_MIN_GAP_PER_CONTACT_MS=10000
```

Use valores mais conservadores quando ligar campanha nova. O ideal e o bot responder apenas quem iniciou conversa pelo anuncio e manter uma cadencia baixa no inicio.

### Audios do WhatsApp

Com `GEMINI_API_KEY` configurada, o bot tambem transcreve audios privados recebidos no WhatsApp e usa a transcricao no mesmo fluxo de atendimento. Se a transcricao falhar, o bot pede para o cliente mandar em texto.

Configuracoes opcionais:

```bash
AUDIO_TRANSCRIPTION_ENABLED=true
AUDIO_MAX_BYTES=14680064
AUDIO_MAX_SECONDS=300
AUDIO_TRANSCRIPTION_MAX_CHARS=2800
AUDIO_TRANSCRIPTION_FAILURE_REPLY="Nao consegui ouvir esse audio com seguranca. Pode mandar em texto para eu continuar o atendimento?"
```

## Fluxo comercial

O bot atende de forma formal e direta para o produto Limpa Nome.

- Negativado/restrito: Serasa, SPC, Boa Vista, score afetado por restricao ou nome sujo. Classifica como `low_ticket` e roteia para a agenda Andre.
- Rating bancario baixo: a pessoa nao aparece negativada, mas nao consegue aprovar financiamento, casa, carro, limite ou linha de credito por rating ruim/baixo. Classifica como `high_ticket` e roteia para a agenda Wilson.
- Se a pessoa nao souber qual e o problema, o bot inicia como `low_ticket` para consulta inicial de negativado.
- Nos dois casos, a consulta e obrigatoria porque ela identifica exatamente qual problema esta impedindo o credito.
- Quem nao aceita pagar a consulta e classificado como curioso/descartado e nao vai para agenda.
- O bot nao promete limpeza garantida, prazo fechado, aprovacao de credito ou financiamento antes da consulta.
- Para marcar, o cliente precisa aceitar a consulta paga e informar data, horario e email do convite.
- Quando faltar data e horario, o bot consulta a agenda responsavel e oferece horarios livres antes de pedir uma sugestao aberta.
- Se o cliente nao tiver email, o bot pode marcar uma ligacao por telefone/WhatsApp no horario escolhido, sem criar Meet, deixando nome e telefone na descricao do evento da agenda correta.
- Se o cliente pedir para cancelar/desmarcar depois de agendado, o bot cancela o proximo agendamento futuro no Google Agenda e marca como `cancelled` no Supabase.

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
GOOGLE_CALENDAR_WORKDAY_START=09:00
GOOGLE_CALENDAR_WORKDAY_END=18:00
GOOGLE_CALENDAR_WORKDAYS=1,2,3,4,5
GOOGLE_CALENDAR_AVAILABILITY_LOOKAHEAD_DAYS=7
GOOGLE_CALENDAR_AVAILABILITY_MAX_SLOTS=4
GOOGLE_CALENDAR_AVAILABILITY_STEP_MINUTES=30
GOOGLE_CALENDAR_MIN_NOTICE_MINUTES=60
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

O Gemini classifica `negativado/restrito` como `low_ticket`, `rating bancario baixo` como `high_ticket` e quem nao aceita pagar a consulta como `curious`/descartado. Se vier `unknown`, o bot pergunta se o caso e negativacao ou dificuldade de aprovacao por rating bancario baixo antes de escolher a agenda.

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

Baileys e Venom nao sao APIs oficiais da Meta. Use com uma conta autorizada, mensagens consentidas e baixo volume. Para operacao comercial em producao, configure `WHATSAPP_PROVIDER=meta` e use a WhatsApp Business Platform oficial.
