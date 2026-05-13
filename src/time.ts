// Timezone utilities. We store everything in Unix seconds (UTC) in D1
// but humans think in their local timezone. User's tz is stored on the user row.

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** "YYYY-MM-DD" in the given IANA timezone for the given unix-seconds timestamp */
export function dateInTz(unixSec: number, tz: string): string {
  const d = new Date(unixSec * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const day = parts.find(p => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

/** "HH:MM" local time */
export function timeInTz(unixSec: number, tz: string): string {
  const d = new Date(unixSec * 1000);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** YYYY-MM-DD of the Monday of the ISO week containing the given local date in tz. */
export function mondayOfWeek(unixSec: number, tz: string): string {
  const today = dateInTz(unixSec, tz);
  const dow = dowInTz(unixSec, tz); // 0=Sun..6=Sat
  // Days to subtract to land on Monday: Mon→0, Tue→1, ..., Sun→6
  const back = dow === 0 ? 6 : dow - 1;
  return addDaysTz(today, -back);
}

/** Day of week in tz: 0=Sun..6=Sat */
export function dowInTz(unixSec: number, tz: string): number {
  const d = new Date(unixSec * 1000);
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s);
}

/** Parse flexible date/time text into unix seconds in user's tz.
 *  Supports:
 *    - ISO with offset / Z
 *    - "2026-05-01 18:00" / "2026-05-01T18:00" / "2026-05-01"
 *    - "HH:MM" → today at that time (or tomorrow if already passed)
 *    - "tomorrow 09:00" / "сегодня 14:00" / "завтра 9:00" / "послезавтра 08:00"
 *    - "через 5 минут" / "через 2 часа" / "через 3 дня"
 *    - "in 15 minutes" / "in 2 hours" / "in 1 day"
 *  Returns null if unparseable.
 */
export function parseFireAt(input: string, tz: string, ref?: number): number | null {
  const refSec = ref ?? nowSec();
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  // ISO with timezone offset or Z → direct parse
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const t = Date.parse(trimmed);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }

  // Russian relative: "через N минут/час(а|ов)/день/дня/дней/недел(ю|и|ь)"
  // (\S* not \w* because default \w doesn't include Cyrillic — we want to match
  // any cyrillic suffix like "минуты", "часа", "недели" etc.)
  const ruRel = lower.match(/^через\s+(\d+)\s+(секунд\S*|минут\S*|час\S*|дн\S*|недел\S*)$/);
  if (ruRel) {
    const n = parseInt(ruRel[1]);
    const unit = ruRel[2];
    const sec = unit.startsWith('секунд') ? n :
                unit.startsWith('минут')  ? n * 60 :
                unit.startsWith('час')    ? n * 3600 :
                unit.startsWith('дн')     ? n * 86400 :
                unit.startsWith('недел')  ? n * 7 * 86400 :
                0;
    if (sec > 0) return refSec + sec;
  }
  // Russian: "через минуту/час/день/неделю" (implicit 1)
  const ruRel1 = lower.match(/^через\s+(секунду|минуту|час|день|неделю)$/);
  if (ruRel1) {
    const unit = ruRel1[1];
    const sec = unit === 'секунду' ? 1 :
                unit === 'минуту'  ? 60 :
                unit === 'час'     ? 3600 :
                unit === 'день'    ? 86400 :
                unit === 'неделю'  ? 7 * 86400 : 0;
    if (sec > 0) return refSec + sec;
  }

  // English relative: "in N minutes/hours/days/weeks"
  const enRel = lower.match(/^in\s+(\d+)\s+(second|minute|hour|day|week)s?$/);
  if (enRel) {
    const n = parseInt(enRel[1]);
    const unit = enRel[2];
    const sec = unit === 'second' ? n : unit === 'minute' ? n * 60
              : unit === 'hour' ? n * 3600 : unit === 'day' ? n * 86400
              : n * 7 * 86400;
    return refSec + sec;
  }

  // "tomorrow HH:MM" / "завтра 09:00" / etc
  const rel = lower.match(
    /^(today|tomorrow|day[\s-]?after[\s-]?tomorrow|сегодня|завтра|послезавтра)\s+(?:в\s+)?(\d{1,2})[:.](\d{2})$/
  );
  if (rel) {
    const offsetDays =
      rel[1] === 'today' || rel[1] === 'сегодня' ? 0 :
      rel[1] === 'tomorrow' || rel[1] === 'завтра' ? 1 : 2;
    const hh = parseInt(rel[2]);
    const mm = parseInt(rel[3]);
    const targetDate = addDaysTz(dateInTz(refSec, tz), offsetDays);
    return buildTsInTz(targetDate, hh, mm, tz);
  }

  // "в HH:MM" / "at HH:MM" → today/tomorrow that time
  const atTime = lower.match(/^(?:в|at)\s+(\d{1,2})[:.](\d{2})$/);
  if (atTime) {
    const today = dateInTz(refSec, tz);
    const ts = buildTsInTz(today, parseInt(atTime[1]), parseInt(atTime[2]), tz);
    return ts <= refSec ? ts + 86400 : ts;
  }

  // "HH:MM" / "HH.MM" → today at that time in tz
  const hhmm = trimmed.match(/^(\d{1,2})[:.](\d{2})$/);
  if (hhmm) {
    const today = dateInTz(refSec, tz);
    const ts = buildTsInTz(today, parseInt(hhmm[1]), parseInt(hhmm[2]), tz);
    return ts <= refSec ? ts + 86400 : ts;
  }

  // "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
  const dt = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2})[:.](\d{2}))?$/);
  if (dt) {
    const date = dt[1];
    const hh = parseInt(dt[2] || '9');
    const mm = parseInt(dt[3] || '0');
    return buildTsInTz(date, hh, mm, tz);
  }

  return null;
}

export function addDaysTz(yyyymmdd: string, days: number): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Given "YYYY-MM-DD", hh, mm, tz — compute unix seconds for that wall-clock instant in tz. */
export function buildTsInTz(date: string, hh: number, mm: number, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  // First guess: construct as if the wall time were UTC
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm, 0);
  // Find what the wall time would be in tz at utcGuess. Adjust by the difference.
  const offsetMin = tzOffsetMinutes(tz, utcGuess);
  return Math.floor((utcGuess - offsetMin * 60 * 1000) / 1000);
}

/** Offset in minutes: localTime - UTC. E.g. Moscow = +180. */
export function tzOffsetMinutes(tz: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(atMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asIfUtc = Date.UTC(
    parseInt(map.year), parseInt(map.month) - 1, parseInt(map.day),
    parseInt(map.hour === '24' ? '0' : map.hour),
    parseInt(map.minute), parseInt(map.second),
  );
  return Math.round((asIfUtc - atMs) / 60000);
}

export function formatLocal(unixSec: number, tz: string): string {
  return `${dateInTz(unixSec, tz)} ${timeInTz(unixSec, tz)}`;
}
