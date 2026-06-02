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
const DEFAULT_AUTO_REPLY_DEBOUNCE_MS = 2500;
const DEFAULT_AUTO_REPLY_DELAY_MS = 200;
const configuredDebounceMs = Number(process.env.AUTO_REPLY_DEBOUNCE_MS || DEFAULT_AUTO_REPLY_DEBOUNCE_MS);
const AUTO_REPLY_DEBOUNCE_MS = Number.isFinite(configuredDebounceMs) ? configuredDebounceMs : DEFAULT_AUTO_REPLY_DEBOUNCE_MS;

const DEFAULT_AUTO_REPLY = {
  id: 'default-auto-reply',
  name: 'Resposta automática',
  response:
    process.env.AUTO_REPLY_TEXT ||
    'Olá, sou assistente do Wilson Sanches da Cresce Mais. Para te direcionar melhor, esse atendimento é para CPF ou CNPJ?\n\n1. CPF\n2. CNPJ',
  active: process.env.AUTO_REPLY_ENABLED !== 'false',
  delayMs: Number(process.env.AUTO_REPLY_DELAY_MS || DEFAULT_AUTO_REPLY_DELAY_MS),
  cooldownSeconds: Number(process.env.AUTO_REPLY_COOLDOWN_SECONDS || 300),
  includeGroups: RESPOND_TO_GROUPS,
};
const MAX_AI_HISTORY_MESSAGES = 14;
const MAX_AI_HISTORY_TEXT_LENGTH = 500;

const DEFAULT_MEETING_DURATION_MINUTES = Number(process.env.GOOGLE_CALENDAR_EVENT_DURATION_MINUTES || 30);
const GOOGLE_CALENDAR_TIME_ZONE = process.env.GOOGLE_CALENDAR_TIME_ZONE || 'America/Sao_Paulo';
const ANALYSIS_FEES = {
  high_ticket: 250,
  low_ticket: 150,
};
const LEAD_TYPE_LABELS = {
  high_ticket: 'rating bancário baixo',
  low_ticket: 'nome negativado',
  unknown: 'não qualificado',
};

const LEAD_ROUTES = {
  cancelled: 'Cancelado',
  discarded: 'Descartado',
  high_ticket: 'Wilson',
  low_ticket: 'Andre',
  meeting_created: 'Agenda',
  new: 'Aguardando',
};
const WEEKDAY_LABELS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSessionBackupName(reason) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = normalizeText(reason)
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${timestamp}-${safeReason || 'backup'}`;
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

function extractEmailFromText(text) {
  return String(text || '').match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] || null;
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

function getMenuOption(text) {
  const normalized = normalizeText(text).replace(/\s+/g, ' ');
  if (!normalized) {
    return null;
  }

  const numericMatch = normalized.match(/^(?:opcao\s*)?([1-9])$/);
  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const wordOptions = [
    ['um', 'uma', 'primeiro', 'primeira'],
    ['dois', 'duas', 'segundo'],
    ['tres', 'terceiro', 'terceira'],
    ['quatro', 'quarto'],
    ['cinco', 'quinto'],
  ];

  const optionIndex = wordOptions.findIndex((words) => {
    const pattern = words.join('|');
    return new RegExp(
      `^(?:opcao\\s+|quero\\s+(?:a\\s+|o\\s+)?|escolho\\s+(?:a\\s+|o\\s+)?|pode ser\\s+(?:a\\s+|o\\s+)?)?(?:${pattern})$`,
    ).test(normalized);
  });

  return optionIndex >= 0 ? optionIndex + 1 : null;
}

function isSimpleGreeting(text) {
  const normalized = normalizeText(text).replace(/[.!?]+$/g, '').trim();
  return ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'menu', 'opcoes', 'opcao', 'atendimento', 'quero atendimento'].includes(
    normalized,
  );
}

function buildDocumentTypeMessage() {
  return 'Olá, sou assistente do Wilson Sanches da Cresce Mais. Para te direcionar melhor, esse atendimento é para CPF ou CNPJ?\n\n1. CPF\n2. CNPJ';
}

function buildSegmentMessage() {
  return 'Perfeito. Qual é a área de atuação do CNPJ?\n\n1. Agro\n2. Comércio ou serviços\n3. Indústria\n4. Outro segmento';
}

function isCpfDocumentTypeText(text) {
  const normalized = normalizeText(text);
  return /\b(cpf|pessoa fisica|pf|fisica|meu nome|meu cpf|no cpf|pelo cpf)\b/.test(normalized);
}

function isCnpjDocumentTypeText(text) {
  const normalized = normalizeText(text);
  return /\b(cnpj|pessoa juridica|pj|empresa|empresarial|mei|meu negocio|minha empresa|no cnpj|pelo cnpj)\b/.test(normalized);
}

function isAgroSegmentText(text) {
  const normalized = normalizeText(text);
  return /\b(agro|agronegocio|agricola|agricultura|produtor rural|produtora rural|rural|fazenda|fazendeiro|pecuaria|pecuarista|gado|boi|soja|milho|cafe|cana|plantio|lavoura|safra|graos|insumos)\b/.test(
    normalized,
  );
}

function isNonAgroSegmentText(text) {
  const normalized = normalizeText(text);
  return /\b(comercio|servicos|servico|industria|outro segmento|lojista|autonomo|autonoma)\b/.test(
    normalized,
  );
}

function isConfirmation(text) {
  return /^(sim|s|ss|pode|pode sim|pode ser|pode seguir|aceito|aceito sim|confirmo|confirmado|ok|okay|fechado|manda|manda ver|marcar|marca|agenda|agendar|vamos|bora|beleza|blz|ta bom|perfeito|isso|isso mesmo)$/i.test(
    normalizeText(text),
  );
}

function isCancellation(text) {
  return /^(nao|n|nao quero|nao quero pagar|nao quero seguir|nao vou pagar|sem pagar|gratis|gratuito|caro|cancela|cancelar|agora nao|nao agora|deixa|deixa pra la|deixa quieto|vou ver depois|depois eu vejo|sem interesse)$/i.test(
    normalizeText(text),
  );
}

function isMoreInfoRequest(text) {
  const normalized = normalizeText(text);
  return /\b(entender melhor|explica|explicar|como funciona|duvida|detalhes|mais detalhes|antes)\b/.test(normalized);
}

function isChangeScheduleRequest(text) {
  const normalized = normalizeText(text);
  return (
    /\b(trocar|mudar|alterar|remarcar|reagendar|novo horario|nova data)\b/.test(normalized) ||
    /\b(outro|outra|outros|outras)\s+(horario|dia|data|opcao|opcoes)\b/.test(normalized) ||
    /\b(tem|manda|envia|me passa|quais|mostra).*\b(outro|outra|outros|outras)\b/.test(normalized) ||
    /\b(mais cedo|mais tarde|de manha|a tarde|a noite)\b/.test(normalized) ||
    /\b(esse|essa|nesse|nessa) (horario|dia|data)?\s*(nao|n) (da|consigo|posso)\b/.test(normalized) ||
    /\b(nao|n) (da|consigo|posso) (nesse|nessa|esse|essa)\b/.test(normalized)
  );
}

function isPaymentAcceptance(text) {
  const normalized = normalizeText(text);
  return (
    isConfirmation(text) ||
    /\b(quero seguir|quero pagar|vou pagar|aceito pagar|pode cobrar|pode fazer|seguir com a consulta|fazer a consulta)\b/.test(
      normalized,
    ) ||
    /\b(manda|envia|passa).*\b(pix|pagamento)\b/.test(normalized) ||
    /\b(qual|como).*\b(pix|pagamento|pago|pagar)\b/.test(normalized)
  );
}

function inferLeadTypeFromProblemText(text) {
  const normalized = normalizeText(text);
  const saysNotNegative = /\b(nao|n|sem).*\b(negativado|negativada|nome sujo|restricao|restrito|restrita|serasa|spc)\b/.test(
    normalized,
  );
  const lowTicket = /\b(negativado|negativada|nome sujo|restricao|restrito|restrita|serasa|spc|boa vista|protesto|divida|pendencia|apontamento)\b/.test(
    normalized,
  );
  const highTicket =
    /\b(rating|banco nao aprova|bancos nao aprovam|nao aprova credito|nao aprova financiamento|nao consigo credito|nao consigo financiamento|financiamento|limite|emprestimo|linha de credito|credito negado|recusou credito|recusa credito)\b/.test(
      normalized,
    );

  if (saysNotNegative && highTicket) {
    return 'high_ticket';
  }

  if (lowTicket) {
    return 'low_ticket';
  }

  if (highTicket) {
    return 'high_ticket';
  }

  return null;
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

function truncateForAiHistory(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_AI_HISTORY_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_AI_HISTORY_TEXT_LENGTH - 1).trim()}…`;
}

function buildConversationHistory(conversation, { limit = MAX_AI_HISTORY_MESSAGES } = {}) {
  return (conversation?.messages || [])
    .slice(-limit)
    .map((message) =>
      compactObject({
        role: message.direction === 'out' ? 'assistant' : 'user',
        text: truncateForAiHistory(message.text),
        createdAt: message.createdAt,
        automationName: message.automationName,
      }),
    )
    .filter((message) => message.text);
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
    missing.push('data e horário');
  }

  if (isPhoneCallSchedule(data)) {
    if (!data?.contactPhone) {
      missing.push('telefone para ligação');
    }
  } else if (!data?.attendeeEmail) {
    missing.push('email ou confirmação de ligação por telefone');
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
    weekday: lookup.weekday,
  };
}

function formatAvailableSlot(slot) {
  const parts = getSlotParts(slot.startDateTime);
  const weekday = parts.weekday || WEEKDAY_LABELS[new Date(slot.startDateTime).getDay()] || '';
  return `${weekday}, ${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}

function buildMissingScheduleMessage(missing) {
  if (missing.includes('telefone para ligação')) {
    const withoutPhone = missing.filter((item) => item !== 'telefone para ligação');
    if (withoutPhone.length) {
      return `Perfeito. Me confirme o telefone com DDD para a ligação e me envie ${formatPtList(withoutPhone)}.`;
    }

    return 'Perfeito. Me confirme o telefone com DDD para a ligação.';
  }

  if (missing.includes('email ou confirmação de ligação por telefone')) {
    const withoutContact = missing.filter((item) => item !== 'email ou confirmação de ligação por telefone');
    const schedulePart = withoutContact.length ? `\n\nTambém preciso de ${formatPtList(withoutContact)}.` : '';
    return `Para finalizar, como prefere o atendimento?\n\n1. Enviar convite por email com Google Meet\n2. Não tenho email, prefiro ligação por telefone/WhatsApp${schedulePart}`;
  }

  return `Perfeito. Para seguir, me envie ${formatPtList(missing)} para eu criar o convite no Google Agenda.`;
}

function buildAvailableSlotsMessage(slots, missing, { heading = 'Tenho estes horários disponíveis' } = {}) {
  if (!slots.length) {
    return buildMissingScheduleMessage(missing);
  }

  const options = slots.map((slot, index) => `${index + 1}) ${formatAvailableSlot(slot)}`).join('\n');
  const needsContact = missing.includes('email ou confirmação de ligação por telefone');
  const needsPhone = missing.includes('telefone para ligação');
  const emailLine = needsContact
    ? 'Responda com o número do horário ou envie outro dia e horário. Depois me envie o email, ou diga "sem email" para ligação.'
    : needsPhone
      ? 'Responda com o número do horário ou envie outro dia e horário. Também confirme o telefone com DDD para a ligação.'
      : 'Responda com o número do horário ou envie outro dia e horário.';
  return `${heading}:\n${options}\n${emailLine}`;
}

function buildPreferredAvailableSlotsMessage(slots, missing, { heading = 'Tenho estes horários disponíveis' } = {}) {
  if (!slots.length) {
    return buildPreferredMissingScheduleMessage(missing);
  }

  const options = slots.map((slot, index) => `${index + 1}) ${formatAvailableSlot(slot)}`).join('\n');
  const needsPhone = missing.includes('telefone para ligação');
  const phoneLine = needsPhone ? '\n\nTambém me confirme o telefone com DDD para a ligação.' : '';

  return `Perfeito. A Cresce Mais quer te dar um atendimento preferencial.\n\n${heading}:\n${options}\n\nResponda com o número do horário ou envie outro dia e horário.${phoneLine}`;
}

function buildPreferredMissingScheduleMessage(missing) {
  const needsSchedule = missing.includes('data e horário');
  const needsPhone = missing.includes('telefone para ligação');

  if (needsSchedule && needsPhone) {
    return 'Perfeito. A Cresce Mais quer te dar um atendimento preferencial.\n\nMe envie um dia e horário de preferência e confirme o telefone com DDD para a ligação.';
  }

  if (needsSchedule) {
    return 'Perfeito. A Cresce Mais quer te dar um atendimento preferencial.\n\nMe envie um dia e horário de preferência para a ligação.';
  }

  if (needsPhone) {
    return 'Perfeito. A Cresce Mais quer te dar um atendimento preferencial.\n\nMe confirme o telefone com DDD para a ligação.';
  }

  return 'Perfeito. A Cresce Mais quer te dar um atendimento preferencial.';
}

function buildPreferredAgroData(current = {}, next = {}) {
  return normalizeSchedulePhone(
    mergeScheduleData(current, {
      analysisAccepted: true,
      calendarLeadType: 'high_ticket',
      durationMinutes: DEFAULT_MEETING_DURATION_MINUTES,
      leadType: 'high_ticket',
      meetingChannel: 'phone',
      notes: 'Atendimento preferencial Cresce Mais para lead do agro.',
      paymentAmount: null,
      phoneCallAccepted: true,
      preferredService: 'agro',
      segment: 'agro',
      title: 'Atendimento preferencial Cresce Mais',
      ...next,
    }),
  );
}

function getLaterSlotsSearchDate(slots = []) {
  const latestStart = slots
    .map((slot) => new Date(slot.startDateTime))
    .filter((date) => !Number.isNaN(date.getTime()))
    .reduce((latest, date) => Math.max(latest, date.getTime()), 0);

  if (!latestStart) {
    return new Date();
  }

  return new Date(latestStart + 12 * 60 * 60 * 1000);
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

  if (wordIndex >= 0) {
    return slots[wordIndex] || null;
  }

  const timeMatch = normalized.match(/\b(?:as\s*)?(\d{1,2})(?:(?::|h)(\d{2}))?h?\b/);
  if (!timeMatch) {
    return null;
  }

  const requestedHour = Number(timeMatch[1]);
  const requestedMinute = Number(timeMatch[2] || 0);
  if (!Number.isFinite(requestedHour) || requestedHour > 23 || requestedMinute > 59) {
    return null;
  }

  return (
    slots.find((slot) => {
      const parts = getSlotParts(slot.startDateTime);
      return Number(parts.hour) === requestedHour && Number(parts.minute) === requestedMinute;
    }) || null
  );
}

function buildQualificationMessage(data) {
  const question =
    data.qualificationQuestion ||
    'Para eu te orientar corretamente, qual é o seu caso?';

  return `${question}\n\n1. Meu nome está negativado/restrito no Serasa, SPC ou Boa Vista\n2. Não estou negativado, mas banco não aprova crédito, financiamento ou limite\n3. Não sei exatamente qual é o problema\n4. Só quero tirar uma dúvida`;
}

function buildAnalysisOfferMessage(data) {
  const leadType = normalizeLeadType(data.leadType);

  if (leadType === 'high_ticket') {
    return 'Perfeito. Para rating bancário baixo, fazemos uma consulta completa para identificar por que o banco não aprova financiamento, limite ou crédito. O valor da consulta é R$250.\n\n1. Quero seguir com a consulta\n2. Quero entender melhor antes\n3. Não quero pagar agora';
  }

  if (leadType === 'low_ticket') {
    return 'Perfeito. Para nome negativado, fazemos uma consulta completa para identificar restrições em Serasa, SPC, Boa Vista, score e apontamentos que afetam seu crédito. O valor da consulta é R$150.\n\n1. Quero seguir com a consulta\n2. Quero entender melhor antes\n3. Não quero pagar agora';
  }

  return buildQualificationMessage(data);
}

function buildAnalysisDetailsMessage(data) {
  const leadType = normalizeLeadType(data.leadType);

  if (leadType === 'high_ticket') {
    return 'A consulta de rating bancário verifica por que bancos recusam crédito, limite, financiamento ou empréstimo mesmo sem negativação aparente. Ela não promete aprovação garantida; identifica o problema para orientar o próximo passo.\n\n1. Quero seguir com a consulta\n2. Enviar outra dúvida em texto\n3. Não quero pagar agora';
  }

  return 'A consulta de negativado verifica restrições em Serasa, SPC, Boa Vista, score e apontamentos que podem impedir crédito. Ela não promete limpeza garantida; identifica o problema para orientar o próximo passo.\n\n1. Quero seguir com a consulta\n2. Enviar outra dúvida em texto\n3. Não quero pagar agora';
}

function buildAskForQuestionMessage() {
  return 'Claro. Me envie sua dúvida em uma frase que eu respondo sem sair do fluxo.\n\n1. Quero seguir com a consulta\n3. Não quero pagar agora';
}

function buildUnknownProblemOfferMessage() {
  return 'Sem problema. A consulta serve exatamente para identificar se existe negativação em Serasa/SPC/Boa Vista ou se o problema é rating bancário baixo. Vamos iniciar pela consulta de negativado, no valor de R$150.\n\n1. Sim, pode seguir\n2. Quero entender melhor\n3. Não quero pagar agora';
}

function buildGeneralQuestionOfferMessage() {
  return 'Consigo te orientar de forma geral, mas para analisar o seu caso com segurança a primeira etapa é a consulta paga.\n\n1. Consulta de negativado - R$150\n2. Consulta do CNPJ - R$250\n3. Não quero pagar agora';
}

function buildEmailRequestMessage() {
  return 'Perfeito. Me envie o email para o convite do Google Meet.';
}

function buildPaymentRefusalMessage() {
  return 'Sem problema. Nesse caso, não conseguimos avançar com a consulta agora. Caso queira seguir depois, é só chamar.';
}

function buildStateFallbackMessage(current) {
  const data = current?.data || {};
  const isPreferredAgro = data.segment === 'agro' || data.preferredService === 'agro';

  if (current?.status === 'awaiting_document_type') {
    return buildDocumentTypeMessage();
  }

  if (current?.status === 'awaiting_segment') {
    return buildSegmentMessage();
  }

  if (current?.status === 'awaiting_qualification') {
    return data.menu === 'curious_offer' ? buildGeneralQuestionOfferMessage() : buildQualificationMessage(data);
  }

  if (current?.status === 'awaiting_payment_confirmation') {
    return data.menu === 'curious_offer' ? buildGeneralQuestionOfferMessage() : buildAnalysisOfferMessage(data);
  }

  if (current?.status === 'awaiting_details') {
    const missing = getScheduleMissing(data);
    if (!missing.length) {
      return buildConfirmationMessage(data);
    }

    if (Array.isArray(data.availableSlots) && data.availableSlots.length && missing.includes('data e horário')) {
      return isPreferredAgro
        ? buildPreferredAvailableSlotsMessage(data.availableSlots, missing)
        : buildAvailableSlotsMessage(data.availableSlots, missing);
    }

    return isPreferredAgro ? buildPreferredMissingScheduleMessage(missing) : buildMissingScheduleMessage(missing);
  }

  if (current?.status === 'awaiting_confirmation') {
    const missing = getScheduleMissing(data);
    if (missing.length) {
      return isPreferredAgro ? buildPreferredMissingScheduleMessage(missing) : buildMissingScheduleMessage(missing);
    }

    return buildConfirmationMessage(data);
  }

  return null;
}

function buildAnalysisExistingContext(current) {
  const data = current?.data || {};
  return compactObject({
    ...data,
    conversationStatus: current?.status,
    missing: current?.data ? getScheduleMissing(data) : undefined,
    availableSlotOptions: Array.isArray(data.availableSlots)
      ? data.availableSlots.map((slot, index) => ({
          option: index + 1,
          label: formatAvailableSlot(slot),
          startDateTime: slot.startDateTime,
        }))
      : undefined,
  });
}

function buildConfirmationMessage(data) {
  const when = formatMeetingDate(data.startDateTime);
  const duration = Number(data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES);
  if (data.segment === 'agro' || data.preferredService === 'agro') {
    return `Perfeito. Posso marcar a ligação de atendimento preferencial Cresce Mais para ${when}, com duração de ${duration} minutos, pelo telefone ${data.contactPhone}?\n\n1. Sim, confirmar\n2. Quero trocar o horário\n3. Cancelar`;
  }

  const leadType = LEAD_TYPE_LABELS[normalizeLeadType(data.leadType)];
  if (isPhoneCallSchedule(data)) {
    return `Perfeito. Posso marcar a ligação de ${leadType} para ${when}, com duração de ${duration} minutos, pelo telefone ${data.contactPhone}?\n\n1. Sim, confirmar\n2. Quero trocar o horário\n3. Cancelar`;
  }

  return `Perfeito. Posso marcar a consulta de ${leadType} para ${when}, com duração de ${duration} minutos, e enviar o convite para ${data.attendeeEmail}?\n\n1. Sim, confirmar\n2. Quero trocar o horário\n3. Cancelar`;
}

function buildCalendarTitle(data, contactName) {
  if (data.segment === 'agro' || data.preferredService === 'agro') {
    return `Ligação atendimento preferencial Cresce Mais - ${contactName || data.attendeeName || 'Cliente'}`;
  }

  const leadType = LEAD_TYPE_LABELS[normalizeLeadType(data.leadType)];
  const name = contactName || data.attendeeName || 'Cliente';
  return isPhoneCallSchedule(data) ? `Ligação consulta ${leadType} - ${name}` : data.title || `Consulta ${leadType}`;
}

function buildCalendarDescription({ contactName, data = {}, jid, leadType, notes }) {
  return [
    'Consulta marcada automaticamente pelo WhatsApp Bot Wilson Sanches.',
    `Contato: ${contactName || jid}`,
    isPhoneCallSchedule(data) ? 'Formato: ligação por telefone/WhatsApp.' : 'Formato: Google Meet/convite por email.',
    data.contactPhone ? `Telefone: ${data.contactPhone}` : null,
    data.attendeeEmail ? `Email: ${data.attendeeEmail}` : null,
    `WhatsApp JID: ${jid}`,
    `Tipo de atendimento: ${data.segment === 'agro' || data.preferredService === 'agro' ? 'atendimento preferencial Cresce Mais - agro' : LEAD_TYPE_LABELS[normalizeLeadType(leadType)]}`,
    notes ? `Observações: ${notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export class WhatsAppClient extends EventEmitter {
  constructor({ appointmentStore, authDir, calendar, gemini, store }) {
    super();
    this.appointmentStore = appointmentStore;
    this.authDir = authDir;
    this.sessionBackupDir = process.env.WHATSAPP_SESSION_BACKUP_DIR
      ? path.resolve(process.env.WHATSAPP_SESSION_BACKUP_DIR)
      : path.join(path.dirname(authDir), 'baileys-backups');
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

  async getSessionDiagnostics() {
    const result = {
      authDir: this.authDir,
      exists: false,
      fileCount: 0,
      hasCreds: false,
      creds: null,
      backupDir: this.sessionBackupDir,
      backupCount: 0,
      latestBackup: null,
    };

    try {
      const files = await fs.readdir(this.authDir);
      result.exists = true;
      result.fileCount = files.length;
      result.hasCreds = files.includes('creds.json');

      if (result.hasCreds) {
        const credsPath = path.join(this.authDir, 'creds.json');
        const [stats, rawCreds] = await Promise.all([fs.stat(credsPath), fs.readFile(credsPath, 'utf8')]);
        const creds = JSON.parse(rawCreds);
        const idDigits = String(creds.me?.id || '').replace(/\D/g, '');
        const lidDigits = String(creds.me?.lid || '').replace(/\D/g, '');

        result.creds = {
          idEnding: idDigits ? idDigits.slice(-4) : null,
          lidEnding: lidDigits ? lidDigits.slice(-4) : null,
          modifiedAt: stats.mtime.toISOString(),
          name: creds.me?.name || null,
          platform: creds.platform || null,
          registered: Boolean(creds.registered),
        };
      }
    } catch (error) {
      result.error = error.code === 'ENOENT' ? 'session_dir_not_found' : error.message;
    }

    try {
      const backups = await fs.readdir(this.sessionBackupDir);
      const sortedBackups = backups.sort();
      result.backupCount = sortedBackups.length;
      result.latestBackup = sortedBackups.at(-1) || null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        result.backupError = error.message;
      }
    }

    return result;
  }

  async backupSession({ reason = 'manual' } = {}) {
    const diagnostics = await this.getSessionDiagnostics();

    if (!diagnostics.exists || diagnostics.fileCount === 0) {
      return null;
    }

    const backupName = getSessionBackupName(reason);
    const backupDir = path.join(this.sessionBackupDir, backupName);
    await fs.mkdir(this.sessionBackupDir, { recursive: true });
    await fs.cp(this.authDir, backupDir, { recursive: true, errorOnExist: true, force: false });

    return {
      backupDir,
      fileCount: diagnostics.fileCount,
      hasCreds: diagnostics.hasCreds,
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

  getSchedulingState(jid) {
    const cached = this.scheduling.get(jid);
    if (cached) {
      return cached;
    }

    const persisted = this.store?.getSchedulingState?.(jid);
    if (persisted) {
      this.scheduling.set(jid, persisted);
    }

    return persisted || null;
  }

  async setSchedulingState(jid, state, { contactName } = {}) {
    if (!jid || !state) {
      return null;
    }

    const nextState = {
      ...state,
      updatedAt: state.updatedAt || new Date().toISOString(),
    };
    this.scheduling.set(jid, nextState);

    if (this.store?.setSchedulingState) {
      await this.store.setSchedulingState(jid, nextState, { contactName });
    }

    return nextState;
  }

  async clearSchedulingState(jid) {
    this.scheduling.delete(jid);

    if (this.store?.clearSchedulingState) {
      await this.store.clearSchedulingState(jid);
    }
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
      this.emitActivity('error', 'Falha ao iniciar a conexão.', { error: error.message });
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
        ? 'WhatsApp pediu reinício da conexão. Reconectando...'
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
            this.emitActivity('error', 'Falha na reconexão.', { error: error.message });
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

    const history = buildConversationHistory(this.store?.getConversation?.(jid));
    const schedulingReply = await this.createSchedulingReply({ contactName, history, isGroup, jid, text });
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
      const response = await this.gemini.generateReply({ text, contactName, history });
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
    const isPreferredAgro = data?.segment === 'agro' || data?.preferredService === 'agro';
    let response = isPreferredAgro ? buildPreferredMissingScheduleMessage(missing) : buildMissingScheduleMessage(missing);

    if (missing.includes('data e horário') && this.calendar?.isReady) {
      try {
        const availableSlots = await this.calendar.listAvailableSlots({
          durationMinutes: data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES,
          leadType: data.calendarLeadType || data.leadType,
        });

        if (availableSlots.length) {
          nextData = {
            ...data,
            availableSlots,
          };
          response = isPreferredAgro ? buildPreferredAvailableSlotsMessage(availableSlots, missing) : buildAvailableSlotsMessage(availableSlots, missing);
        } else {
          response =
            'Não encontrei horários livres nos próximos dias. Me envie uma sugestão de data e horário para eu verificar.';
        }
      } catch (error) {
        this.emitActivity('error', 'Falha ao buscar horários disponíveis.', { error: error.message, jid });
      }
    }

    await this.setSchedulingState(jid, {
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

  async createAlternativeSlotsReply({ current, jid }) {
    const data = {
      ...(current?.data || {}),
      startDateTime: null,
    };
    const missing = getScheduleMissing(data);
    const isPreferredAgro = data?.segment === 'agro' || data?.preferredService === 'agro';
    let nextData = {
      ...data,
      availableSlots: [],
    };
    let response = isPreferredAgro
      ? buildPreferredMissingScheduleMessage(missing)
      : 'Claro. Me envie outro dia e horário de preferência para eu verificar.';

    if (this.calendar?.isReady) {
      try {
        const availableSlots = await this.calendar.listAvailableSlots({
          durationMinutes: data.durationMinutes || DEFAULT_MEETING_DURATION_MINUTES,
          leadType: data.calendarLeadType || data.leadType,
          now: getLaterSlotsSearchDate(data.availableSlots),
        });

        nextData = {
          ...data,
          availableSlots,
        };

        if (availableSlots.length) {
          response = isPreferredAgro
            ? buildPreferredAvailableSlotsMessage(availableSlots, missing, { heading: 'Tenho estes horários em outros dias' })
            : buildAvailableSlotsMessage(availableSlots, missing, { heading: 'Tenho estes horários em outros dias' });
        } else {
          response = 'Não encontrei outros horários livres nos próximos dias. Me envie uma sugestão de dia e horário para eu verificar.';
        }
      } catch (error) {
        this.emitActivity('error', 'Falha ao buscar horários em outros dias.', { error: error.message, jid });
      }
    }

    await this.setSchedulingState(jid, {
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

  createStateFallbackReply({ current, prefix = 'Não entendi certinho.' } = {}) {
    const response = buildStateFallbackMessage(current);
    if (!response) {
      return null;
    }

    return {
      ...this.defaultReply,
      name: 'Assistente',
      response: prefix ? `${prefix}\n\n${response}` : response,
    };
  }

  async createPaymentAcceptedReply({ contactName, current, jid, next = {}, text }) {
    const data = normalizeSchedulePhone(mergeScheduleData(current.data, { ...next, analysisAccepted: true }), { jid, text });
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
          'A consulta foi confirmada, mas o Google Agenda ainda não está configurado no sistema. Vou encaminhar para um atendente finalizar.',
      };
    }

    const missing = getScheduleMissing(data);
    if (missing.length) {
      return this.createMissingDetailsReply({ data, jid, missing });
    }

    await this.setSchedulingState(jid, {
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

  async createCustomQuestionReply({ contactName, current, history, jid, text }) {
    const data = {
      ...(current?.data || {}),
      menu: 'analysis_details',
    };

    await this.setSchedulingState(jid, {
      ...current,
      data,
      updatedAt: new Date().toISOString(),
    });

    if (!this.gemini?.isReady || !this.gemini.answerFlowQuestion) {
      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response:
          'Consigo responder dúvidas dentro do fluxo, mas a IA não está disponível agora.\n\n1. Quero seguir com a consulta\n2. Enviar outra dúvida em texto\n3. Não quero pagar agora',
      };
    }

    try {
      const response = await this.gemini.answerFlowQuestion({
        contactName,
        context: {
          conversationStatus: current?.status,
          leadType: normalizeLeadType(data.leadType),
          paymentAmount: data.paymentAmount || ANALYSIS_FEES[normalizeLeadType(data.leadType)] || null,
          product: LEAD_TYPE_LABELS[normalizeLeadType(data.leadType)] || 'consulta',
        },
        history: history || buildConversationHistory(this.store?.getConversation?.(jid)),
        text,
      });

      return {
        ...this.defaultReply,
        name: 'IA',
        response,
      };
    } catch (error) {
      this.emitActivity('error', 'IA não conseguiu responder a dúvida do fluxo.', { error: error.message, jid });
      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response:
          'Posso te explicar dentro do fluxo: a consulta identifica o problema antes de qualquer promessa de solução.\n\n1. Quero seguir com a consulta\n2. Enviar outra dúvida em texto\n3. Não quero pagar agora',
      };
    }
  }

  async createSchedulingReply({ contactName, history = null, isGroup, jid, text }) {
    if (isGroup) {
      return null;
    }

    let current = this.getSchedulingState(jid);
    const emailFromText = extractEmailFromText(text);
    const phoneCallPreference = getPhoneCallPreference(text, jid);
    const menuOption = getMenuOption(text);

    if (!current && isSimpleGreeting(text)) {
      const data = {};
      await this.setSchedulingState(jid, {
        data,
        status: 'awaiting_document_type',
        updatedAt: new Date().toISOString(),
      });

      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response: buildDocumentTypeMessage(),
      };
    }

    if (!current && (menuOption || isCpfDocumentTypeText(text) || isCnpjDocumentTypeText(text))) {
      current = {
        data: {},
        status: 'awaiting_document_type',
        updatedAt: new Date().toISOString(),
      };
    }

    if (!current && (isAgroSegmentText(text) || isNonAgroSegmentText(text))) {
      await this.setSchedulingState(jid, {
        data: {},
        status: 'awaiting_document_type',
        updatedAt: new Date().toISOString(),
      });

      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response: buildDocumentTypeMessage(),
      };
    }

    if (current?.status === 'awaiting_document_type') {
      if (menuOption === 1 || isCpfDocumentTypeText(text)) {
        const data = {
          ...current.data,
          documentType: 'cpf',
          segment: 'person',
        };

        await this.setSchedulingState(jid, {
          data,
          status: 'awaiting_qualification',
          updatedAt: new Date().toISOString(),
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildQualificationMessage(data),
        };
      }

      if (menuOption === 2 || isCnpjDocumentTypeText(text)) {
        const baseData = {
          ...current.data,
          documentType: 'cnpj',
        };

        if (isAgroSegmentText(text)) {
          const data = normalizeSchedulePhone(buildPreferredAgroData(baseData, phoneCallPreference), { jid, text });
          return this.createMissingDetailsReply({ data, jid, missing: getScheduleMissing(data) });
        }

        if (isNonAgroSegmentText(text)) {
          const normalized = normalizeText(text);
          const data = {
            ...baseData,
            segment: /\b(industria)\b/.test(normalized) ? 'industry' : /\b(comercio|servicos|servico|lojista)\b/.test(normalized) ? 'commerce_services' : 'other',
          };

          await this.setSchedulingState(jid, {
            data,
            status: 'awaiting_qualification',
            updatedAt: new Date().toISOString(),
          });

          return {
            ...this.defaultReply,
            name: 'Qualificação',
            response: buildQualificationMessage(data),
          };
        }

        await this.setSchedulingState(jid, {
          data: baseData,
          status: 'awaiting_segment',
          updatedAt: new Date().toISOString(),
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildSegmentMessage(),
        };
      }

      return this.createStateFallbackReply({ current });
    }

    if (current?.status === 'awaiting_segment') {
      if (isCpfDocumentTypeText(text)) {
        const data = {
          ...current.data,
          documentType: 'cpf',
          segment: 'person',
        };

        await this.setSchedulingState(jid, {
          data,
          status: 'awaiting_qualification',
          updatedAt: new Date().toISOString(),
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildQualificationMessage(data),
        };
      }

      if (menuOption === 1 || isAgroSegmentText(text)) {
        const data = normalizeSchedulePhone(buildPreferredAgroData(current.data, phoneCallPreference), { jid, text });
        const missing = getScheduleMissing(data);

        if (missing.length) {
          return this.createMissingDetailsReply({ data, jid, missing });
        }

        await this.setSchedulingState(jid, {
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

      const inferredLeadType = inferLeadTypeFromProblemText(text);
      if (inferredLeadType || isUnsureAboutProblem(text)) {
        const leadType = inferredLeadType || 'low_ticket';
        const data = mergeScheduleData(current.data, {
          analysisAccepted: false,
          leadConfidence: inferredLeadType ? 0.85 : 0.7,
          leadType,
          notes: inferredLeadType
            ? 'Cliente informou o problema antes de responder o segmento.'
            : 'Cliente não sabe exatamente qual é o problema; iniciar pela consulta de negativado.',
          paymentAmount: ANALYSIS_FEES[leadType],
          segment: 'unknown',
        });

        await this.setSchedulingState(jid, {
          data,
          status: 'awaiting_payment_confirmation',
          updatedAt: new Date().toISOString(),
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: inferredLeadType ? buildAnalysisOfferMessage(data) : buildUnknownProblemOfferMessage(),
        };
      }

      if ((menuOption && menuOption >= 2 && menuOption <= 4) || isNonAgroSegmentText(text)) {
        const data = {
          ...current.data,
          segment: menuOption === 2 ? 'commerce_services' : menuOption === 3 ? 'industry' : 'other',
        };

        await this.setSchedulingState(jid, {
          data,
          status: 'awaiting_qualification',
          updatedAt: new Date().toISOString(),
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildQualificationMessage(data),
        };
      }

      const data = {
        ...current.data,
        segment: 'other',
      };

      await this.setSchedulingState(jid, {
        data,
        status: 'awaiting_qualification',
        updatedAt: new Date().toISOString(),
      });

      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response: buildQualificationMessage(data),
      };
    }

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
      const missingBefore = getScheduleMissing(current.data);
      const waitingForContactChoice =
        !missingBefore.includes('data e horário') && missingBefore.includes('email ou confirmação de ligação por telefone');
      const selectedSlot = findSelectedAvailableSlot(text, current.data?.availableSlots);
      let detailsChanged = false;

      if (isChangeScheduleRequest(text)) {
        return this.createAlternativeSlotsReply({ current, jid });
      }

      if (waitingForContactChoice && menuOption === 1) {
        return {
          ...this.defaultReply,
          name: 'Agenda',
          response: buildEmailRequestMessage(),
        };
      }

      if (waitingForContactChoice && menuOption === 2) {
        current = {
          ...current,
          data: normalizeSchedulePhone(
            {
              ...current.data,
              attendeeEmail: null,
              meetingChannel: 'phone',
              phoneCallAccepted: true,
            },
            { jid, text },
          ),
          updatedAt: new Date().toISOString(),
        };
        detailsChanged = true;
      }

      if (emailFromText) {
        current = {
          ...current,
          data: {
            ...current.data,
            attendeeEmail: emailFromText,
            contactPhone: null,
            contactPhoneSource: null,
            meetingChannel: 'email',
            phoneCallAccepted: false,
          },
          updatedAt: new Date().toISOString(),
        };
        detailsChanged = true;
      }

      if (selectedSlot || phoneCallPreference.phoneCallAccepted) {
        current = {
          ...current,
          data: normalizeSchedulePhone(
            {
              ...current.data,
              ...(phoneCallPreference.phoneCallAccepted ? { attendeeEmail: null } : {}),
              ...phoneCallPreference,
              startDateTime: selectedSlot?.startDateTime || current.data.startDateTime,
            },
            { jid, text },
          ),
          updatedAt: new Date().toISOString(),
        };
        detailsChanged = true;
      }

      if (detailsChanged) {
        await this.setSchedulingState(jid, current, { contactName });
        const missing = getScheduleMissing(current.data);
        if (missing.length) {
          return this.createMissingDetailsReply({ data: current.data, jid, missing });
        }

        await this.setSchedulingState(jid, {
          data: current.data,
          status: 'awaiting_confirmation',
          updatedAt: new Date().toISOString(),
        }, { contactName });

        return {
          ...this.defaultReply,
          name: 'Agenda',
          response: buildConfirmationMessage(current.data),
        };
      }
    }

    if (!current && isAppointmentCancellation(text)) {
      return this.cancelScheduledMeeting({ contactName, jid });
    }

    if (current?.status === 'awaiting_qualification' && !menuOption) {
      const inferredLeadType = inferLeadTypeFromProblemText(text);
      if (inferredLeadType) {
        const data = mergeScheduleData(current.data, {
          analysisAccepted: false,
          leadConfidence: 0.85,
          leadType: inferredLeadType,
          notes: 'Cliente informou o problema em texto livre.',
          paymentAmount: ANALYSIS_FEES[inferredLeadType],
        });

        await this.setSchedulingState(jid, {
          data,
          status: 'awaiting_payment_confirmation',
          updatedAt: new Date().toISOString(),
        }, { contactName });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildAnalysisOfferMessage(data),
        };
      }
    }

    if (current?.status === 'awaiting_qualification' && menuOption) {
      if (current.data?.menu === 'curious_offer' && menuOption === 3) {
        await this.clearSchedulingState(jid);
        await this.recordLeadStatus({
          contactName,
          jid,
          reason: 'Cliente escolheu não pagar pela consulta.',
          status: 'discarded',
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildPaymentRefusalMessage(),
        };
      }

      if (menuOption === 4) {
        const data = mergeScheduleData(current.data, {
          analysisAccepted: false,
          leadType: 'unknown',
          menu: 'curious_offer',
        });

        await this.setSchedulingState(jid, {
          data,
          status: 'awaiting_qualification',
          updatedAt: new Date().toISOString(),
        }, { contactName });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildGeneralQuestionOfferMessage(),
        };
      }

      if (menuOption === 1 || menuOption === 2 || menuOption === 3) {
        const selectedLeadType = menuOption === 2 ? 'high_ticket' : 'low_ticket';
        const data = mergeScheduleData(current.data, {
          analysisAccepted: false,
          leadConfidence: 1,
          leadType: selectedLeadType,
          notes:
            menuOption === 3
              ? 'Cliente não sabe exatamente qual é o problema; iniciar pela consulta de negativado.'
              : `Cliente selecionou opção ${menuOption} no menu de qualificação.`,
          paymentAmount: ANALYSIS_FEES[selectedLeadType],
        });

        await this.setSchedulingState(jid, {
          data,
          status: 'awaiting_payment_confirmation',
          updatedAt: new Date().toISOString(),
        }, { contactName });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: menuOption === 3 ? buildUnknownProblemOfferMessage() : buildAnalysisOfferMessage(data),
        };
      }
    }

    if ((!current || current.status === 'awaiting_qualification') && isUnsureAboutProblem(text)) {
      const data = mergeScheduleData(current?.data, {
        analysisAccepted: false,
        leadConfidence: 0.7,
        leadType: 'low_ticket',
        notes: 'Cliente não sabe se o problema é negativação ou rating bancário baixo; iniciar pela consulta de negativado.',
        paymentAmount: ANALYSIS_FEES.low_ticket,
      });

      await this.setSchedulingState(jid, {
        data,
        status: 'awaiting_payment_confirmation',
        updatedAt: new Date().toISOString(),
      }, { contactName });

      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response: buildUnknownProblemOfferMessage(),
      };
    }

    if (current?.status === 'awaiting_confirmation') {
      if (menuOption === 1 || isConfirmation(text)) {
        return this.confirmScheduledMeeting({ contactName, jid });
      }

      if (menuOption === 2 || isChangeScheduleRequest(text)) {
        const { availableSlots, startDateTime, ...dataWithoutTime } = current.data;
        return this.createAlternativeSlotsReply({ current: { ...current, data: { ...dataWithoutTime, availableSlots } }, jid });
      }

      if (menuOption === 3 || isCancellation(text)) {
        await this.clearSchedulingState(jid);
        return {
          ...this.defaultReply,
          name: 'Agenda',
          response: 'Combinado, não marquei a reunião. Se quiser outro horário, é só me mandar.',
        };
      }
    }

    if (current?.status === 'awaiting_payment_confirmation') {
      if (menuOption === 3 || isCancellation(text)) {
        await this.clearSchedulingState(jid);
        await this.recordLeadStatus({
          contactName,
          jid,
          reason: 'Cliente não aceitou pagar a consulta.',
          status: 'discarded',
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildPaymentRefusalMessage(),
        };
      }

      if (menuOption === 1 || isPaymentAcceptance(text)) {
        return this.createPaymentAcceptedReply({ contactName, current, jid, text });
      }

      if (['analysis_details', 'awaiting_custom_question'].includes(current.data?.menu) && !menuOption) {
        return this.createCustomQuestionReply({ contactName, current, history, jid, text });
      }

      if (menuOption === 2 || isMoreInfoRequest(text)) {
        if (current.data?.menu === 'analysis_details' || current.data?.menu === 'awaiting_custom_question') {
          await this.setSchedulingState(jid, {
            ...current,
            data: {
              ...current.data,
              menu: 'awaiting_custom_question',
            },
            updatedAt: new Date().toISOString(),
          }, { contactName });

          return {
            ...this.defaultReply,
            name: 'Qualificação',
            response: buildAskForQuestionMessage(),
          };
        }

        await this.setSchedulingState(jid, {
          ...current,
          data: {
            ...current.data,
            menu: 'analysis_details',
          },
          updatedAt: new Date().toISOString(),
        }, { contactName });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildAnalysisDetailsMessage(current.data),
        };
      }
    }

    if (!this.gemini?.isReady) {
      return current ? this.createStateFallbackReply({ current }) : null;
    }

    let analysis;
    try {
      analysis = await this.gemini.analyzeScheduling({
        contactName,
        existing: buildAnalysisExistingContext(current),
        history: history || buildConversationHistory(this.store?.getConversation?.(jid)),
        nowIso: new Date().toISOString(),
        text,
        timeZone: GOOGLE_CALENDAR_TIME_ZONE,
      });
    } catch (error) {
      this.emitActivity('error', 'IA não conseguiu analisar agenda.', { error: error.message });
      return current ? this.createStateFallbackReply({ current }) : null;
    }

    if (analysis.intent === 'cancel' && current) {
      await this.clearSchedulingState(jid);
      if (['awaiting_document_type', 'awaiting_segment', 'awaiting_qualification', 'awaiting_payment_confirmation'].includes(current.status)) {
        await this.recordLeadStatus({
          contactName,
          jid,
          reason: current.data?.notes || text,
          status: 'discarded',
        });

        return {
          ...this.defaultReply,
          name: 'Qualificação',
          response: buildPaymentRefusalMessage(),
        };
      }

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

    if (analysis.intent === 'confirm' && current?.status === 'awaiting_payment_confirmation') {
      return this.createPaymentAcceptedReply({ contactName, current, jid, next: analysis, text });
    }

    if (current && analysis.intent === 'other' && Number(analysis.confidence || 0) < 0.55) {
      return this.createStateFallbackReply({ current });
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
      await this.clearSchedulingState(jid);
      await this.recordLeadStatus({
        contactName,
        jid,
        reason: data.notes || data.reason || text,
        status: 'discarded',
      });

      return {
        ...this.defaultReply,
        name: 'Qualificação',
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
      await this.setSchedulingState(jid, {
        data,
        status: 'awaiting_qualification',
        updatedAt: new Date().toISOString(),
      }, { contactName });

      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response: buildQualificationMessage(data),
      };
    }

    if (!data.analysisAccepted) {
      await this.setSchedulingState(jid, {
        data,
        status: 'awaiting_payment_confirmation',
        updatedAt: new Date().toISOString(),
      }, { contactName });

      return {
        ...this.defaultReply,
        name: 'Qualificação',
        response: buildAnalysisOfferMessage(data),
      };
    }

    if (!this.calendar?.isReady) {
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response:
          'Consigo marcar reuniões, mas o Google Agenda ainda não está configurado no sistema. Vou encaminhar para um atendente finalizar.',
      };
    }

    const missing = getScheduleMissing(data);

    if (missing.length) {
      return this.createMissingDetailsReply({ data, jid, missing });
    }

    await this.setSchedulingState(jid, {
      data,
      status: 'awaiting_confirmation',
      updatedAt: new Date().toISOString(),
    }, { contactName });

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
          'Não consegui consultar os agendamentos agora. Vou encaminhar para um atendente desmarcar manualmente.',
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
          'Não consegui consultar seu agendamento agora. Vou encaminhar para um atendente desmarcar manualmente.',
      };
    }

    if (!appointment) {
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response: 'Não encontrei nenhum agendamento futuro para desmarcar nesse WhatsApp.',
      };
    }

    if (!this.calendar?.isReady) {
      return {
        ...this.defaultReply,
        name: 'Agenda',
        response:
          'Encontrei seu agendamento, mas o Google Agenda não está conectado agora. Vou encaminhar para um atendente desmarcar manualmente.',
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

        this.emitActivity('calendar', 'Evento já não existia no Google Agenda. Marcando como cancelado.', {
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
        response: 'Pronto, desmarquei sua consulta na agenda. Se quiser remarcar outro horário, é só me mandar.',
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
    const current = this.getSchedulingState(jid);
    if (!current?.data) {
      return null;
    }

    const data = normalizeSchedulePhone(current.data, { jid });
    const missing = getScheduleMissing(data);
    if (missing.length) {
      return this.createMissingDetailsReply({ data, jid, missing });
    }

    const phoneCall = isPhoneCallSchedule(data);
    let event;

    try {
      event = await this.calendar.createMeeting({
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
        leadType: data.calendarLeadType || data.leadType,
        startDateTime: data.startDateTime,
        title: buildCalendarTitle(data, contactName),
      });
    } catch (error) {
      this.emitActivity('error', 'Falha ao criar evento no Google Agenda.', { error: error.message });

      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response:
          'Tentei marcar no Google Agenda, mas deu erro na integracao. Vou encaminhar para um atendente confirmar manualmente.',
      };
    }

    if (!event?.eventId) {
      this.emitActivity('error', 'Google Agenda respondeu sem ID do evento.', {
        calendarId: event?.calendarId,
        jid,
      });

      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response:
          'Tentei marcar no Google Agenda, mas a integração não retornou o ID do evento. Vou encaminhar para um atendente confirmar manualmente.',
      };
    }

    const savedAppointment = await this.saveAppointment({
      attendeeEmail: data.attendeeEmail,
      calendarId: event.calendarId,
      calendarLink: event.calendarLink,
      contactName,
      eventId: event.eventId,
      jid,
      leadType: data.calendarLeadType || data.leadType,
      meetLink: event.meetLink,
      startDateTime: event.startDateTime,
      title: event.title,
    });

    try {
      await this.clearSchedulingState(jid);
      await this.recordLeadStatus({
        appointmentId: savedAppointment?.id,
        appointmentSaved: Boolean(savedAppointment),
        calendarId: event.calendarId,
        calendarLink: event.calendarLink,
        contactName,
        eventId: event.eventId,
        jid,
        leadType: data.calendarLeadType || data.leadType,
        meetingAt: event.startDateTime,
        meetLink: event.meetLink,
        status: 'meeting_created',
        verificationError: event.verificationError,
        verified: event.verified,
      });
    } catch (error) {
      this.emitActivity('error', 'Reuniao criada no Google Agenda, mas falhou ao atualizar a pipeline.', {
        error: error.message,
        calendarId: event.calendarId,
        eventId: event.eventId,
        jid,
      });
    }

    this.emitActivity('calendar', 'Reuniao criada no Google Agenda.', {
      appointmentId: savedAppointment?.id,
      appointmentSaved: Boolean(savedAppointment),
      calendarId: event.calendarId,
      eventId: event.eventId,
      leadType: event.leadType,
      verificationError: event.verificationError,
      verified: event.verified,
    });

    const meetingDate = formatMeetingDate(event.startDateTime);
    const meetLine = event.meetLink ? `\nLink do Meet: ${event.meetLink}` : '';
    const calendarLine = event.calendarLink ? `\nConvite: ${event.calendarLink}` : '';

    if (phoneCall) {
      if (data.segment === 'agro' || data.preferredService === 'agro') {
        return {
          ...this.defaultReply,
          name: 'Google Agenda',
          response: `Ligação de atendimento preferencial Cresce Mais marcada para ${meetingDate}. O especialista responsável vai chamar pelo telefone/WhatsApp ${data.contactPhone}.`,
        };
      }

      return {
        ...this.defaultReply,
        name: 'Google Agenda',
        response: `Ligação marcada para ${meetingDate}. O especialista responsável vai chamar pelo telefone/WhatsApp ${data.contactPhone}.`,
      };
    }

    return {
      ...this.defaultReply,
      name: 'Google Agenda',
      response: `Consulta marcada para ${meetingDate}. Encaminhei para a agenda do especialista responsável e enviei o convite para ${data.attendeeEmail}.${meetLine}${calendarLine}`,
    };
  }

  async saveAppointment(appointment) {
    if (!this.appointmentStore?.isReady) {
      this.emitActivity('followup', 'Banco de follow-ups não configurado. Follow-ups não foram salvos.', {
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
    this.emitActivity('automation', `Resposta automática enviada por "${automation.name}".`, { jid });
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
      throw new Error('WhatsApp ainda não está conectado.');
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
      throw new Error('WhatsApp ainda não está conectado.');
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

    const sessionBackup = clearSession ? await this.backupSession({ reason: 'before-clear-session' }) : null;

    if (this.sock) {
      this.sock.end?.(undefined);
    }

    this.sock = null;
    this.qr = null;
    this.qrDataUrl = null;
    this.status = 'disconnected';
    this.startedAt = null;

    if (clearSession) {
      await fs.rm(this.authDir, { recursive: true, force: true });
      this.emitActivity('connection', 'Sessao local removida.', {
        backupDir: sessionBackup?.backupDir || null,
      });
    }

    this.emitActivity('connection', 'WhatsApp desconectado manualmente.');
    this.emitState();
    return sessionBackup ? { ...this.getState(), sessionBackup } : this.getState();
  }
}
