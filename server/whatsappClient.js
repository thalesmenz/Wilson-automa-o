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
    'Ola, tudo bem? Sou o assistente do Wilson Sanches. Trabalhamos com Limpa Nome e analise de credito para identificar problemas de negativacao ou rating bancario baixo. Seu caso e nome negativado/restrito ou dificuldade de aprovacao em banco/financiamento?',
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
  high_ticket: 'rating bancario baixo',
  low_ticket: 'nome negativado',
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
const WEEKDAY_LABELS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

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

function getPhoneFromJid(jid) {
  const value = String(jid || '');
  if (!value.endsWith('@s.whatsapp.net')) {
    return null;
  }

  const digits = value.split('@')[0]?.replace(/\D/g, '') || '';
  return formatBrazilianPhoneWithCountryCode(digits);
}

function formatBrazilianPhoneWithCountryCode(digits) {
  const cleanDigits = String(digits || '').replace(/\D/g, '');
  if (/^55\d{10,11}$/.test(cleanDigits)) {
    return `+${cleanDigits}`;
  }

  return null;
}

function formatBrazilianPhone(digits) {
  const cleanDigits = String(digits || '').replace(/\D/g, '');
  const withCountryCode = formatBrazilianPhoneWithCountryCode(cleanDigits);
  if (withCountryCode) {
    return withCountryCode;
  }

  if (/^\d{10,11}$/.test(cleanDigits)) {
    return `+55${cleanDigits}`;
  }

  return null;
}

function formatInternationalPhone(digits) {
  const cleanDigits = String(digits || '').replace(/\D/g, '');
  return cleanDigits.length >= 10 && cleanDigits.length <= 15 ? `+${cleanDigits}` : null;
}

function extractPhoneFromText(text) {
  const matches = String(text || '').match(/\+?\d[\d\s().-]{8,}\d/g) || [];
  const phone = matches
    .map((match) => match.replace(/\D/g, ''))
    .map((digits) => formatBrazilianPhone(digits) || formatInternationalPhone(digits))
    .find(Boolean);

  return phone || null;
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

function wantsPhoneCall(text) {
  const normalized = normalizeText(text);
  return (
    /\b(sem email|nao tenho email|nao tenho e-mail|nao uso email|nao uso e-mail|to sem email|estou sem email)\b/.test(
      normalized,
    ) ||
    /\b(por telefone|por ligacao|ligacao|me liga|pode ligar|whatsapp|zap)\b/.test(normalized)
  );
}

function getPhoneCallPreference(text, jid) {
  const explicitPhone = extractPhoneFromText(text);
  if (!wantsPhoneCall(text) && !explicitPhone) {
    return {};
  }

  const jidPhone = explicitPhone ? null : getPhoneFromJid(jid);
  return {
    contactPhone: explicitPhone || jidPhone || undefined,
    contactPhoneSource: explicitPhone ? 'message' : jidPhone ? 'jid' : undefined,
    meetingChannel: 'phone',
    phoneCallAccepted: true,
  };
}

function isUnsureAboutProblem(text) {
  const normalized = normalizeText(text);
  return (
    /\b(nao sei|n sei|nao faco ideia|sem ideia|tenho duvida|nao tenho certeza)\b/.test(normalized) ||
    /\b(nao sei se estou negativado|nao sei se meu nome esta sujo|nao sei meu caso)\b/.test(normalized) ||
    /\b(so sei que nao aprova|so sei que nao consigo aprovar|nao aprova nada)\b/.test(normalized)
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
    phoneCallAccepted: current.phoneCallAccepted === true || next?.phoneCallAccepted === true,
    qualificationQuestion: next?.qualificationQuestion || next?.question || current.qualificationQuestion,
    title: next?.title || current.title || 'Consulta Limpa Nome Wilson Sanches',
  });
}

function isPhoneCallSchedule(data) {
  return Boolean(data?.phoneCallAccepted || data?.meetingChannel === 'phone' || data?.scheduleMode === 'phone');
}

function normalizeSchedulePhone(data = {}, { jid, text } = {}) {
  if (!isPhoneCallSchedule(data)) {
    return data;
  }

  const explicitPhone = extractPhoneFromText(text);
  const jidPhone = getPhoneFromJid(jid);
  const trustedCurrentPhone =
    data.contactPhoneSource === 'message' || data.contactPhoneSource === 'jid'
      ? formatBrazilianPhone(data.contactPhone) || formatInternationalPhone(data.contactPhone)
      : null;
  const contactPhone = explicitPhone || trustedCurrentPhone || jidPhone || null;
  const contactPhoneSource = explicitPhone ? 'message' : trustedCurrentPhone ? data.contactPhoneSource : jidPhone ? 'jid' : undefined;

  return compactObject({
    ...data,
    contactPhone,
    contactPhoneSource,
  });
}

function getScheduleMissing(data) {
  const missing = [];
  if (!data?.startDateTime) {
    missing.push('data e horario');
  }

  if (isPhoneCallSchedule(data)) {
    if (!data?.contactPhone) {
      missing.push('telefone para ligacao');
    }
  } else if (!data?.attendeeEmail) {
    missing.push('email ou confirmacao de ligacao por telefone');
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

function getSlotParts(value) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone: GOOGLE_CALENDAR_TIME_ZONE,
    weekday: 'long',
  }).formatToParts(new Date(value));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    day: lookup.day,
    hour: lookup.hour,
    minute: lookup.minute,
    month: lookup.month,
    weekday: normalizeText(lookup.weekday),
  };
}

function formatAvailableSlot(slot) {
  const parts = getSlotParts(slot.startDateTime);
  const weekday = WEEKDAY_LABELS.find((label) => normalizeText(label) === parts.weekday) || parts.weekday;
  return `${weekday}, ${parts.day}/${parts.month} as ${parts.hour}:${parts.minute}`;
}

function buildMissingScheduleMessage(missing) {
  if (missing.includes('telefone para ligacao')) {
    const withoutPhone = missing.filter((item) => item !== 'telefone para ligacao');
    if (withoutPhone.length) {
      return `Perfeito. Me confirme o telefone com DDD para a ligacao e me envie ${formatPtList(withoutPhone)}.`;
    }

    return 'Perfeito. Me confirme o telefone com DDD para a ligacao.';
  }

  if (missing.includes('email ou confirmacao de ligacao por telefone')) {
    const withoutContact = missing.filter((item) => item !== 'email ou confirmacao de ligacao por telefone');
    const schedulePart = withoutContact.length ? `, alem de ${formatPtList(withoutContact)}` : '';
    return `Perfeito. Para seguir, me envie um email para o convite ou confirme que prefere ligacao por telefone${schedulePart}.`;
  }

  return `Perfeito. Para seguir, me envie ${formatPtList(missing)} para eu criar o convite no Google Agenda.`;
}

function buildAvailableSlotsMessage(slots, missing) {
  if (!slots.length) {
    return buildMissingScheduleMessage(missing);
  }

  const options = slots.map((slot, index) => `${index + 1}) ${formatAvailableSlot(slot)}`).join('\n');
  const needsContact = missing.includes('email ou confirmacao de ligacao por telefone');
  const needsPhone = missing.includes('telefone para ligacao');
  const emailLine = needsContact
    ? 'Me diga qual opcao prefere e envie seu email. Se nao tiver email, marco uma ligacao pelo telefone deste WhatsApp.'
    : needsPhone
      ? 'Me diga qual opcao prefere e confirme o telefone com DDD para a ligacao.'
    : 'Me diga qual opcao prefere.';
  return `Tenho estes horarios disponiveis:\n${options}\n${emailLine}`;
}

function findSelectedAvailableSlot(text, slots = []) {
  if (!slots.length) {
    return null;
  }

  const normalized = normalizeText(text);
  const selectedIndex =
    [
      /\b(?:opcao\s*)?1\b/,
      /\b(?:opcao\s*)?2\b/,
      /\b(?:opcao\s*)?3\b/,
      /\b(?:opcao\s*)?4\b/,
      /\b(?:opcao\s*)?5\b/,
    ].findIndex((pattern) => pattern.test(normalized));

  if (selectedIndex >= 0 && slots[selectedIndex]) {
    return slots[selectedIndex];
  }

  const wordMap = [
    ['primeiro', 'primeira'],
    ['segundo'],
    ['terceiro'],
    ['quarto'],
    ['quinto'],
  ];
  const wordIndex = wordMap.findIndex((words) => words.some((word) => normalized.includes(word)));

  return wordIndex >= 0 ? slots[wordIndex] || null : null;
}

function buildQualificationMessage(data) {
  return (
    data.qualificationQuestion ||
    'Para eu te orientar corretamente, seu caso e nome negativado/restrito ou dificuldade de aprovacao por rating bancario baixo?'
  );
}

function buildAnalysisOfferMessage(data) {
  const leadType = normalizeLeadType(data.leadType);

  if (leadType === 'high_ticket') {
    return 'Perfeito. Para rating bancario baixo, fazemos uma consulta completa para identificar por que o banco nao aprova financiamento, limite ou credito. O valor da consulta e R$250. Posso seguir com a consulta?';
  }

  if (leadType === 'low_ticket') {
    return 'Perfeito. Para nome negativado, fazemos uma consulta completa para identificar restricoes em Serasa, SPC, Boa Vista, score e apontamentos que afetam seu credito. O valor da consulta e R$150. Posso seguir?';
  }

  return buildQualificationMessage(data);
}

function buildUnknownProblemOfferMessage() {
  return 'Sem problema. A consulta serve exatamente para identificar se existe negativacao em Serasa/SPC/Boa Vista ou se o problema e rating bancario baixo. Vamos iniciar pela consulta de negativado, no valor de R$150. Posso seguir?';
}

function buildPaymentRefusalMessage() {
  return 'Sem problema. Nesse caso, nao conseguimos avancar com a consulta agora. Caso queira seguir depois, e so chamar.';
}

function buildConfirmationMessage(data) {
  const when = formatMeetingDate(data.startDateTime);
  const duration = Number(data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES);
  const leadType = LEAD_TYPE_LABELS[normalizeLeadType(data.leadType)];
  if (isPhoneCallSchedule(data)) {
    return `Perfeito. Posso marcar a ligacao de ${leadType} para ${when}, com duracao de ${duration} minutos, pelo telefone ${data.contactPhone}? Responda "sim" para confirmar.`;
  }

  return `Perfeito. Posso marcar a consulta de ${leadType} para ${when}, com duracao de ${duration} minutos, e enviar o convite para ${data.attendeeEmail}? Responda "sim" para confirmar.`;
}

function buildCalendarTitle(data, contactName) {
  const leadType = LEAD_TYPE_LABELS[normalizeLeadType(data.leadType)];
  const name = contactName || data.attendeeName || 'Cliente';
  return isPhoneCallSchedule(data) ? `Ligacao consulta ${leadType} - ${name}` : data.title || `Consulta ${leadType}`;
}

function buildCalendarDescription({ contactName, data = {}, jid, leadType, notes }) {
  return [
    'Consulta marcada automaticamente pelo WhatsApp Bot Wilson Sanches.',
    `Contato: ${contactName || jid}`,
    isPhoneCallSchedule(data) ? 'Formato: Ligacao por telefone/WhatsApp.' : 'Formato: Google Meet/convite por email.',
    data.contactPhone ? `Telefone: ${data.contactPhone}` : null,
    data.attendeeEmail ? `Email: ${data.attendeeEmail}` : null,
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

  async createMissingDetailsReply({ data, jid, missing }) {
    let nextData = data;
    let response = buildMissingScheduleMessage(missing);

    if (missing.includes('data e horario') && this.calendar?.isReady) {
      try {
        const availableSlots = await this.calendar.listAvailableSlots({
          durationMinutes: data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES,
          leadType: data.leadType,
        });

        if (availableSlots.length) {
          nextData = {
            ...data,
            availableSlots,
          };
          response = buildAvailableSlotsMessage(availableSlots, missing);
        } else {
          response =
            'Nao encontrei horarios livres nos proximos dias. Me envie uma sugestao de data e horario para eu verificar.';
        }
      } catch (error) {
        this.emitActivity('error', 'Falha ao buscar horarios disponiveis.', { error: error.message, jid });
      }
    }

    this.scheduling.set(jid, {
      data: nextData,
      status: 'awaiting_details',
      updatedAt: new Date().toISOString(),
    });

    return {
      ...this.defaultReply,
      name: 'Agenda',
      response,
    };
  }

  async createSchedulingReply({ contactName, isGroup, jid, text }) {
    if (isGroup) {
      return null;
    }

    let current = this.scheduling.get(jid);
    const phoneCallPreference = getPhoneCallPreference(text, jid);
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
            title: 'Consulta Limpa Nome Wilson Sanches',
          },
          status: 'awaiting_details',
          updatedAt: savedLead.updatedAt || new Date().toISOString(),
        };
      }
    }

    if (current?.status === 'awaiting_details') {
      const selectedSlot = findSelectedAvailableSlot(text, current.data?.availableSlots);
      if (selectedSlot || phoneCallPreference.phoneCallAccepted) {
        current = {
          ...current,
          data: normalizeSchedulePhone(
            {
              ...current.data,
              ...phoneCallPreference,
              startDateTime: selectedSlot?.startDateTime || current.data.startDateTime,
            },
            { jid, text },
          ),
          updatedAt: new Date().toISOString(),
        };
        this.scheduling.set(jid, current);
      }
    }

    if (!current && isAppointmentCancellation(text)) {
      return this.cancelScheduledMeeting({ contactName, jid });
    }

    if ((!current || current.status === 'awaiting_qualification') && isUnsureAboutProblem(text)) {
      const data = mergeScheduleData(current?.data, {
        analysisAccepted: false,
        leadConfidence: 0.7,
        leadType: 'low_ticket',
        notes: 'Cliente nao sabe se o problema e negativacao ou rating bancario baixo; iniciar pela consulta de negativado.',
        paymentAmount: ANALYSIS_FEES.low_ticket,
      });

      this.scheduling.set(jid, {
        data,
        status: 'awaiting_payment_confirmation',
        updatedAt: new Date().toISOString(),
      });

      return {
        ...this.defaultReply,
        name: 'Qualificacao',
        response: buildUnknownProblemOfferMessage(),
      };
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
          reason: 'Cliente nao aceitou pagar a consulta.',
          status: 'discarded',
        });

        return {
          ...this.defaultReply,
          name: 'Qualificacao',
          response: buildPaymentRefusalMessage(),
        };
      }

      if (isConfirmation(text)) {
        const data = normalizeSchedulePhone(mergeScheduleData(current.data, { analysisAccepted: true }), { jid, text });
        const leadType = normalizeLeadType(data.leadType);

        await this.recordLeadStatus({
          contactName,
          jid,
          leadType,
          reason: `Cliente aceitou a consulta de ${LEAD_TYPE_LABELS[leadType]}.`,
          status: leadType,
        });

        if (!this.calendar?.isReady) {
          return {
            ...this.defaultReply,
            name: 'Agenda',
            response:
              'A consulta foi confirmada, mas o Google Agenda ainda nao esta configurado no sistema. Vou encaminhar para um atendente finalizar.',
          };
        }

        const missing = getScheduleMissing(data);
        if (missing.length) {
          return this.createMissingDetailsReply({ data, jid, missing });
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

    const data = normalizeSchedulePhone(
      mergeScheduleData(current?.data, {
        ...analysis,
        ...phoneCallPreference,
      }),
      { jid, text },
    );
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
      return this.createMissingDetailsReply({ data, jid, missing });
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
        response: 'Pronto, desmarquei sua consulta na agenda. Se quiser remarcar outro horario, e so me mandar.',
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

    const data = normalizeSchedulePhone(current.data, { jid });
    const missing = getScheduleMissing(data);
    if (missing.length) {
      return this.createMissingDetailsReply({ data, jid, missing });
    }

    const phoneCall = isPhoneCallSchedule(data);
    try {
      const event = await this.calendar.createMeeting({
        attendeeEmail: data.attendeeEmail,
        attendeeName: data.attendeeName || contactName,
        createMeet: !phoneCall,
        description: buildCalendarDescription({
          contactName,
          data,
          jid,
          leadType: data.leadType,
          notes: data.notes,
        }),
        durationMinutes: data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES,
        leadType: data.leadType,
        startDateTime: data.startDateTime,
        title: buildCalendarTitle(data, contactName),
      });

      this.scheduling.delete(jid);
      await this.recordLeadStatus({
        calendarId: event.calendarId,
        contactName,
        eventId: event.eventId,
        jid,
        leadType: data.leadType,
        meetingAt: event.startDateTime,
        status: 'meeting_created',
      });
      this.emitActivity('calendar', 'Reuniao criada no Google Agenda.', {
        calendarId: event.calendarId,
        eventId: event.eventId,
        leadType: event.leadType,
      });
      await this.saveAppointment({
        attendeeEmail: data.attendeeEmail,
        calendarId: event.calendarId,
        calendarLink: event.calendarLink,
        contactName,
        eventId: event.eventId,
        jid,
        leadType: data.leadType,
        meetLink: event.meetLink,
        startDateTime: event.startDateTime,
        title: event.title,
      });

      const meetingDate = formatMeetingDate(event.startDateTime);
      const meetLine = event.meetLink ? `\nLink do Meet: ${event.meetLink}` : '';
      const calendarLine = event.calendarLink ? `\nConvite: ${event.calendarLink}` : '';

      if (phoneCall) {
        return {
          ...this.defaultReply,
          name: 'Google Agenda',
          response: `Ligacao marcada para ${meetingDate}. O especialista responsavel vai chamar pelo telefone/WhatsApp ${data.contactPhone}.`,
        };
      }

      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response: `Consulta marcada para ${meetingDate}. Encaminhei para a agenda do especialista responsavel e enviei o convite para ${data.attendeeEmail}.${meetLine}${calendarLine}`,
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
