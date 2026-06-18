import crypto from 'node:crypto';
import { WhatsAppClient } from './whatsappClient.js';

const DEFAULT_GRAPH_API_VERSION = process.env.META_WHATSAPP_GRAPH_API_VERSION || 'v25.0';
const MARK_READ = process.env.META_WHATSAPP_MARK_READ !== 'false';
const DEFAULT_AUDIO_MAX_BYTES = 14 * 1024 * 1024;
const META_AUDIO_TRANSCRIPTION_ENABLED = process.env.META_WHATSAPP_AUDIO_TRANSCRIPTION_ENABLED ?? process.env.AUDIO_TRANSCRIPTION_ENABLED ?? 'true';
const configuredAudioMaxBytes = Number(process.env.META_WHATSAPP_AUDIO_MAX_BYTES || process.env.AUDIO_MAX_BYTES || DEFAULT_AUDIO_MAX_BYTES);
const configuredAudioTranscriptMaxChars = Number(
  process.env.META_WHATSAPP_AUDIO_TRANSCRIPTION_MAX_CHARS || process.env.AUDIO_TRANSCRIPTION_MAX_CHARS || 2800,
);
const AUDIO_MAX_BYTES = Number.isFinite(configuredAudioMaxBytes) ? configuredAudioMaxBytes : DEFAULT_AUDIO_MAX_BYTES;
const AUDIO_TRANSCRIPTION_MAX_CHARS = Number.isFinite(configuredAudioTranscriptMaxChars)
  ? Math.max(500, configuredAudioTranscriptMaxChars)
  : 2800;
const UNSUPPORTED_MESSAGE_REPLY =
  process.env.META_WHATSAPP_UNSUPPORTED_MESSAGE_REPLY ||
  'Recebi sua mensagem, mas consigo processar melhor quando vem em texto. Pode me mandar em texto?';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function normalizeGraphApiVersion(value) {
  const cleanValue = String(value || DEFAULT_GRAPH_API_VERSION)
    .trim()
    .replace(/^\/+|\/+$/g, '');

  if (!cleanValue) {
    return DEFAULT_GRAPH_API_VERSION;
  }

  return cleanValue.startsWith('v') ? cleanValue : `v${cleanValue}`;
}

function normalizePhoneDigits(value) {
  const rawValue = String(value || '').trim();
  const localPart = rawValue.includes('@') ? rawValue.split('@')[0] : rawValue;
  const digits = localPart.replace(/\D/g, '');

  if (!digits) {
    throw new Error('Informe um telefone com DDI e DDD.');
  }

  return digits;
}

function phoneToJid(value) {
  return `${normalizePhoneDigits(value)}@s.whatsapp.net`;
}

function jidToPhone(value) {
  return normalizePhoneDigits(value);
}

function getWebhookQueryValue(query, key) {
  const value = query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getMessageCreatedAt(message) {
  const timestamp = Number(message?.timestamp || 0);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return new Date().toISOString();
  }

  return new Date(timestamp * 1000).toISOString();
}

function getMetaContactName(contact, fallback) {
  return contact?.profile?.name || fallback || contact?.wa_id || 'Contato WhatsApp';
}

function getTextFromMetaMessage(message) {
  if (message?.type === 'text') {
    return String(message.text?.body || '').trim();
  }

  if (['document', 'image', 'video'].includes(message?.type)) {
    return String(message[message.type]?.caption || '').trim();
  }

  if (message?.type === 'button') {
    return String(message.button?.text || message.button?.payload || '').trim();
  }

  if (message?.type === 'interactive') {
    return String(
      message.interactive?.button_reply?.title ||
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.title ||
        message.interactive?.list_reply?.id ||
        '',
    ).trim();
  }

  return '';
}

function getMessageTypeLabel(message) {
  const type = String(message?.type || 'sem texto').trim();
  const labels = {
    audio: 'audio',
    button: 'botao',
    document: 'documento',
    image: 'imagem',
    interactive: 'interacao',
    location: 'localizacao',
    reaction: 'reacao',
    sticker: 'figurinha',
    video: 'video',
  };

  return labels[type] || type;
}

function truncateTranscriptForFlow(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= AUDIO_TRANSCRIPTION_MAX_CHARS) {
    return text;
  }

  return `${text.slice(0, AUDIO_TRANSCRIPTION_MAX_CHARS - 1).trim()}…`;
}

export class MetaWhatsAppClient extends WhatsAppClient {
  constructor({
    accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN,
    appSecret = process.env.META_WHATSAPP_APP_SECRET,
    graphApiVersion = DEFAULT_GRAPH_API_VERSION,
    phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID,
    verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN,
    ...options
  } = {}) {
    super(options);
    this.accessToken = accessToken || null;
    this.appSecret = appSecret || null;
    this.graphApiVersion = normalizeGraphApiVersion(graphApiVersion);
    this.phoneNumberId = phoneNumberId || null;
    this.verifyToken = verifyToken || null;
    this.processedWebhookMessageIds = new Set();
    this.processedWebhookMessageQueue = [];
    this.status = this.isReady ? 'connected' : 'disconnected';
    this.startedAt = this.isReady ? new Date().toISOString() : null;
    this.lastError = this.isReady ? null : 'Meta WhatsApp Cloud API nao configurada.';
  }

  get isReady() {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  getState() {
    const state = super.getState();

    return {
      ...state,
      hasSocket: false,
      lastError: this.lastError,
      provider: {
        id: 'meta',
        label: 'WhatsApp Oficial Meta',
        mode: 'cloud_api',
        configured: this.isReady,
        graphApiVersion: this.graphApiVersion,
        phoneNumberIdEnding: this.phoneNumberId ? String(this.phoneNumberId).slice(-5) : null,
        webhookConfigured: Boolean(this.verifyToken),
        webhookSignatureConfigured: Boolean(this.appSecret),
      },
      qr: null,
      qrDataUrl: null,
      startedAt: this.startedAt,
      status: this.status,
    };
  }

  async connect() {
    if (!this.isReady) {
      this.status = 'error';
      this.lastError = 'Configure META_WHATSAPP_ACCESS_TOKEN e META_WHATSAPP_PHONE_NUMBER_ID.';
      this.emitActivity('error', 'Meta WhatsApp Cloud API nao configurada.', {
        missingAccessToken: !this.accessToken,
        missingPhoneNumberId: !this.phoneNumberId,
      });
      this.emitState();
      return this.getState();
    }

    this.status = 'connected';
    this.lastError = null;
    this.startedAt = this.startedAt || new Date().toISOString();
    this.emitActivity('connection', 'WhatsApp Oficial Meta ativo.');
    this.emitState();
    return this.getState();
  }

  async disconnect() {
    return this.getState();
  }

  async backupSession() {
    return null;
  }

  async getSessionDiagnostics() {
    return {
      provider: 'meta',
      configured: this.isReady,
      graphApiVersion: this.graphApiVersion,
      phoneNumberIdEnding: this.phoneNumberId ? String(this.phoneNumberId).slice(-5) : null,
      webhookConfigured: Boolean(this.verifyToken),
      webhookSignatureConfigured: Boolean(this.appSecret),
    };
  }

  verifyWebhookChallenge(query = {}) {
    const mode = getWebhookQueryValue(query, 'hub.mode');
    const token = getWebhookQueryValue(query, 'hub.verify_token');
    const challenge = getWebhookQueryValue(query, 'hub.challenge');

    if (mode === 'subscribe' && this.verifyToken && token === this.verifyToken && challenge !== undefined) {
      return String(challenge);
    }

    return null;
  }

  verifyWebhookSignature(req) {
    if (!this.appSecret) {
      return true;
    }

    const signature = String(req.get?.('x-hub-signature-256') || '').trim();
    const rawBody = req.rawBody;

    if (!signature.startsWith('sha256=') || !rawBody) {
      return false;
    }

    const expectedSignature = `sha256=${crypto.createHmac('sha256', this.appSecret).update(rawBody).digest('hex')}`;
    return timingSafeEqualString(signature, expectedSignature);
  }

  getGraphUrl(pathname) {
    const cleanPathname = String(pathname || '').replace(/^\/+/, '');
    return `https://graph.facebook.com/${this.graphApiVersion}/${cleanPathname}`;
  }

  async requestMeta(pathname, payload) {
    if (!this.isReady) {
      throw new Error('Meta WhatsApp Cloud API nao configurada.');
    }

    const response = await fetch(this.getGraphUrl(pathname), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = body?.error?.message || `Meta Graph API retornou HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.meta = body;
      throw error;
    }

    return body;
  }

  async requestMetaGet(pathname) {
    if (!this.isReady) {
      throw new Error('Meta WhatsApp Cloud API nao configurada.');
    }

    const response = await fetch(this.getGraphUrl(pathname), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = body?.error?.message || `Meta Graph API retornou HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.meta = body;
      throw error;
    }

    return body;
  }

  async getPhoneNumberDiagnostics() {
    const fields = [
      'verified_name',
      'name_status',
      'code_verification_status',
      'display_phone_number',
      'quality_rating',
      'platform_type',
    ].join(',');
    const body = await this.requestMetaGet(`${this.phoneNumberId}?fields=${encodeURIComponent(fields)}`);

    return {
      ...body,
      phoneNumberIdEnding: this.phoneNumberId ? String(this.phoneNumberId).slice(-5) : null,
    };
  }

  async registerPhoneNumber(pin) {
    const cleanPin = String(pin || '').trim();

    if (!/^\d{6}$/.test(cleanPin)) {
      throw new Error('Informe um PIN de 6 digitos para registrar o numero na Meta.');
    }

    return this.requestMeta(`${this.phoneNumberId}/register`, {
      messaging_product: 'whatsapp',
      pin: cleanPin,
    });
  }

  async sendTextMessage(phone, text) {
    return this.requestMeta(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizePhoneDigits(phone),
      type: 'text',
      text: {
        body: String(text || '').trim(),
        preview_url: false,
      },
    });
  }

  async sendTemplateMessage(phone, { components = [], languageCode = 'pt_BR', name }) {
    const templateName = String(name || '').trim();
    if (!templateName) {
      throw new Error('Informe o nome do template.');
    }

    return this.requestMeta(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizePhoneDigits(phone),
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode || 'pt_BR',
        },
        ...(components?.length ? { components } : {}),
      },
    });
  }

  async downloadMedia(mediaId) {
    const media = await this.requestMetaGet(mediaId);
    const mediaUrl = media.url;

    if (!mediaUrl) {
      throw new Error('Meta nao retornou URL da midia.');
    }

    const response = await fetch(mediaUrl, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Falha ao baixar midia da Meta: HTTP ${response.status}.`);
    }

    const declaredBytes = Number(response.headers.get('content-length') || media.file_size || 0);
    if (AUDIO_MAX_BYTES > 0 && declaredBytes > AUDIO_MAX_BYTES) {
      throw new Error(`Audio maior que o limite de ${AUDIO_MAX_BYTES} bytes.`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (AUDIO_MAX_BYTES > 0 && buffer.length > AUDIO_MAX_BYTES) {
      throw new Error(`Audio baixado maior que o limite de ${AUDIO_MAX_BYTES} bytes.`);
    }

    return {
      buffer,
      mimeType: media.mime_type || response.headers.get('content-type') || 'audio/ogg',
      size: buffer.length,
    };
  }

  async transcribeMetaAudio(message, { contactName, jid } = {}) {
    if (META_AUDIO_TRANSCRIPTION_ENABLED === 'false') {
      throw new Error('Transcricao de audio desativada.');
    }

    if (!this.gemini?.isReady) {
      throw new Error('Gemini nao configurado para transcrever audio.');
    }

    const audioId = message?.audio?.id;
    if (!audioId) {
      throw new Error('Audio sem ID de midia.');
    }

    const media = await this.downloadMedia(audioId);
    const transcript = truncateTranscriptForFlow(
      await this.gemini.transcribeAudio({
        audioBuffer: media.buffer,
        contactName,
        mimeType: message.audio?.mime_type || media.mimeType,
      }),
    );

    if (!transcript) {
      throw new Error('Transcricao vazia.');
    }

    this.emitActivity('audio', `Audio transcrito de ${contactName || jid}.`, {
      bytes: media.size,
      jid,
      mimeType: message.audio?.mime_type || media.mimeType,
      provider: 'meta',
    });

    return {
      bytes: media.size,
      mimeType: message.audio?.mime_type || media.mimeType,
      text: transcript,
    };
  }

  async markMessageAsRead(messageId) {
    if (!MARK_READ || !messageId || !this.isReady) {
      return null;
    }

    return this.requestMeta(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  rememberWebhookMessage(messageId) {
    if (!messageId) {
      return false;
    }

    if (this.processedWebhookMessageIds.has(messageId)) {
      return true;
    }

    this.processedWebhookMessageIds.add(messageId);
    this.processedWebhookMessageQueue.push(messageId);

    while (this.processedWebhookMessageQueue.length > 5000) {
      const oldMessageId = this.processedWebhookMessageQueue.shift();
      this.processedWebhookMessageIds.delete(oldMessageId);
    }

    return false;
  }

  async recordOutboundMessage({ automationName = null, contactName, createdAt, jid, metaMessageId, text }) {
    await this.store.addConversationMessage({
      jid,
      contactName,
      direction: 'out',
      text,
      automationName,
      createdAt,
      id: metaMessageId,
    });

    this.emit('message', {
      jid,
      contactName,
      text,
      direction: 'out',
      createdAt,
    });
  }

  async replyWithAutomation(jid, _quotedMessage, automation, contactName, options = {}) {
    if (!this.isReady) {
      return;
    }

    const responseText = String(automation?.response || '').trim();
    if (!jid || !responseText) {
      return;
    }

    const outbound = await this.prepareOutbound(jid, {
      bypassLimits: options.bypassLimits,
      contactName,
      source: automation.name || 'automation',
    });
    if (!outbound.ok) {
      return {
        jid,
        reason: outbound.reason,
        skipped: true,
        text: responseText,
      };
    }

    const delayMs = Math.max(0, Number(automation.delayMs || 0));
    if (delayMs) {
      await sleep(delayMs);
    }

    const payload = await this.sendTextMessage(jidToPhone(jid), responseText);
    const metaMessageId = payload?.messages?.[0]?.id || null;
    this.noteOutboundSent(jid);

    const createdAt = new Date().toISOString();
    await this.recordOutboundMessage({
      jid,
      contactName,
      text: responseText,
      automationName: automation.name,
      createdAt,
      metaMessageId,
    });

    this.emit('automation:reply', {
      jid,
      contactName,
      automationName: automation.name,
      text: responseText,
      createdAt,
    });
    this.emitActivity('automation', `Resposta automática enviada por "${automation.name}".`, {
      jid,
      metaMessageId,
      provider: 'meta',
    });
    await this.recordEvent('message_replied', {
      jid,
      contactName,
      meta: compactObject({
        automationName: automation.name,
        metaMessageId,
        provider: 'meta',
      }),
    });
  }

  async sendText(phone, text) {
    const jid = phoneToJid(phone);
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      throw new Error('Informe uma mensagem.');
    }

    const outbound = await this.prepareOutbound(jid, { contactName: phone, source: 'manual_send' });
    if (!outbound.ok) {
      throw new Error('Envio bloqueado pelos limites de segurança.');
    }

    const payload = await this.sendTextMessage(phone, cleanText);
    const metaMessageId = payload?.messages?.[0]?.id || null;
    this.noteOutboundSent(jid);

    const createdAt = new Date().toISOString();
    await this.recordOutboundMessage({
      jid,
      contactName: phone,
      text: cleanText,
      createdAt,
      metaMessageId,
    });
    this.emitActivity('message', `Mensagem enviada para ${phone}.`, {
      jid,
      metaMessageId,
      provider: 'meta',
    });

    return { jid, text: cleanText, createdAt, metaMessageId };
  }

  async sendTemplate(phone, { components = [], languageCode = 'pt_BR', name }) {
    const jid = phoneToJid(phone);
    const outbound = await this.prepareOutbound(jid, { contactName: phone, source: 'meta_template' });
    if (!outbound.ok) {
      throw new Error('Envio bloqueado pelos limites de segurança.');
    }

    const payload = await this.sendTemplateMessage(phone, { components, languageCode, name });
    const metaMessageId = payload?.messages?.[0]?.id || null;
    const createdAt = new Date().toISOString();
    const templateLabel = `[Template Meta] ${name}`;

    this.noteOutboundSent(jid);
    await this.recordOutboundMessage({
      jid,
      contactName: phone,
      text: templateLabel,
      automationName: 'Template Meta',
      createdAt,
      metaMessageId,
    });
    this.emitActivity('message', `Template Meta "${name}" enviado para ${phone}.`, {
      jid,
      metaMessageId,
      provider: 'meta',
      templateName: name,
    });

    return { jid, templateName: name, createdAt, metaMessageId };
  }

  async sendTextToJid(jid, text, { automationName = null, contactName = jid, bypassLimits = false } = {}) {
    const cleanText = String(text || '').trim();
    if (!jid || !cleanText) {
      throw new Error('Informe JID e mensagem.');
    }

    const outbound = await this.prepareOutbound(jid, {
      bypassLimits,
      contactName,
      source: automationName || 'message',
    });
    if (!outbound.ok) {
      return {
        jid,
        reason: outbound.reason,
        skipped: true,
        text: cleanText,
      };
    }

    const payload = await this.sendTextMessage(jidToPhone(jid), cleanText);
    const metaMessageId = payload?.messages?.[0]?.id || null;
    this.noteOutboundSent(jid);

    const createdAt = new Date().toISOString();
    await this.recordOutboundMessage({
      jid,
      contactName,
      text: cleanText,
      automationName,
      createdAt,
      metaMessageId,
    });

    return { jid, text: cleanText, createdAt, metaMessageId };
  }

  async handleWebhook(payload = {}) {
    let messagesHandled = 0;
    let statusesHandled = 0;

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field && change.field !== 'messages') {
          continue;
        }

        const value = change.value || {};
        const contacts = new Map((value.contacts || []).map((contact) => [String(contact.wa_id || ''), contact]));

        for (const status of value.statuses || []) {
          statusesHandled += 1;
          await this.handleMetaStatus(status, value);
        }

        for (const message of value.messages || []) {
          const contact = contacts.get(String(message.from || ''));
          const handled = await this.handleMetaMessage(message, contact, value);
          messagesHandled += handled ? 1 : 0;
        }
      }
    }

    return { messagesHandled, statusesHandled };
  }

  async handleMetaStatus(status, value = {}) {
    if (status?.status !== 'failed') {
      return;
    }

    const jid = status.recipient_id ? phoneToJid(status.recipient_id) : null;
    const error = status.errors?.[0] || {};
    this.emitActivity('error', 'Mensagem recusada pela Meta.', {
      code: error.code || null,
      details: error.error_data?.details || null,
      jid,
      messageId: status.id || null,
      phoneNumberId: value.metadata?.phone_number_id || null,
      title: error.title || null,
    });
    await this.recordEvent('meta_message_failed', {
      jid,
      meta: {
        error,
        messageId: status.id || null,
        provider: 'meta',
      },
    });
  }

  async handleMetaMessage(message, contact, value = {}) {
    if (!message?.id || !message?.from) {
      return false;
    }

    if (this.rememberWebhookMessage(message.id)) {
      return false;
    }

    const jid = phoneToJid(message.from);
    const contactName = getMetaContactName(contact, message.from);
    let text = getTextFromMetaMessage(message);
    const messageType = getMessageTypeLabel(message);
    let conversationText = text || `[Mensagem ${messageType} recebida]`;
    let shouldSendUnsupportedFallback = false;
    const createdAt = getMessageCreatedAt(message);
    const aiPaused = this.isConversationAiPaused(jid);
    const providerActive = this.providerActive !== false;

    if (!text && message.type === 'audio') {
      conversationText = '[Audio recebido]';

      if (!aiPaused && providerActive) {
        try {
          const transcription = await this.transcribeMetaAudio(message, { contactName, jid });
          text = transcription.text;
          conversationText = `[Audio transcrito] ${text}`;
        } catch (error) {
          conversationText = `[Audio recebido: transcricao indisponivel] ${error.message}`;
          shouldSendUnsupportedFallback = true;
          this.emitActivity('error', 'Falha ao transcrever audio da Meta.', {
            error: error.message,
            jid,
            messageId: message.id,
            provider: 'meta',
          });
        }
      }
    }

    await this.store.addConversationMessage({
      jid,
      contactName,
      direction: 'in',
      text: conversationText,
      id: message.id,
      createdAt,
    });

    if (providerActive) {
      this.markMessageAsRead(message.id).catch((error) => {
        this.emitActivity('error', 'Falha ao marcar mensagem como lida na Meta.', {
          error: error.message,
          jid,
        });
      });
    }

    this.emit('message', {
      jid,
      contactName,
      text: conversationText,
      isGroup: false,
      createdAt,
    });
    this.emitActivity('message', `Mensagem recebida de ${contactName}.`, {
      jid,
      messageId: message.id,
      phoneNumberId: value.metadata?.phone_number_id || null,
      provider: 'meta',
      type: message.type || null,
    });

    if (!providerActive) {
      this.cancelPendingReply(jid);
      this.emitActivity('message', `Canal inativo para ${contactName}. Mensagem salva sem resposta automática.`, { jid });
      return true;
    }

    if (aiPaused) {
      this.cancelPendingReply(jid);
      this.emitActivity('message', `IA pausada para ${contactName}. Atendimento manual aguardando resposta.`, { jid });
      return true;
    }

    if (!text || shouldSendUnsupportedFallback) {
      await this.replyWithAutomation(
        jid,
        message,
        {
          ...this.defaultReply,
          delayMs: 500,
          name: 'Mensagem sem texto',
          response: UNSUPPORTED_MESSAGE_REPLY,
        },
        contactName,
        { skipTypingDelay: true },
      );
      return true;
    }

    this.queueAutoReply({ contactName, isGroup: false, jid, message, text });
    return true;
  }
}
