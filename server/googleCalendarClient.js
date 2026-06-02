import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { google } from 'googleapis';

const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const OAUTH_LEAD_TYPES = ['default', 'low_ticket', 'high_ticket'];
const DEFAULT_AVAILABILITY_LOOKAHEAD_DAYS = Number(process.env.GOOGLE_CALENDAR_AVAILABILITY_LOOKAHEAD_DAYS || 7);
const DEFAULT_AVAILABILITY_MAX_SLOTS = Number(process.env.GOOGLE_CALENDAR_AVAILABILITY_MAX_SLOTS || 4);
const DEFAULT_AVAILABILITY_STEP_MINUTES = Number(process.env.GOOGLE_CALENDAR_AVAILABILITY_STEP_MINUTES || 30);
const DEFAULT_AVAILABILITY_MIN_NOTICE_MINUTES = Number(process.env.GOOGLE_CALENDAR_MIN_NOTICE_MINUTES || 60);
const DEFAULT_AVAILABILITY_START_TIME = process.env.GOOGLE_CALENDAR_WORKDAY_START || '09:00';
const DEFAULT_AVAILABILITY_END_TIME = process.env.GOOGLE_CALENDAR_WORKDAY_END || '18:00';
const DEFAULT_AVAILABILITY_WORKDAYS = process.env.GOOGLE_CALENDAR_WORKDAYS || '1,2,3,4,5';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function parseClock(value, fallback) {
  const [hour, minute] = String(value || fallback || '09:00')
    .split(':')
    .map((item) => Number(item));

  return {
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

function parseWorkdays(value) {
  return new Set(
    String(value || DEFAULT_AVAILABILITY_WORKDAYS)
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6),
  );
}

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    weekday: 'short',
    year: 'numeric',
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    day: Number(lookup.day),
    hour: Number(lookup.hour === '24' ? 0 : lookup.hour),
    minute: Number(lookup.minute),
    month: Number(lookup.month),
    second: Number(lookup.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(lookup.weekday),
    year: Number(lookup.year),
  };
}

function zonedTimeToUtc({ day, hour = 0, minute = 0, month, second = 0, year }, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const parts = getTimeZoneParts(guess, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return new Date(guess.getTime() + targetAsUtc - localAsUtc);
}

function roundUpDate(date, stepMinutes) {
  const stepMs = Math.max(1, Number(stepMinutes || 30)) * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / stepMs) * stepMs);
}

function eventsOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function getMeetLink(event) {
  return (
    event?.hangoutLink ||
    event?.conferenceData?.entryPoints?.find((entryPoint) => entryPoint.entryPointType === 'video')?.uri ||
    null
  );
}

function summarizeCalendarEvent(event, { calendarId, leadType } = {}) {
  return {
    calendarId,
    calendarLink: event.htmlLink || null,
    endDateTime: event.end?.dateTime || event.end?.date || null,
    eventId: event.id,
    leadType,
    meetLink: getMeetLink(event),
    startDateTime: event.start?.dateTime || event.start?.date || null,
    status: event.status || null,
    title: event.summary || null,
  };
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
    this.availability = {
      endTime: DEFAULT_AVAILABILITY_END_TIME,
      lookaheadDays: DEFAULT_AVAILABILITY_LOOKAHEAD_DAYS,
      maxSlots: DEFAULT_AVAILABILITY_MAX_SLOTS,
      minNoticeMinutes: DEFAULT_AVAILABILITY_MIN_NOTICE_MINUTES,
      startTime: DEFAULT_AVAILABILITY_START_TIME,
      stepMinutes: DEFAULT_AVAILABILITY_STEP_MINUTES,
      workdays: parseWorkdays(DEFAULT_AVAILABILITY_WORKDAYS),
    };
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
    createMeet = Boolean(attendeeEmail),
    description,
    durationMinutes = 30,
    leadType,
    startDateTime,
    title = 'Reuniao Wilson Sanches',
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
    const requestBody = {
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
    };

    if (createMeet) {
      requestBody.conferenceData = {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: {
            type: 'hangoutsMeet',
          },
        },
      };
    }

    const result = await calendar.events.insert({
      calendarId: targetCalendarId,
      conferenceDataVersion: createMeet ? 1 : 0,
      sendUpdates: attendeeEmail ? 'all' : 'none',
      requestBody,
    });
    const eventId = result.data.id;
    let verifiedEvent = null;
    let verificationError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        verifiedEvent = await this.getMeeting({
          calendarId: targetCalendarId,
          eventId,
          leadType,
        });
        verificationError = null;
        break;
      } catch (error) {
        verificationError = error.message;

        if (attempt < 3) {
          await sleep(350 * attempt);
        }
      }
    }

    if (verifiedEvent?.status === 'cancelled') {
      throw new Error('Google Agenda criou o evento, mas ele voltou como cancelado.');
    }

    return {
      calendarLink: verifiedEvent?.calendarLink || result.data.htmlLink || null,
      calendarId: targetCalendarId,
      eventId,
      leadType,
      meetLink: verifiedEvent?.meetLink || getMeetLink(result.data),
      startDateTime: verifiedEvent?.startDateTime || result.data.start?.dateTime || start.toISOString(),
      title: verifiedEvent?.title || result.data.summary || title,
      verificationError,
      verified: Boolean(verifiedEvent),
    };
  }

  async getMeeting({ calendarId, eventId, leadType } = {}) {
    if (!eventId) {
      throw new Error('Evento do Google Agenda nao informado.');
    }

    const calendar = this.getCalendar(leadType);
    const targetCalendarId = calendarId || this.getCalendarId(leadType);
    const result = await calendar.events.get({
      calendarId: targetCalendarId,
      eventId,
    });

    return summarizeCalendarEvent(result.data, {
      calendarId: targetCalendarId,
      leadType,
    });
  }

  async listAvailableSlots({
    durationMinutes = Number(process.env.GOOGLE_CALENDAR_EVENT_DURATION_MINUTES || 30),
    leadType,
    lookaheadDays = this.availability.lookaheadDays,
    maxSlots = this.availability.maxSlots,
    now = new Date(),
  } = {}) {
    const calendar = this.getCalendar(leadType);
    const calendarId = this.getCalendarId(leadType);
    const durationMs = Number(durationMinutes || 30) * 60 * 1000;
    const minStart = addMinutes(now, this.availability.minNoticeMinutes);
    const searchEnd = addDays(now, lookaheadDays);
    const result = await calendar.events.list({
      calendarId,
      maxResults: 250,
      orderBy: 'startTime',
      showDeleted: false,
      singleEvents: true,
      timeMax: searchEnd.toISOString(),
      timeMin: now.toISOString(),
    });
    const busy = (result.data.items || [])
      .map((event) => ({
        end: new Date(event.end?.dateTime || event.end?.date),
        start: new Date(event.start?.dateTime || event.start?.date),
      }))
      .filter((event) => !Number.isNaN(event.start.getTime()) && !Number.isNaN(event.end.getTime()));
    const slots = [];
    const workdayStart = parseClock(this.availability.startTime, '09:00');
    const workdayEnd = parseClock(this.availability.endTime, '18:00');

    for (let dayOffset = 0; dayOffset <= Number(lookaheadDays || 7) && slots.length < maxSlots; dayOffset += 1) {
      const localParts = getTimeZoneParts(addDays(now, dayOffset), this.timeZone);

      if (!this.availability.workdays.has(localParts.weekday)) {
        continue;
      }

      const dayStart = zonedTimeToUtc(
        {
          day: localParts.day,
          hour: workdayStart.hour,
          minute: workdayStart.minute,
          month: localParts.month,
          year: localParts.year,
        },
        this.timeZone,
      );
      const dayEnd = zonedTimeToUtc(
        {
          day: localParts.day,
          hour: workdayEnd.hour,
          minute: workdayEnd.minute,
          month: localParts.month,
          year: localParts.year,
        },
        this.timeZone,
      );
      let cursor = roundUpDate(new Date(Math.max(dayStart.getTime(), minStart.getTime())), this.availability.stepMinutes);

      while (cursor.getTime() + durationMs <= dayEnd.getTime() && slots.length < maxSlots) {
        const slotEnd = new Date(cursor.getTime() + durationMs);
        const isBusy = busy.some((event) => eventsOverlap(cursor, slotEnd, event.start, event.end));

        if (!isBusy) {
          slots.push({
            calendarId,
            endDateTime: slotEnd.toISOString(),
            leadType,
            startDateTime: cursor.toISOString(),
          });
        }

        cursor = addMinutes(cursor, this.availability.stepMinutes);
      }
    }

    return slots;
  }

  async cancelMeeting({ calendarId, eventId, leadType }) {
    if (!eventId) {
      throw new Error('Evento do Google Agenda nao informado.');
    }

    const calendar = this.getCalendar(leadType);
    const targetCalendarId = calendarId || this.getCalendarId(leadType);

    await calendar.events.delete({
      calendarId: targetCalendarId,
      eventId,
      sendUpdates: 'all',
    });

    return {
      calendarId: targetCalendarId,
      eventId,
      leadType,
    };
  }
}
