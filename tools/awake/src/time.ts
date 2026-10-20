// "7am", "7:30am", "19:00" -> the next time that clock reading comes round.
export function parseUntil(input: string, now: Date): Date | null {
  const m = input.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  } else if (hour > 23) {
    return null;
  }
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

// "6h", "90m", "1h30m" -> now plus that long.
export function parseFor(input: string, now: Date): Date | null {
  const m = input.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?$/i);
  if (!m || (!m[1] && !m[2])) return null;
  const minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  if (minutes <= 0) return null;
  return new Date(now.getTime() + minutes * 60_000);
}
