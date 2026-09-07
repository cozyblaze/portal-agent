export const TIME_ZONE = 'America/Los_Angeles';
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  hourCycle: 'h23', timeZoneName: 'longOffset',
});
export function pacificTimestamp(value) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.timeZoneName.replace('GMT', '')}`;
}
