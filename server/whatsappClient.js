import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import P from 'pino';
import QRCode from 'qrcode';

const logger = P({ level: process.env.LOG_LEVEL || 'silent' });
const RESPOND_TO_GROUPS = process.env.WHATSAPP_RESPOND_TO_GROUPS === 'true';
const configuredDebounceMs = Number(process.env.AUTO_REPLY_DEBOUNCE_MS || 20000);
const AUTO_REPLY_DEBOUNCE_MS = Number.isFinite(configuredDebounceMs) ? configuredDebounceMs : 20000;

const DEFAULT_AUTO_REPLY = {
  id: 'default-auto-reply',
  name: 'Resposta automatica',
  response:
    process.env.AUTO_REPLY_TEXT ||
    'Ola. Somos especialistas em reintegracao de credito para CPF e CNPJ. Me confirme se o seu caso e CPF ou CNPJ para eu te orientar.',
  active: process.env.AUTO_REPLY_ENABLED !== 'false',
  delayMs: Number(process.env.AUTO_REPLY_DELAY_MS || 800),
  cooldownSeconds: Number(process.env.AUTO_REPLY_COOLDOWN_SECONDS || 300),
  includeGroups: RESPOND_TO_GROUPS,
};

const DEFAULT_MEETING_DURATION_MINUTES = Number(process.env.GOOGLE_CALENDAR_EVENT_DURATION_MINUTES || 30);
const GOOGLE_CALENDAR_TIME_ZONE = process.env.GOOGLE_CALENDAR_TIME_ZONE || 'America/Sao_Paulo';
const ANALYSIS_FEES = {
  high_ticket: 250,
  low_ticket: 150,
};
const LEAD_TYPE_LABELS = {
  high_ticket: 'CNPJ',
  low_ticket: 'CPF',
  unknown: 'nao qualificado',
};

const LEAD_ROUTES = {
  cancelled: 'Cancelado',
  discarded: 'Descartado',
  high_ticket: 'Wilson',
  low_ticket: 'Andre',
  meeting_created: 'Agenda',
  new: 'Aguardando',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) {
    throw new Error('Informe um telefone com DDI e DDD.');
  }

  return `${digits}@s.whatsapp.net`;
}

function getMessageText(message) {
  const payload = message?.message;
  if (!payload) {
    return '';
  }

  const unwrapped =
    payload.ephemeralMessage?.message ||
    payload.viewOnceMessage?.message ||
    payload.viewOnceMessageV2?.message ||
    payload;

  return (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    unwrapped.documentMessage?.caption ||
    unwrapped.buttonsResponseMessage?.selectedDisplayText ||
    unwrapped.listResponseMessage?.title ||
    ''
  );
}

function getDisconnectCode(lastDisconnect) {
  return (
    lastDisconnect?.error?.output?.statusCode ||
    lastDisconnect?.error?.statusCode ||
    lastDisconnect?.error?.data?.statusCode ||
    null
  );
}

function getUserFriendlyDisconnectMessage(code, fallback) {
  if (code === DisconnectReason.timedOut) {
    return 'QR Code expirou. Gere outro QR Code.';
  }

  if (code === DisconnectReason.loggedOut) {
    return 'Sessao encerrada. Gere um novo QR Code.';
  }

  return fallback || 'Conexao encerrada.';
}

function isCalendarMissingError(error) {
  const status = Number(error?.code || error?.response?.status || error?.status);
  return status === 404 || status === 410;
}

function isConfirmation(text) {
  return /^(sim|s|pode|pode sim|pode seguir|aceito|aceito sim|confirmo|confirmado|ok|fechado|manda|marcar)$/i.test(
    normalizeText(text),
  );
}

function isCancellation(text) {
  return /^(nao|n|nao quero|nao quero pagar|nao vou pagar|sem pagar|gratis|gratuito|caro|cancela|cancelar|deixa|deixa pra la)$/i.test(
    normalizeText(text),
  );
}

function isAppointmentCancellation(text) {
  const normalized = normalizeText(text);
  return (
    /\b(cancelar|cancela|cancele|cancelamento|desmarcar|desmarca|desmarque)\b/.test(normalized) ||
    /\bnao (vou|consigo|posso) (ir|comparecer|participar)\b/.test(normalized) ||
    /\bnao vai dar\b/.test(normalized)
  );
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function normalizeLeadType(value) {
  return value === 'high_ticket' || value === 'low_ticket' ? value : 'unknown';
}

function normalizeAcceptance(value) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = normalizeText(value);
  if (['true', 'sim', 's', 'aceito', 'aceita', 'aceitou', 'pago', 'pagar', 'seguir', 'avancar'].includes(normalized)) {
    return true;
  }

  if (['false', 'nao', 'n', 'recusou', 'gratis', 'gratuito', 'sem pagar'].includes(normalized)) {
    return false;
  }

  return null;
}

function isDiscardedLead(value) {
  return value === 'curious' || value === 'discarded';
}

function getLeadEventType(status, leadType) {
  if (status === 'meeting_created') {
    return 'meeting_created';
  }

  if (status === 'cancelled') {
    return 'meeting_cancelled';
  }

  if (status === 'discarded') {
    return 'lead_discarded';
  }

  if (leadType === 'high_ticket') {
    return 'lead_high_ticket';
  }

  if (leadType === 'low_ticket') {
    return 'lead_low_ticket';
  }

  return null;
}

function mergeScheduleData(current = {}, next = {}) {
  const currentLeadType = normalizeLeadType(current.leadType);
  const nextLeadType = normalizeLeadType(next.leadType);
  const currentAccepted = normalizeAcceptance(current.analysisAccepted);
  const nextAccepted = normalizeAcceptance(
    next?.analysisAccepted ?? next?.acceptedAnalysis ?? next?.paymentAccepted ?? next?.acceptedPayment,
  );
  const leadType = nextLeadType !== 'unknown' ? nextLeadType : currentLeadType;

  return compactObject({
    ...current,
    ...Object.fromEntries(Object.entries(next || {}).filter(([, value]) => value !== undefined && value !== null && value !== '')),
    analysisAccepted: currentAccepted === true || nextAccepted === true ? true : nextAccepted === false ? false : Boolean(currentAccepted),
    durationMinutes: Number(next?.durationMinutes || current.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES),
    leadConfidence: Number(next?.leadConfidence ?? current.leadConfidence ?? 0),
    leadType,
    paymentAmount: ANALYSIS_FEES[leadType] || Number(next?.paymentAmount || current.paymentAmount || 0) || null,
    qualificationQuestion: next?.qualificationQuestion || next?.question || current.qualificationQuestion,
    title: next?.title || current.title || 'Analise de credito Wilson Sanches',
  });
}

function getScheduleMissing(data) {
  const missing = [];
  if (!data?.startDateTime) {
    missing.push('data e horario');
  }
  if (!data?.attendeeEmail) {
    missing.push('email');
  }
  return missing;
}

function hasScheduleDetails(text) {
  const normalized = normalizeText(text);
  return (
    /[^\s@]+@[^\s@]+\.[^\s@]+/.test(String(text || '')) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(normalized) ||
    /\b\d{1,2}(?::\d{2})?\s*h\b/.test(normalized) ||
    /\b\d{1,2}:\d{2}\b/.test(normalized)
  );
}

function formatPtList(items) {
  const cleanItems = items.filter(Boolean);
  if (cleanItems.length <= 1) {
    return cleanItems[0] || '';
  }

  return `${cleanItems.slice(0, -1).join(', ')} e ${cleanItems[cleanItems.length - 1]}`;
}

function formatMeetingDate(value) {
  if (!value) {
    return '';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: GOOGLE_CALENDAR_TIME_ZONE,
  }).format(new Date(value));
}

function buildMissingScheduleMessage(missing) {
  return `Perfeito. Para seguir, me envie ${formatPtList(missing)} para eu criar o convite no Google Agenda.`;
}

function buildQualificationMessage(data) {
  return (
    data.qualificationQuestion ||
    'Para eu te orientar corretamente, o seu caso e para CPF ou CNPJ?'
  );
}

function buildAnalysisOfferMessage(data) {
  const leadType = normalizeLeadType(data.leadType);

  if (leadType === 'high_ticket') {
    return 'Perfeito. Para CNPJ, fazemos uma analise completa da empresa nos sistemas de restricao e credito, incluindo apontamentos que podem afetar banco, financiamento, limite, capital de giro e rating empresarial. O valor da analise e R$250. Posso seguir com a analise da empresa?';
  }

  if (leadType === 'low_ticket') {
    return 'Perfeito. Para CPF, fazemos uma analise completa nos orgaos de restricao e credito, como Serasa, SPC, Boa Vista, Bacen, Cadin e outros apontamentos. O valor da analise e R$150. Posso seguir com a analise?';
  }

  return buildQualificationMessage(data);
}

function buildPaymentRefusalMessage() {
  return 'Sem problema. Nesse caso, nao conseguimos avancar com a analise agora. Caso queira seguir depois, e so chamar.';
}

function buildConfirmationMessage(data) {
  const when = formatMeetingDate(data.startDateTime);
  const duration = Number(data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES);
  const leadType = LEAD_TYPE_LABELS[normalizeLeadType(data.leadType)];
  return `Perfeito. Posso marcar a analise de ${leadType} para ${when}, com duracao de ${duration} minutos, e enviar o convite para ${data.attendeeEmail}? Responda "sim" para confirmar.`;
}

function buildCalendarDescription({ contactName, jid, leadType, notes }) {
  return [
    'Analise marcada automaticamente pelo WhatsApp Bot Wilson Sanches.',
    `Contato: ${contactName || jid}`,
    `WhatsApp JID: ${jid}`,
    `Tipo de atendimento: ${LEAD_TYPE_LABELS[normalizeLeadType(leadType)]}`,
    notes ? `Observacoes: ${notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export class WhatsAppClient extends EventEmitter {
  constructor({ appointmentStore, authDir, calendar, gemini, store }) {
    super();
    this.appointmentStore = appointmentStore;
    this.authDir = authDir;
    this.calendar = calendar;
    this.gemini = gemini;
    this.store = store;
    this.sock = null;
    this.status = 'idle';
    this.qr = null;
    this.qrDataUrl = null;
    this.lastError = null;
    this.startedAt = null;
    this.manualDisconnect = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.cooldowns = new Map();
    this.defaultReply = DEFAULT_AUTO_REPLY;
    this.pendingReplies = new Map();
    this.scheduling = new Map();
  }

  getState() {
    return {
      status: this.status,
      qr: this.qr,
      qrDataUrl: this.qrDataUrl,
      lastError: this.lastError,
      startedAt: this.startedAt,
      hasSocket: Boolean(this.sock),
      ai: this.gemini?.getStatus?.() || { enabled: false, model: null, provider: 'Gemini' },
      calendar: this.calendar?.getStatus?.() || { enabled: false, provider: 'Google Calendar' },
      persistence: this.appointmentStore?.getStatus?.() || { enabled: false, provider: 'Supabase' },
      followups: this.reminderWorker?.getStatus?.() || { enabled: false, provider: 'Supabase' },
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }

  emitActivity(type, message, meta = {}) {
    this.emit('activity', {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type,
      message,
      meta,
      createdAt: new Date().toISOString(),
    });
  }

  async recordEvent(type, payload = {}) {
    if (!this.store?.addEvent) {
      return null;
    }

    return this.store.addEvent({
      type,
      jid: payload.jid,
      contactName: payload.contactName,
      leadType: payload.leadType,
      leadStatus: payload.leadStatus,
      route: payload.route,
      meta: payload.meta,
    });
  }

  async recordLeadStatus({ contactName, jid, leadType, reason, status, ...meta }) {
    if (!this.store?.updateLead || !jid) {
      return null;
    }

    const normalizedLeadType = normalizeLeadType(leadType);
    const leadStatus = status || (normalizedLeadType === 'unknown' ? 'new' : normalizedLeadType);
    const route = LEAD_ROUTES[leadStatus] || LEAD_ROUTES[normalizedLeadType] || 'Aguardando';
    const result = await this.store.updateLead(jid, {
      ...meta,
      contactName,
      leadType: normalizedLeadType === 'unknown' ? null : normalizedLeadType,
      reason,
      route,
      status: leadStatus,
    });
    const eventType = result.changed ? getLeadEventType(leadStatus, normalizedLeadType) : null;

    if (eventType) {
      await this.recordEvent(eventType, {
        jid,
        contactName,
        leadType: normalizedLeadType,
        leadStatus,
        route,
        meta: {
          reason,
          ...meta,
        },
      });
    }

    return result;
  }

  async connect() {
    if (this.connecting || this.status === 'qr' || this.status === 'connected') {
      return this.getState();
    }

    this.connecting = true;
    this.manualDisconnect = false;
    this.status = 'connecting';
    this.lastError = null;
    this.emitState();
    this.emitActivity('connection', 'Conectando ao WhatsApp.');

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
      const sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS('Desktop'),
        version,
        logger,
        markOnlineOnConnect: false,
        printQRInTerminal: false,
      });

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
      sock.ev.on('messages.upsert', (event) => this.handleMessages(event));
    } catch (error) {
      this.lastError = error.message;
      this.status = 'error';
      this.emitActivity('error', 'Falha ao iniciar a conexao.', { error: error.message });
      this.emitState();
    } finally {
      this.connecting = false;
    }

    return this.getState();
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qr = qr;
      this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      this.status = 'qr';
      this.emit('qr', { qr, qrDataUrl: this.qrDataUrl });
      this.emitActivity('qr', 'QR Code atualizado.');
      this.emitState();
    }

    if (connection === 'open') {
      this.status = 'connected';
      this.qr = null;
      this.qrDataUrl = null;
      this.lastError = null;
      this.startedAt = new Date().toISOString();
      this.emitActivity('connection', 'WhatsApp conectado.');
      this.emitState();
    }

    if (connection === 'close') {
      const wasConnected = this.status === 'connected';
      const code = getDisconnectCode(lastDisconnect);
      const loggedOut = code === DisconnectReason.loggedOut;
      const restartRequired = code === DisconnectReason.restartRequired;
      const qrTimedOut = code === DisconnectReason.timedOut;
      const shouldReconnect = !this.manualDisconnect && !loggedOut && (wasConnected || restartRequired);
      const errorMessage = restartRequired
        ? 'WhatsApp pediu reinicio da conexao. Reconectando...'
        : getUserFriendlyDisconnectMessage(code, lastDisconnect?.error?.message);

      this.sock = null;
      this.qr = null;
      this.qrDataUrl = null;
      this.status = shouldReconnect
        ? 'connecting'
        : loggedOut
          ? 'logged_out'
          : this.manualDisconnect || qrTimedOut || wasConnected
            ? 'disconnected'
            : 'error';
      this.lastError = shouldReconnect || qrTimedOut ? null : errorMessage;
      this.emitActivity('connection', shouldReconnect ? 'Conexao caiu. Reconectando...' : errorMessage, {
        code,
      });
      this.emitState();

      if (shouldReconnect) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch((error) => {
            this.emitActivity('error', 'Falha na reconexao.', { error: error.message });
          });
        }, 2500);
      }
    }
  }

  async handleMessages(event) {
    if (!Array.isArray(event.messages)) {
      return;
    }

    for (const message of event.messages) {
      const jid = message.key?.remoteJid;
      if (!jid || jid === 'status@broadcast' || message.key?.fromMe) {
        continue;
      }

      const isGroup = jid.endsWith('@g.us');
      const text = getMessageText(message).trim();
      const contactName = message.pushName || jid.replace('@s.whatsapp.net', '');

      if (!text) {
        continue;
      }

      await this.store.addConversationMessage({
        jid,
        contactName,
        direction: 'in',
        text,
        id: message.key?.id,
      });

      const incoming = {
        jid,
        contactName,
        text,
        isGroup,
        createdAt: new Date().toISOString(),
      };

      this.emit('message', incoming);
      this.emitActivity('message', `Mensagem recebida de ${contactName}.`, { jid });

      if (isGroup && !RESPOND_TO_GROUPS) {
        this.emitActivity('message', 'Mensagem de grupo ignorada pela configuracao.', { jid });
        continue;
      }

      this.queueAutoReply({ contactName, isGroup, jid, message, text });
    }
  }

  queueAutoReply({ contactName, isGroup, jid, message, text }) {
    const current = this.pendingReplies.get(jid);
    if (current?.timer) {
      clearTimeout(current.timer);
    }

    const pending = {
      contactName,
      isGroup,
      messages: [
        ...(current?.messages || []),
        {
          contactName,
          isGroup,
          message,
          text,
        },
      ],
      processing: Boolean(current?.processing),
      timer: null,
    };

    if (!pending.processing) {
      pending.timer = setTimeout(() => {
        this.flushPendingReply(jid).catch((error) => {
          this.emitActivity('error', 'Falha ao processar mensagens agrupadas.', { error: error.message, jid });
        });
      }, Math.max(0, AUTO_REPLY_DEBOUNCE_MS));
    }

    this.pendingReplies.set(jid, pending);
  }

  async flushPendingReply(jid) {
    const pending = this.pendingReplies.get(jid);
    if (!pending || pending.processing || !pending.messages.length) {
      return;
    }

    const batch = pending.messages;
    const lastMessage = batch[batch.length - 1];

    this.pendingReplies.set(jid, {
      ...pending,
      messages: [],
      processing: true,
      timer: null,
    });

    try {
      const text = batch.map((item) => item.text).join('\n').trim();
      const automation = await this.createReply(text, lastMessage.isGroup, jid, lastMessage.contactName);

      if (automation) {
        await this.replyWithAutomation(jid, lastMessage.message, automation, lastMessage.contactName);
      }
    } finally {
      const latest = this.pendingReplies.get(jid);
      if (!latest) {
        return;
      }

      if (latest.messages.length) {
        latest.processing = false;
        latest.timer = setTimeout(() => {
          this.flushPendingReply(jid).catch((error) => {
            this.emitActivity('error', 'Falha ao processar mensagens agrupadas.', { error: error.message, jid });
          });
        }, Math.max(0, AUTO_REPLY_DEBOUNCE_MS));
        this.pendingReplies.set(jid, latest);
      } else {
        this.pendingReplies.delete(jid);
      }
    }
  }

  findMatchingAutomation(text, isGroup, jid) {
    const normalizedText = normalizeText(text);
    const automations = this.store.getAutomations();

    for (const automation of automations) {
      if (!automation.active || !automation.keyword || !automation.response) {
        continue;
      }

      if (isGroup && !automation.includeGroups) {
        continue;
      }

      const normalizedKeyword = normalizeText(automation.keyword);
      const matches =
        automation.matchMode === 'exact'
          ? normalizedText === normalizedKeyword
          : normalizedText.includes(normalizedKeyword);

      if (!matches) {
        continue;
      }

      const cooldownKey = `${jid}:${automation.id}`;
      const lastSentAt = this.cooldowns.get(cooldownKey) || 0;
      const cooldownMs = Number(automation.cooldownSeconds || 0) * 1000;

      if (cooldownMs > 0 && Date.now() - lastSentAt < cooldownMs) {
        return null;
      }

      this.cooldowns.set(cooldownKey, Date.now());
      return automation;
    }

    return null;
  }

  findDefaultReply(isGroup, jid) {
    if (!this.defaultReply.active || !this.defaultReply.response) {
      return null;
    }

    if (isGroup && !this.defaultReply.includeGroups) {
      return null;
    }

    const cooldownKey = `${jid}:${this.defaultReply.id}`;
    const lastSentAt = this.cooldowns.get(cooldownKey) || 0;
    const cooldownMs = Number(this.defaultReply.cooldownSeconds || 0) * 1000;

    if (cooldownMs > 0 && Date.now() - lastSentAt < cooldownMs) {
      return null;
    }

    this.cooldowns.set(cooldownKey, Date.now());
    return this.defaultReply;
  }

  async createReply(text, isGroup, jid, contactName) {
    if (!this.defaultReply.active || (isGroup && !this.defaultReply.includeGroups)) {
      return null;
    }

    const schedulingReply = await this.createSchedulingReply({ contactName, isGroup, jid, text });
    if (schedulingReply) {
      return schedulingReply;
    }

    const fallbackReply = this.findDefaultReply(isGroup, jid);
    if (!fallbackReply) {
      return null;
    }

    if (!this.gemini?.isReady) {
      return fallbackReply;
    }

    try {
      const response = await this.gemini.generateReply({ text, contactName });
      return {
        ...fallbackReply,
        name: 'IA',
        response,
      };
    } catch (error) {
      this.emitActivity('error', 'IA falhou. Usando resposta padrao.', { error: error.message });
      return fallbackReply;
    }
  }

  async createSchedulingReply({ contactName, isGroup, jid, text }) {
    if (isGroup) {
      return null;
    }

    let current = this.scheduling.get(jid);
    if (!current && hasScheduleDetails(text)) {
      const savedLead = this.store?.getConversation?.(jid)?.lead || {};
      const savedLeadType = normalizeLeadType(savedLead.leadType);

      if (savedLeadType !== 'unknown' && savedLead.status !== 'meeting_created') {
        current = {
          data: {
            analysisAccepted: true,
            durationMinutes: DEFAULT_MEETING_DURATION_MINUTES,
            leadType: savedLeadType,
            paymentAmount: ANALYSIS_FEES[savedLeadType],
            title: 'Analise de credito Wilson Sanches',
          },
          status: 'awaiting_details',
          updatedAt: savedLead.updatedAt || new Date().toISOString(),
        };
      }
    }

    if (!current && isAppointmentCancellation(text)) {
      return this.cancelScheduledMeeting({ contactName, jid });
    }

    if (current?.status === 'awaiting_confirmation') {
      if (isConfirmation(text)) {
        return this.confirmScheduledMeeting({ contactName, jid });
      }

      if (isCancellation(text)) {
        this.scheduling.delete(jid);
        return {
          ...this.defaultReply,
          name: 'Agenda',
          response: 'Combinado, nao marquei a reuniao. Se quiser outro horario, e so me mandar.',
        };
      }
    }

    if (current?.status === 'awaiting_payment_confirmation') {
      if (isCancellation(text)) {
        this.scheduling.delete(jid);
        await this.recordLeadStatus({
          contactName,
          jid,
          reason: 'Cliente nao aceitou pagar a analise.',
          status: 'discarded',
        });

        return {
          ...this.defaultReply,
          name: 'Qualificacao',
          response: buildPaymentRefusalMessage(),
        };
      }

      if (isConfirmation(text)) {
        const data = mergeScheduleData(current.data, { analysisAccepted: true });
        const leadType = normalizeLeadType(data.leadType);

        await this.recordLeadStatus({
          contactName,
          jid,
          leadType,
          reason: `Cliente aceitou a analise de ${LEAD_TYPE_LABELS[leadType]}.`,
          status: leadType,
        });

        if (!this.calendar?.isReady) {
          return {
            ...this.defaultReply,
            name: 'Agenda',
            response:
              'A analise foi confirmada, mas o Google Agenda ainda nao esta configurado no sistema. Vou encaminhar para um atendente finalizar.',
          };
        }

        const missing = getScheduleMissing(data);
        if (missing.length) {
          this.scheduling.set(jid, {
            data,
            status: 'awaiting_details',
            updatedAt: new Date().toISOString(),
          });

          return {
            ...this.defaultReply,
            name: 'Agenda',
            response: buildMissingScheduleMessage(missing),
          };
        }

        this.scheduling.set(jid, {
          data,
          status: 'awaiting_confirmation',
          updatedAt: new Date().toISOString(),
        });

        return {
          ...this.defaultReply,
          name: 'Agenda',
          response: buildConfirmationMessage(data),
        };
      }
    }

    if (!this.gemini?.isReady) {
      return null;
    }

    let analysis;
    try {
      analysis = await this.gemini.analyzeScheduling({
        contactName,
        existing: current?.data || {},
        nowIso: new Date().toISOString(),
        text,
        timeZone: GOOGLE_CALENDAR_TIME_ZONE,
      });
    } catch (error) {
      this.emitActivity('error', 'IA nao conseguiu analisar agenda.', { error: error.message });
      return null;
    }

    if (analysis.intent === 'cancel' && current) {
      this.scheduling.delete(jid);
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response: 'Tudo bem, cancelei esse agendamento por aqui.',
      };
    }

    if (analysis.intent === 'cancel' && !current && Number(analysis.confidence || 0) >= 0.65) {
      return this.cancelScheduledMeeting({ contactName, jid });
    }

    if (analysis.intent === 'confirm' && current?.status === 'awaiting_confirmation') {
      return this.confirmScheduledMeeting({ contactName, jid });
    }

    const shouldSchedule =
      current ||
      ((['schedule_meeting', 'qualify', 'discard'].includes(analysis.intent) || isDiscardedLead(analysis.leadType)) &&
        Number(analysis.confidence || 0) >= 0.55);

    if (!shouldSchedule) {
      return null;
    }

    const data = mergeScheduleData(current?.data, analysis);
    const rawLeadType = String(analysis.leadType || data.leadType || '').trim();

    if (analysis.intent === 'discard' || isDiscardedLead(rawLeadType)) {
      this.scheduling.delete(jid);
      await this.recordLeadStatus({
        contactName,
        jid,
        reason: data.notes || data.reason || text,
        status: 'discarded',
      });

      return {
        ...this.defaultReply,
        name: 'Qualificacao',
        response: buildPaymentRefusalMessage(),
      };
    }

    const leadType = normalizeLeadType(data.leadType);

    if (leadType !== 'unknown' && data.analysisAccepted) {
      await this.recordLeadStatus({
        contactName,
        jid,
        leadType,
        reason: data.notes,
        status: leadType,
      });
    }

    if (leadType === 'unknown') {
      this.scheduling.set(jid, {
        data,
        status: 'awaiting_qualification',
        updatedAt: new Date().toISOString(),
      });

      return {
        ...this.defaultReply,
        name: 'Qualificacao',
        response: buildQualificationMessage(data),
      };
    }

    if (!data.analysisAccepted) {
      this.scheduling.set(jid, {
        data,
        status: 'awaiting_payment_confirmation',
        updatedAt: new Date().toISOString(),
      });

      return {
        ...this.defaultReply,
        name: 'Qualificacao',
        response: buildAnalysisOfferMessage(data),
      };
    }

    if (!this.calendar?.isReady) {
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response:
          'Consigo marcar reunioes, mas o Google Agenda ainda nao esta configurado no sistema. Vou encaminhar para um atendente finalizar.',
      };
    }

    const missing = getScheduleMissing(data);

    if (missing.length) {
      this.scheduling.set(jid, {
        data,
        status: 'awaiting_details',
        updatedAt: new Date().toISOString(),
      });

      return {
        ...this.defaultReply,
        name: 'Agenda',
        response: buildMissingScheduleMessage(missing),
      };
    }

    this.scheduling.set(jid, {
      data,
      status: 'awaiting_confirmation',
      updatedAt: new Date().toISOString(),
    });

    return {
      ...this.defaultReply,
      name: 'Agenda',
      response: buildConfirmationMessage(data),
    };
  }

  async cancelScheduledMeeting({ contactName, jid }) {
    if (!this.appointmentStore?.isReady || !this.appointmentStore.findNextScheduledAppointmentByJid) {
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response:
          'Nao consegui consultar os agendamentos agora. Vou encaminhar para um atendente desmarcar manualmente.',
      };
    }

    let appointment;
    try {
      appointment = await this.appointmentStore.findNextScheduledAppointmentByJid(jid);
    } catch (error) {
      this.emitActivity('error', 'Falha ao buscar agendamento para cancelamento.', { error: error.message, jid });
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response:
          'Nao consegui consultar seu agendamento agora. Vou encaminhar para um atendente desmarcar manualmente.',
      };
    }

    if (!appointment) {
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response: 'Nao encontrei nenhum agendamento futuro para desmarcar nesse WhatsApp.',
      };
    }

    if (!this.calendar?.isReady) {
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response:
          'Encontrei seu agendamento, mas o Google Agenda nao esta conectado agora. Vou encaminhar para um atendente desmarcar manualmente.',
      };
    }

    try {
      try {
        await this.calendar.cancelMeeting({
          calendarId: appointment.calendarId,
          eventId: appointment.eventId,
          leadType: appointment.leadType,
        });
      } catch (error) {
        if (!isCalendarMissingError(error)) {
          throw error;
        }

        this.emitActivity('calendar', 'Evento ja nao existia no Google Agenda. Marcando como cancelado.', {
          calendarId: appointment.calendarId,
          eventId: appointment.eventId,
          jid,
        });
      }

      await this.appointmentStore.markCancelled(appointment.id);
      await this.recordLeadStatus({
        calendarId: appointment.calendarId,
        contactName,
        eventId: appointment.eventId,
        jid,
        leadType: appointment.leadType,
        meetingAt: appointment.startDateTime,
        reason: 'Cliente pediu para desmarcar pelo WhatsApp.',
        status: 'cancelled',
      });
      this.emitActivity('calendar', 'Reuniao cancelada no Google Agenda.', {
        calendarId: appointment.calendarId,
        eventId: appointment.eventId,
        jid,
      });

      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response: 'Pronto, desmarquei sua analise na agenda. Se quiser remarcar outro horario, e so me mandar.',
      };
    } catch (error) {
      this.emitActivity('error', 'Falha ao cancelar evento no Google Agenda.', { error: error.message, jid });
      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response:
          'Tentei desmarcar no Google Agenda, mas deu erro na integracao. Vou encaminhar para um atendente cancelar manualmente.',
      };
    }
  }

  async confirmScheduledMeeting({ contactName, jid }) {
    const current = this.scheduling.get(jid);
    if (!current?.data) {
      return null;
    }

    try {
      const event = await this.calendar.createMeeting({
        attendeeEmail: current.data.attendeeEmail,
        attendeeName: current.data.attendeeName || contactName,
        description: buildCalendarDescription({
          contactName,
          jid,
          leadType: current.data.leadType,
          notes: current.data.notes,
        }),
        durationMinutes: current.data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES,
        leadType: current.data.leadType,
        startDateTime: current.data.startDateTime,
        title: current.data.title || 'Analise de credito Wilson Sanches',
      });

      this.scheduling.delete(jid);
      await this.recordLeadStatus({
        calendarId: event.calendarId,
        contactName,
        eventId: event.eventId,
        jid,
        leadType: current.data.leadType,
        meetingAt: event.startDateTime,
        status: 'meeting_created',
      });
      this.emitActivity('calendar', 'Reuniao criada no Google Agenda.', {
        calendarId: event.calendarId,
        eventId: event.eventId,
        leadType: event.leadType,
      });
      await this.saveAppointment({
        attendeeEmail: current.data.attendeeEmail,
        calendarId: event.calendarId,
        calendarLink: event.calendarLink,
        contactName,
        eventId: event.eventId,
        jid,
        leadType: current.data.leadType,
        meetLink: event.meetLink,
        startDateTime: event.startDateTime,
        title: event.title,
      });

      const meetingDate = formatMeetingDate(event.startDateTime);
      const meetLine = event.meetLink ? `\nLink do Meet: ${event.meetLink}` : '';
      const calendarLine = event.calendarLink ? `\nConvite: ${event.calendarLink}` : '';

      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response: `Analise marcada para ${meetingDate}. Encaminhei para a agenda do especialista responsavel e enviei o convite para ${current.data.attendeeEmail}.${meetLine}${calendarLine}`,
      };
    } catch (error) {
      this.emitActivity('error', 'Falha ao criar evento no Google Agenda.', { error: error.message });

      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response:
          'Tentei marcar no Google Agenda, mas deu erro na integracao. Vou encaminhar para um atendente confirmar manualmente.',
      };
    }
  }

  async saveAppointment(appointment) {
    if (!this.appointmentStore?.isReady) {
      this.emitActivity('followup', 'Banco de follow-ups nao configurado. Follow-ups nao foram salvos.', {
        eventId: appointment.eventId,
      });
      return null;
    }

    try {
      const saved = await this.appointmentStore.saveAppointment(appointment);
      this.emitActivity('followup', 'Agendamento salvo para follow-up.', {
        appointmentId: saved?.id,
      });
      return saved;
    } catch (error) {
      this.emitActivity('error', 'Falha ao salvar agendamento para follow-up.', { error: error.message });
      return null;
    }
  }

  async replyWithAutomation(jid, quotedMessage, automation, contactName) {
    if (!this.sock) {
      return;
    }

    const delayMs = Math.max(0, Number(automation.delayMs || 0));
    if (delayMs) {
      await sleep(delayMs);
    }

    await this.sock.sendPresenceUpdate('composing', jid).catch(() => null);
    await sleep(Math.min(900, Math.max(300, delayMs)));
    await this.sock.sendMessage(jid, { text: automation.response }, { quoted: quotedMessage });
    await this.sock.sendPresenceUpdate('paused', jid).catch(() => null);

    const createdAt = new Date().toISOString();
    await this.store.addConversationMessage({
      jid,
      contactName,
      direction: 'out',
      text: automation.response,
      automationName: automation.name,
      createdAt,
    });

    this.emit('automation:reply', {
      jid,
      contactName,
      automationName: automation.name,
      text: automation.response,
      createdAt,
    });
    this.emitActivity('automation', `Resposta automatica enviada por "${automation.name}".`, { jid });
    await this.recordEvent('message_replied', {
      jid,
      contactName,
      meta: {
        automationName: automation.name,
      },
    });
  }

  async sendText(phone, text) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp ainda nao esta conectado.');
    }

    const jid = normalizePhone(phone);
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      throw new Error('Informe uma mensagem.');
    }

    await this.sock.sendMessage(jid, { text: cleanText });
    const createdAt = new Date().toISOString();
    await this.store.addConversationMessage({
      jid,
      contactName: phone,
      direction: 'out',
      text: cleanText,
      createdAt,
    });

    this.emit('message', {
      jid,
      contactName: phone,
      text: cleanText,
      direction: 'out',
      createdAt,
    });
    this.emitActivity('message', `Mensagem enviada para ${phone}.`, { jid });

    return { jid, text: cleanText, createdAt };
  }

  async sendTextToJid(jid, text, { automationName = null, contactName = jid } = {}) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp ainda nao esta conectado.');
    }

    const cleanText = String(text || '').trim();
    if (!jid || !cleanText) {
      throw new Error('Informe JID e mensagem.');
    }

    await this.sock.sendMessage(jid, { text: cleanText });
    const createdAt = new Date().toISOString();
    await this.store.addConversationMessage({
      jid,
      contactName,
      direction: 'out',
      text: cleanText,
      automationName,
      createdAt,
    });

    this.emit('message', {
      jid,
      contactName,
      text: cleanText,
      direction: 'out',
      createdAt,
    });

    return { jid, text: cleanText, createdAt };
  }

  async disconnect({ clearSession = false } = {}) {
    this.manualDisconnect = true;
    clearTimeout(this.reconnectTimer);

    if (this.sock) {
      if (clearSession) {
        await this.sock.logout().catch(() => null);
      } else {
        this.sock.end?.(undefined);
      }
    }

    this.sock = null;
    this.qr = null;
    this.qrDataUrl = null;
    this.status = 'disconnected';
    this.startedAt = null;

    if (clearSession) {
      await fs.rm(this.authDir, { recursive: true, force: true });
      this.emitActivity('connection', 'Sessao local removida.');
    }

    this.emitActivity('connection', 'WhatsApp desconectado manualmente.');
    this.emitState();
    return this.getState();
  }
}
