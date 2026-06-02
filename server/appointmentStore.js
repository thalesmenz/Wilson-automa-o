const DEFAULT_TABLE = process.env.SUPABASE_APPOINTMENTS_TABLE || 'whatsapp_appointments';

function addHours(date, hours) {
  return new Date(date.getTime() + Number(hours || 0) * 60 * 60 * 1000);
}

function toIsoDateFilter(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function getLocalDateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date);
}

function getLocalMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone,
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function parseTimeToMinutes(value) {
  const [hour = '8', minute = '0'] = String(value || '08:00').split(':');
  return Number(hour) * 60 + Number(minute);
}

function toAppointmentRow(appointment) {
  return {
    attendee_email: appointment.attendeeEmail,
    calendar_id: appointment.calendarId,
    calendar_link: appointment.calendarLink,
    contact_name: appointment.contactName,
    event_id: appointment.eventId,
    jid: appointment.jid,
    lead_type: appointment.leadType,
    meet_link: appointment.meetLink,
    start_datetime: appointment.startDateTime,
    title: appointment.title,
    updated_at: new Date().toISOString(),
  };
}

function fromAppointmentRow(row) {
  return {
    attendeeEmail: row.attendee_email,
    calendarId: row.calendar_id,
    calendarLink: row.calendar_link,
    contactName: row.contact_name,
    createdAt: row.created_at,
    dayReminderSentAt: row.day_reminder_sent_at,
    eventId: row.event_id,
    id: row.id,
    jid: row.jid,
    leadType: row.lead_type,
    meetLink: row.meet_link,
    startDateTime: row.start_datetime,
    status: row.status,
    thirtyMinReminderSentAt: row.thirty_min_reminder_sent_at,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

export class AppointmentStore {
  constructor({
    dayReminderTime = process.env.FOLLOWUP_DAY_REMINDER_TIME || '08:00',
    enabled = process.env.FOLLOWUP_ENABLED !== 'false',
    lookaheadHours = process.env.FOLLOWUP_LOOKAHEAD_HOURS || 36,
    supabase,
    table = DEFAULT_TABLE,
    timeZone = process.env.GOOGLE_CALENDAR_TIME_ZONE || 'America/Sao_Paulo',
  } = {}) {
    this.dayReminderMinutes = parseTimeToMinutes(dayReminderTime);
    this.enabled = enabled;
    this.lookaheadHours = Number(lookaheadHours || 36);
    this.supabase = supabase;
    this.table = table;
    this.timeZone = timeZone;
  }

  get isReady() {
    return Boolean(this.enabled && this.supabase?.isReady);
  }

  get isConfigured() {
    return Boolean(this.supabase?.isReady);
  }

  getStatus() {
    return {
      active: this.enabled,
      configured: this.isConfigured,
      enabled: this.isReady,
      provider: 'Supabase',
      table: this.table,
    };
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    return this.getStatus();
  }

  getClient() {
    return this.supabase.getClient();
  }

  async saveAppointment(appointment) {
    if (!this.isConfigured) {
      return null;
    }

    const { data, error } = await this.getClient()
      .from(this.table)
      .upsert(toAppointmentRow(appointment), { onConflict: 'event_id' })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return fromAppointmentRow(data);
  }

  async listAppointments({ excludeDemo = false, from, limit = 250, status, to } = {}) {
    if (!this.isConfigured) {
      return [];
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 250, 1), 500);
    let query = this.getClient()
      .from(this.table)
      .select('*')
      .order('start_datetime', { ascending: true })
      .limit(safeLimit);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (excludeDemo) {
      query = query.not('event_id', 'like', 'demo-%');
    }

    const fromIso = toIsoDateFilter(from);
    const toIso = toIsoDateFilter(to);

    if (fromIso) {
      query = query.gte('start_datetime', fromIso);
    }

    if (toIso) {
      query = query.lte('start_datetime', toIso);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return data.map(fromAppointmentRow);
  }

  async listUpcomingAppointments(now = new Date()) {
    if (!this.isReady) {
      return [];
    }

    const maxDate = addHours(now, this.lookaheadHours);
    const { data, error } = await this.getClient()
      .from(this.table)
      .select('*')
      .eq('status', 'scheduled')
      .gte('start_datetime', now.toISOString())
      .lte('start_datetime', maxDate.toISOString())
      .order('start_datetime', { ascending: true })
      .limit(250);

    if (error) {
      throw error;
    }

    return data.map(fromAppointmentRow);
  }

  async listDueReminders(now = new Date()) {
    const appointments = await this.listUpcomingAppointments(now);
    const todayKey = getLocalDateKey(now, this.timeZone);
    const currentLocalMinutes = getLocalMinutes(now, this.timeZone);

    return appointments.flatMap((appointment) => {
      const start = new Date(appointment.startDateTime);
      const minutesUntilStart = Math.floor((start.getTime() - now.getTime()) / 60000);
      const due = [];

      if (
        !appointment.dayReminderSentAt &&
        getLocalDateKey(start, this.timeZone) === todayKey &&
        currentLocalMinutes >= this.dayReminderMinutes &&
        minutesUntilStart > 30
      ) {
        due.push({ appointment, type: 'day' });
      }

      if (!appointment.thirtyMinReminderSentAt && minutesUntilStart <= 30 && minutesUntilStart >= 0) {
        due.push({ appointment, type: 'thirty_min' });
      }

      return due;
    });
  }

  async findNextScheduledAppointmentByJid(jid, now = new Date()) {
    if (!this.isConfigured || !jid) {
      return null;
    }

    const { data, error } = await this.getClient()
      .from(this.table)
      .select('*')
      .eq('jid', jid)
      .eq('status', 'scheduled')
      .gte('start_datetime', now.toISOString())
      .order('start_datetime', { ascending: true })
      .limit(1);

    if (error) {
      throw error;
    }

    return data?.[0] ? fromAppointmentRow(data[0]) : null;
  }

  async markCancelled(id, cancelledAt = new Date()) {
    if (!this.isConfigured || !id) {
      return null;
    }

    const { data, error } = await this.getClient()
      .from(this.table)
      .update({
        status: 'cancelled',
        updated_at: cancelledAt.toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return fromAppointmentRow(data);
  }

  async markReminderSent(id, type, sentAt = new Date()) {
    if (!this.isReady) {
      return null;
    }

    const column = type === 'day' ? 'day_reminder_sent_at' : 'thirty_min_reminder_sent_at';
    const { error } = await this.getClient()
      .from(this.table)
      .update({
        [column]: sentAt.toISOString(),
        updated_at: sentAt.toISOString(),
      })
      .eq('id', id);

    if (error) {
      throw error;
    }

    return true;
  }
}
