import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const OAUTH_LEAD_TYPES = ['default', 'low_ticket', 'high_ticket'];

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function loadServiceAccount(jsonPath) {
  if (!jsonPath) {
    return null;
  }

  const resolvedPath = path.isAbsolute(jsonPath) ? jsonPath : path.resolve(process.cwd(), jsonPath);

  try {
    return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    console.warn(`Nao foi possivel ler a conta de servico do Google em ${resolvedPath}: ${error.message}`);
    return null;
  }
}

function normalizeLeadType(value) {
  return value === 'high_ticket' || value === 'low_ticket' ? value : 'default';
}

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeState(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function resolveLocalPath(value) {
  if (!value) {
    return null;
  }

  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function getTokenPath(tokenDir, leadType) {
  const safeLeadType = normalizeLeadType(leadType);
  const resolvedDir = resolveLocalPath(tokenDir);
  return resolvedDir ? path.join(resolvedDir, `google-oauth-${safeLeadType}.json`) : null;
}

function readOAuthToken(tokenDir, leadType) {
  const tokenPath = getTokenPath(tokenDir, leadType);
  if (!tokenPath || !fs.existsSync(tokenPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (error) {
    console.warn(`Nao foi possivel ler token OAuth do Google em ${tokenPath}: ${error.message}`);
    return null;
  }
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + Number(minutes || 30) * 60 * 1000);
}

function getMeetLink(event) {
  return (
    event?.hangoutLink ||
    event?.conferenceData?.entryPoints?.find((entryPoint) => entryPoint.entryPointType === 'video')?.uri ||
    null
  );
}

export class GoogleCalendarClient {
  constructor({
    calendarId = process.env.GOOGLE_CALENDAR_ID,
    highTicketCalendarId = process.env.GOOGLE_CALENDAR_HIGH_TICKET_ID,
    lowTicketCalendarId = process.env.GOOGLE_CALENDAR_LOW_TICKET_ID,
    clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    enabled = process.env.GOOGLE_CALENDAR_ENABLED !== 'false',
    oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID,
    oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    oauthRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/api/google/callback`,
    oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    oauthHighTicketRefreshToken = process.env.GOOGLE_OAUTH_HIGH_TICKET_REFRESH_TOKEN,
    oauthLowTicketRefreshToken = process.env.GOOGLE_OAUTH_LOW_TICKET_REFRESH_TOKEN,
    oauthTokenDir = process.env.GOOGLE_OAUTH_TOKEN_DIR || '.secrets',
    privateKey = process.env.GOOGLE_PRIVATE_KEY,
    serviceAccountJsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH,
    timeZone = process.env.GOOGLE_CALENDAR_TIME_ZONE || 'America/Sao_Paulo',
  } = {}) {
    const serviceAccount = loadServiceAccount(serviceAccountJsonPath);
    const hasOAuthConfig = Boolean(oauthClientId && oauthClientSecret);

    this.calendarId = calendarId || lowTicketCalendarId || highTicketCalendarId || (hasOAuthConfig ? 'primary' : '');
    this.highTicketCalendarId = highTicketCalendarId || this.calendarId;
    this.lowTicketCalendarId = lowTicketCalendarId || this.calendarId;
    this.clientEmail = clientEmail || serviceAccount?.client_email;
    this.enabled = enabled;
    this.oauthClientId = oauthClientId;
    this.oauthClientSecret = oauthClientSecret;
    this.oauthRedirectUri = oauthRedirectUri;
    this.oauthTokenDir = oauthTokenDir;
    this.oauthTokens = {
      default: oauthRefreshToken,
      high_ticket: oauthHighTicketRefreshToken,
      low_ticket: oauthLowTicketRefreshToken,
    };
    this.privateKey = normalizePrivateKey(privateKey || serviceAccount?.private_key);
    this.timeZone = timeZone;
    this.calendar = new Map();
  }

  get isReady() {
    return Boolean(this.enabled && (this.hasServiceAccount || this.hasOAuthToken()));
  }

  get hasServiceAccount() {
    return Boolean(this.clientEmail && this.privateKey && (this.calendarId || this.lowTicketCalendarId || this.highTicketCalendarId));
  }

  get hasOAuthConfig() {
    return Boolean(this.oauthClientId && this.oauthClientSecret && this.oauthRedirectUri);
  }

  hasOAuthToken() {
    return Boolean(this.getOAuthRefreshToken('default') || this.getOAuthRefreshToken('low_ticket') || this.getOAuthRefreshToken('high_ticket'));
  }

  getDirectOAuthRefreshToken(leadType) {
    const normalizedLeadType = normalizeLeadType(leadType);
    return this.oauthTokens[normalizedLeadType] || readOAuthToken(this.oauthTokenDir, normalizedLeadType)?.refresh_token || null;
  }

  getStatus() {
    return {
      enabled: this.isReady,
      authMode: this.hasServiceAccount ? 'service_account' : this.hasOAuthToken() ? 'oauth' : 'not_configured',
      calendars: {
        default: this.calendarId,
        highTicket: this.highTicketCalendarId,
        lowTicket: this.lowTicketCalendarId,
      },
      oauth: {
        configured: this.hasOAuthConfig,
        connected: {
          default: Boolean(this.getDirectOAuthRefreshToken('default')),
          highTicket: Boolean(this.getDirectOAuthRefreshToken('high_ticket')),
          lowTicket: Boolean(this.getDirectOAuthRefreshToken('low_ticket')),
        },
      },
      provider: 'Google Calendar',
      timeZone: this.timeZone,
    };
  }

  createOAuthClient() {
    if (!this.hasOAuthConfig) {
      throw new Error('OAuth do Google Agenda nao configurado.');
    }

    return new google.auth.OAuth2(this.oauthClientId, this.oauthClientSecret, this.oauthRedirectUri);
  }

  createAuthUrl({ leadType = 'default' } = {}) {
    const normalizedLeadType = normalizeLeadType(leadType);
    const auth = this.createOAuthClient();

    return {
      authUrl: auth.generateAuthUrl({
        access_type: 'offline',
        include_granted_scopes: true,
        prompt: 'consent',
        scope: CALENDAR_SCOPES,
        state: encodeState({ leadType: normalizedLeadType }),
      }),
      leadType: normalizedLeadType,
    };
  }

  async exchangeOAuthCode({ code, state }) {
    if (!code) {
      throw new Error('Codigo OAuth nao informado.');
    }

    const { leadType = 'default' } = decodeState(state);
    const normalizedLeadType = normalizeLeadType(leadType);
    const auth = this.createOAuthClient();
    const { tokens } = await auth.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error('O Google nao retornou refresh token. Tente conectar de novo usando consentimento completo.');
    }

    this.oauthTokens[normalizedLeadType] = tokens.refresh_token;
    this.calendar.delete(normalizedLeadType);

    const tokenPath = getTokenPath(this.oauthTokenDir, normalizedLeadType);
    if (tokenPath) {
      await fsPromises.mkdir(path.dirname(tokenPath), { recursive: true });
      await fsPromises.writeFile(
        tokenPath,
        JSON.stringify(
          {
            created_at: new Date().toISOString(),
            lead_type: normalizedLeadType,
            refresh_token: tokens.refresh_token,
            scope: tokens.scope,
            token_type: tokens.token_type,
          },
          null,
          2,
        ),
      );
    }

    return {
      leadType: normalizedLeadType,
      savedLocally: Boolean(tokenPath),
      tokenPath,
    };
  }

  async disconnectOAuth({ leadType = 'default' } = {}) {
    if (!this.hasOAuthConfig) {
      throw new Error('OAuth do Google Agenda nao configurado.');
    }

    const normalizedLeadType = normalizeLeadType(leadType);
    const tokenPath = getTokenPath(this.oauthTokenDir, normalizedLeadType);
    const hadMemoryToken = Boolean(this.oauthTokens[normalizedLeadType]);
    const hadFileToken = Boolean(tokenPath && fs.existsSync(tokenPath));

    this.oauthTokens[normalizedLeadType] = null;

    if (normalizedLeadType === 'default') {
      this.calendar.clear();
    } else {
      this.calendar.delete(normalizedLeadType);
    }

    if (hadFileToken) {
      await fsPromises.rm(tokenPath, { force: true });
    }

    return {
      disconnected: hadMemoryToken || hadFileToken,
      leadType: normalizedLeadType,
      removedLocalToken: hadFileToken,
      tokenPath,
    };
  }

  getOAuthRefreshToken(leadType) {
    const normalizedLeadType = normalizeLeadType(leadType);
    const directToken = this.oauthTokens[normalizedLeadType] || null;
    if (directToken) {
      return directToken;
    }

    const fileToken = readOAuthToken(this.oauthTokenDir, normalizedLeadType)?.refresh_token;
    if (fileToken) {
      return fileToken;
    }

    if (normalizedLeadType !== 'default') {
      return this.oauthTokens.default || readOAuthToken(this.oauthTokenDir, 'default')?.refresh_token || null;
    }

    return null;
  }

  getCalendar(leadType) {
    if (!this.isReady) {
      throw new Error('Google Agenda nao configurado.');
    }

    const authKey = this.hasServiceAccount ? 'service_account' : normalizeLeadType(leadType);

    if (!this.calendar.has(authKey)) {
      let auth;

      if (this.hasServiceAccount) {
        auth = new google.auth.JWT({
          email: this.clientEmail,
          key: this.privateKey,
          scopes: CALENDAR_SCOPES,
        });
      } else {
        const refreshToken = this.getOAuthRefreshToken(leadType);
        if (!refreshToken) {
          throw new Error('Conta Google ainda nao conectada.');
        }

        auth = this.createOAuthClient();
        auth.setCredentials({ refresh_token: refreshToken });
      }

      this.calendar.set(authKey, google.calendar({ version: 'v3', auth }));
    }

    return this.calendar.get(authKey);
  }

  getCalendarId(leadType) {
    if (leadType === 'high_ticket') {
      return this.highTicketCalendarId || this.calendarId || 'primary';
    }

    if (leadType === 'low_ticket') {
      return this.lowTicketCalendarId || this.calendarId || 'primary';
    }

    return this.calendarId || this.lowTicketCalendarId || this.highTicketCalendarId || 'primary';
  }

  async validateConnection(leadType = 'default') {
    const calendar = this.getCalendar(leadType);
    const calendarId = this.getCalendarId(leadType);
    const result = await calendar.calendarList.get({ calendarId });

    return {
      calendarId,
      summary: result.data.summary || calendarId,
    };
  }

  getLegacyCalendar() {
    if (!this.hasServiceAccount) {
      return null;
    }

    if (!this.calendar.has('service_account')) {
      const auth = new google.auth.JWT({
        email: this.clientEmail,
        key: this.privateKey,
        scopes: CALENDAR_SCOPES,
      });

      this.calendar.set('service_account', google.calendar({ version: 'v3', auth }));
    }

    return this.calendar.get('service_account');
  }

  async createMeeting({
    attendeeEmail,
    attendeeName,
    description,
    durationMinutes = 30,
    leadType,
    startDateTime,
    title = 'Reuniao ContabSquad',
  }) {
    const calendar = this.getCalendar(leadType);
    const targetCalendarId = this.getCalendarId(leadType);
    const start = new Date(startDateTime);

    if (Number.isNaN(start.getTime())) {
      throw new Error('Data da reuniao invalida.');
    }

    const end = addMinutes(start, durationMinutes);
    const attendees = attendeeEmail
      ? [
          {
            email: attendeeEmail,
            displayName: attendeeName || undefined,
          },
        ]
      : undefined;

    const result = await calendar.events.insert({
      calendarId: targetCalendarId,
      conferenceDataVersion: 1,
      sendUpdates: attendeeEmail ? 'all' : 'none',
      requestBody: {
        summary: title,
        description,
        start: {
          dateTime: start.toISOString(),
          timeZone: this.timeZone,
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: this.timeZone,
        },
        attendees,
        conferenceData: {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: {
              type: 'hangoutsMeet',
            },
          },
        },
      },
    });

    return {
      calendarLink: result.data.htmlLink || null,
      calendarId: targetCalendarId,
      eventId: result.data.id,
      leadType,
      meetLink: getMeetLink(result.data),
      startDateTime: result.data.start?.dateTime || start.toISOString(),
      title: result.data.summary || title,
    };
  }
}
