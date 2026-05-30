import 'dotenv/config';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { AppointmentStore } from './appointmentStore.js';
import { AutomationStore } from './storage.js';
import { GeminiClient } from './geminiClient.js';
import { GoogleCalendarClient } from './googleCalendarClient.js';
import { ReminderWorker } from './reminderWorker.js';
import { SupabaseService } from './supabaseClient.js';
import { WhatsAppClient } from './whatsappClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const port = Number(process.env.PORT || 3001);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const settingsPath = process.env.APP_SETTINGS_PATH
  ? path.resolve(process.env.APP_SETTINGS_PATH)
  : path.join(__dirname, 'data', 'settings.json');
const whatsappSessionDir = process.env.WHATSAPP_SESSION_DIR
  ? path.resolve(process.env.WHATSAPP_SESSION_DIR)
  : path.join(__dirname, 'sessions', 'baileys');

async function readSettings() {
  try {
    return JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

async function writeSettings(settings) {
  await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  return settings;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: clientOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
});

const supabase = new SupabaseService();
const store = new AutomationStore({ dataDir: path.join(__dirname, 'data'), supabase });
await store.ready;
const settings = await readSettings();

const appointmentStore = new AppointmentStore({
  enabled: settings.followupsEnabled ?? process.env.FOLLOWUP_ENABLED !== 'false',
  supabase,
});
const calendar = new GoogleCalendarClient();
const gemini = new GeminiClient();
const whatsapp = new WhatsAppClient({
  appointmentStore,
  authDir: whatsappSessionDir,
  calendar,
  gemini,
  store,
});
const reminderWorker = new ReminderWorker({ appointmentStore, whatsapp });
whatsapp.reminderWorker = reminderWorker;
reminderWorker.start();

const activity = [];

function addActivity(item) {
  activity.unshift(item);
  activity.splice(80);
  io.emit('activity', item);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function broadcastAutomations() {
  io.emit('automations', store.getAutomations());
}

function broadcastConversations() {
  io.emit('conversations', store.getConversations());
}

whatsapp.on('state', (state) => io.emit('status', state));
whatsapp.on('qr', (payload) => io.emit('qr', payload));
whatsapp.on('message', () => broadcastConversations());
whatsapp.on('automation:reply', () => broadcastConversations());
whatsapp.on('activity', addActivity);

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'whatsapp-automation' });
});

app.get('/api/status', (_req, res) => {
  res.json(whatsapp.getState());
});

app.get('/api/google/auth-url', (req, res) => {
  try {
    res.json(calendar.createAuthUrl({ leadType: req.query?.leadType }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/google/callback', async (req, res) => {
  try {
    const result = await calendar.exchangeOAuthCode({
      code: req.query?.code,
      state: req.query?.state,
    });

    io.emit('status', whatsapp.getState());

    res.type('html').send(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Agenda conectado</title>
    <style>
      body { background: #f5f7f9; color: #17211d; font-family: Inter, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { background: #fff; border: 1px solid #e1e7ea; border-radius: 8px; box-shadow: 0 16px 42px rgba(23, 33, 29, .08); max-width: 520px; padding: 28px; }
      h1 { font-size: 26px; line-height: 1.1; margin: 0 0 10px; }
      p { color: #53636b; font-size: 15px; margin: 0 0 16px; }
      a { align-items: center; background: #13826a; border-radius: 8px; color: #fff; display: inline-flex; font-weight: 800; min-height: 44px; padding: 0 16px; text-decoration: none; }
      code { background: #edf4ff; border-radius: 6px; color: #1f5caa; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Google Agenda conectado</h1>
      <p>A conexao OAuth foi salva localmente para <code>${escapeHtml(result.leadType)}</code>. Volte para a dashboard e atualize o status.</p>
      <a href="${clientOrigin}">Voltar para dashboard</a>
    </main>
  </body>
</html>`);
  } catch (error) {
    res.status(400).type('html').send(`<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Erro no Google Agenda</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 32px;">
    <h1>Erro ao conectar Google Agenda</h1>
    <p>${escapeHtml(error.message)}</p>
    <a href="${clientOrigin}">Voltar</a>
  </body>
</html>`);
  }
});

app.post('/api/whatsapp/connect', async (_req, res) => {
  try {
    const state = await whatsapp.connect();
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const state = await whatsapp.disconnect({ clearSession: Boolean(req.body?.clearSession) });
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages/send', async (req, res) => {
  try {
    const result = await whatsapp.sendText(req.body?.phone, req.body?.text);
    broadcastConversations();
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/automations', (_req, res) => {
  res.json(store.getAutomations());
});

app.post('/api/automations', async (req, res) => {
  const automation = await store.createAutomation(req.body || {});
  broadcastAutomations();
  res.status(201).json(automation);
});

app.put('/api/automations/:id', async (req, res) => {
  const automation = await store.updateAutomation(req.params.id, req.body || {});
  if (!automation) {
    res.status(404).json({ error: 'Automacao nao encontrada.' });
    return;
  }

  broadcastAutomations();
  res.json(automation);
});

app.delete('/api/automations/:id', async (req, res) => {
  const deleted = await store.deleteAutomation(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Automacao nao encontrada.' });
    return;
  }

  broadcastAutomations();
  res.status(204).end();
});

app.get('/api/conversations', (_req, res) => {
  res.json(store.getConversations());
});

app.get('/api/dashboard/summary', (_req, res) => {
  res.json(store.getDashboardSummary());
});

app.get('/api/leads', (_req, res) => {
  res.json(store.getLeads());
});

app.get('/api/events', (req, res) => {
  res.json(
    store.getEvents({
      limit: req.query?.limit || 250,
      type: req.query?.type,
    }),
  );
});

app.get('/api/followups', async (_req, res) => {
  try {
    const upcoming = await appointmentStore.listUpcomingAppointments();
    const recent = store
      .getEvents({ limit: 80 })
      .filter((event) => event.type === 'followup_sent' || event.type === 'followup_failed');

    res.json({ recent, upcoming });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/followups/toggle', async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const followups = reminderWorker.setEnabled(enabled);
  settings.followupsEnabled = enabled;
  await writeSettings(settings);
  const state = whatsapp.getState();

  io.emit('status', state);
  addActivity({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: 'followup',
    message: enabled ? 'Follow-ups ativados.' : 'Follow-ups desativados.',
    meta: { followups },
    createdAt: new Date().toISOString(),
  });

  res.json(state);
});

app.get('/api/connections', (_req, res) => {
  res.json(whatsapp.getState());
});

io.on('connection', (socket) => {
  socket.emit('status', whatsapp.getState());
  socket.emit('automations', store.getAutomations());
  socket.emit('conversations', store.getConversations());
  socket.emit('activity:init', activity);
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(rootDir, 'dist')));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(rootDir, 'dist', 'index.html'));
  });
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Porta ${port} ja esta em uso. Encerre o processo antigo ou altere PORT no .env.`);
    process.exit(1);
  }

  throw error;
});

async function shutdown() {
  reminderWorker.stop();
  await whatsapp.disconnect({ clearSession: false }).catch(() => null);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 1500).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

server.listen(port, () => {
  console.log(`API em http://localhost:${port}`);
  console.log(`Front em ${clientOrigin}`);
});
