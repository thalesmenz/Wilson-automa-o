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
const DEFAULT_META_APP_ID = process.env.META_APP_ID || process.env.META_WHATSAPP_APP_ID || process.env.FACEBOOK_APP_ID || '';

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

function normalizeMetaObjectId(value, label = 'ID') {
  const cleanValue = String(value || '').trim();

  if (!/^\d+$/.test(cleanValue)) {
    throw new Error(`Informe um ${label} valido.`);
  }

  return cleanValue;
}

function normalizeUploadFileName(value, fallback = 'profile-picture.png') {
  const cleanValue = String(value || fallback)
    .trim()
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleanValue || fallback;
}

function normalizeImageMimeType(value) {
  const cleanValue = String(value || '').split(';')[0].trim().toLowerCase();
  if (cleanValue === 'image/jpg') {
    return 'image/jpeg';
  }

  if (cleanValue !== 'image/jpeg' && cleanValue !== 'image/png') {
    throw new Error('Envie uma imagem PNG ou JPEG para a foto de perfil.');
  }

  return cleanValue;
}

function normalizeSubscribedFields(value) {
  const fields = Array.isArray(value) ? value : String(value || 'messages').split(',');
  const cleanFields = [...new Set(fields.map((field) => String(field || '').trim()).filter(Boolean))];

  return cleanFields.length ? cleanFields : ['messages'];
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
    return String(message.button?.payload || message.button?.text || '').trim();
  }

  if (message?.type === 'interactive') {
    return String(
      message.interactive?.button_reply?.id ||
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.id ||
        message.interactive?.list_reply?.title ||
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

function normalizeQuickReplyText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function stripNumberedOptions(value) {
  const lines = String(value || '').split('\n');
  const cleanLines = lines.filter((line) => {
    const cleanLine = line.trim();
    if (/^[1-9]\s*[.)\-–—]\s+/.test(cleanLine)) {
      return false;
    }

    if (/^responda com (?:o )?n[uú]mero/i.test(cleanLine)) {
      return false;
    }

    return true;
  });

  return cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildQuickReplyMessage(text, buttons, { keepNumberedOptions = false } = {}) {
  const cleanButtons = buttons
    .map((button) => ({
      id: String(button.id || '').trim(),
      title: String(button.title || '').trim(),
    }))
    .filter((button) => button.id && button.title)
    .slice(0, 3);

  if (!cleanButtons.length) {
    return null;
  }

  return {
    body: keepNumberedOptions ? String(text || '').trim() : stripNumberedOptions(text),
    buttons: cleanButtons,
  };
}

function getQuickReplyForText(text) {
  const normalized = normalizeQuickReplyText(text);

  if (normalized.includes('me conta: o que voce precisa resolver hoje?')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Consulta R$150' },
      { id: '2', title: 'Como funciona' },
      { id: '3', title: 'Urgente hoje' },
    ]);
  }

  if (normalized.includes('funciona assim: fazemos uma consulta tecnica')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Seguir consulta' },
      { id: '2', title: 'Tenho dúvida' },
      { id: '3', title: 'Não agora' },
    ]);
  }

  if (normalized.includes('para eu te orientar corretamente, qual e o seu caso?')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Nome negativado' },
      { id: '2', title: 'Banco não aprova' },
      { id: '3', title: 'Não sei/dúvida' },
    ]);
  }

  if (normalized.includes('consulta para descobrir o problema') && normalized.includes('tirar uma duvida antes')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Consulta R$150' },
      { id: '2', title: 'Tirar dúvida' },
      { id: '3', title: 'Não agora' },
    ]);
  }

  if (normalized.includes('qual e a area de atuacao do cnpj?')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Agro' },
      { id: '2', title: 'Comércio/serv.' },
      { id: '4', title: 'Outra área' },
    ]);
  }

  if (normalized.includes('o valor da consulta e r$') && normalized.includes('quero seguir com a consulta')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Quero seguir' },
      { id: '2', title: 'Entender melhor' },
      { id: '3', title: 'Não agora' },
    ]);
  }

  if (normalized.includes('ela nao promete') && normalized.includes('enviar outra duvida em texto')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Quero seguir' },
      { id: '2', title: 'Tenho dúvida' },
      { id: '3', title: 'Não agora' },
    ]);
  }

  if (normalized.includes('me envie sua duvida em uma frase')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Seguir consulta' },
      { id: '3', title: 'Não agora' },
    ]);
  }

  if (normalized.includes('vamos iniciar pela consulta de negativado')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Sim, seguir' },
      { id: '2', title: 'Entender melhor' },
      { id: '3', title: 'Não agora' },
    ]);
  }

  if (normalized.includes('consulta de negativado - r$150') && normalized.includes('consulta do cnpj - r$250')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Negativado R$150' },
      { id: '2', title: 'CNPJ R$250' },
      { id: '3', title: 'Não agora' },
    ]);
  }

  if (normalized.includes('como prefere o atendimento?') && normalized.includes('google meet')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Google Meet' },
      { id: '2', title: 'Ligação/Zap' },
    ]);
  }

  if (normalized.includes('tenho estes horarios')) {
    return buildQuickReplyMessage(
      text,
      [
        { id: '1', title: '1º horário' },
        { id: '2', title: '2º horário' },
        { id: '3', title: '3º horário' },
      ],
      { keepNumberedOptions: true },
    );
  }

  if (normalized.includes('posso marcar') && normalized.includes('trocar o horario')) {
    return buildQuickReplyMessage(text, [
      { id: '1', title: 'Confirmar' },
      { id: '2', title: 'Trocar horário' },
      { id: '3', title: 'Cancelar' },
    ]);
  }

  return null;
}

export class MetaWhatsAppClient extends WhatsAppClient {
  constructor({
    accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN,
    appSecret = process.env.META_WHATSAPP_APP_SECRET,
    graphApiVersion = DEFAULT_GRAPH_API_VERSION,
    phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID,
    whatsappBusinessAccountId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || process.env.META_WHATSAPP_WABA_ID,
    verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN,
    ...options
  } = {}) {
    super(options);
    this.accessToken = accessToken || null;
    this.appSecret = appSecret || null;
    this.graphApiVersion = normalizeGraphApiVersion(graphApiVersion);
    this.phoneNumberId = phoneNumberId || null;
    this.whatsappBusinessAccountId = whatsappBusinessAccountId || null;
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

  async requestMetaForm(pathname, payload = {}) {
    if (!this.isReady) {
      throw new Error('Meta WhatsApp Cloud API nao configurada.');
    }

    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(payload || {})) {
      if (value !== undefined && value !== null && value !== '') {
        formBody.set(key, String(value));
      }
    }

    const response = await fetch(this.getGraphUrl(pathname), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
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

  getWabaId(wabaId = this.whatsappBusinessAccountId) {
    return normalizeMetaObjectId(wabaId, 'WABA ID');
  }

  async getWabaWebhookSubscriptions(wabaId = this.whatsappBusinessAccountId) {
    return this.requestMetaGet(`${this.getWabaId(wabaId)}/subscribed_apps`);
  }

  async subscribeWabaToWebhooks({ wabaId = this.whatsappBusinessAccountId, fields = ['messages'] } = {}) {
    return this.requestMetaForm(`${this.getWabaId(wabaId)}/subscribed_apps`, {
      subscribed_fields: normalizeSubscribedFields(fields).join(','),
    });
  }

  async getBusinessProfile(fields = 'about,address,description,email,profile_picture_url,websites,vertical') {
    return this.requestMetaGet(`${this.phoneNumberId}/whatsapp_business_profile?fields=${encodeURIComponent(fields)}`);
  }

  async createUploadSession({ appId = DEFAULT_META_APP_ID, fileLength, fileName, fileType }) {
    const cleanAppId = normalizeMetaObjectId(appId, 'App ID');
    const params = new URLSearchParams({
      access_token: this.accessToken,
      file_length: String(fileLength),
      file_name: normalizeUploadFileName(fileName),
      file_type: normalizeImageMimeType(fileType),
    });
    const response = await fetch(this.getGraphUrl(`${cleanAppId}/uploads?${params.toString()}`), {
      method: 'POST',
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || !body?.id) {
      const message = body?.error?.message || `Meta Graph API retornou HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.meta = body;
      throw error;
    }

    return body.id;
  }

  async uploadProfilePictureBinary({ appId = DEFAULT_META_APP_ID, buffer, fileName = 'profile-picture.png', fileType }) {
    const imageBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (!imageBuffer.length) {
      throw new Error('Imagem da foto de perfil vazia.');
    }

    const cleanFileType = normalizeImageMimeType(fileType);
    const uploadSessionId = await this.createUploadSession({
      appId,
      fileLength: imageBuffer.length,
      fileName,
      fileType: cleanFileType,
    });

    const response = await fetch(this.getGraphUrl(uploadSessionId), {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${this.accessToken}`,
        'Content-Type': cleanFileType,
        file_offset: '0',
      },
      body: imageBuffer,
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || !body?.h) {
      const message = body?.error?.message || `Meta Graph API retornou HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.meta = body;
      throw error;
    }

    return body.h;
  }

  async updateBusinessProfile(payload = {}) {
    return this.requestMeta(`${this.phoneNumberId}/whatsapp_business_profile`, {
      messaging_product: 'whatsapp',
      ...payload,
    });
  }

  async updateProfilePicture({ appId = DEFAULT_META_APP_ID, buffer, fileName, fileType }) {
    const profilePictureHandle = await this.uploadProfilePictureBinary({
      appId,
      buffer,
      fileName,
      fileType,
    });

    const update = await this.updateBusinessProfile({
      profile_picture_handle: profilePictureHandle,
    });
    const profile = await this.getBusinessProfile();

    return {
      profile,
      profilePictureHandleEnding: String(profilePictureHandle).slice(-12),
      success: Boolean(update?.success),
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

  async sendQuickReplyMessage(phone, { body, buttons }) {
    const cleanBody = String(body || '').trim();
    const cleanButtons = (buttons || [])
      .map((button) => ({
        id: String(button.id || '').trim(),
        title: String(button.title || '').trim(),
      }))
      .filter((button) => button.id && button.title)
      .slice(0, 3);

    if (!cleanBody || !cleanButtons.length) {
      return this.sendTextMessage(phone, cleanBody || body);
    }

    return this.requestMeta(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizePhoneDigits(phone),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: cleanBody,
        },
        action: {
          buttons: cleanButtons.map((button) => ({
            type: 'reply',
            reply: {
              id: button.id,
              title: button.title,
            },
          })),
        },
      },
    });
  }

  async sendAutomationMessage(phone, text) {
    const quickReply = getQuickReplyForText(text);
    if (quickReply) {
      return this.sendQuickReplyMessage(phone, quickReply);
    }

    return this.sendTextMessage(phone, text);
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

    const payload = await this.sendAutomationMessage(jidToPhone(jid), responseText);
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

    const payload = await this.sendAutomationMessage(jidToPhone(jid), cleanText);
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
