export const startOfDayMs = (timestamp = Date.now()): number => {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
};

export const isSameDay = (left: number, right: number): boolean => {
  return startOfDayMs(left) === startOfDayMs(right);
};

export const startOfWeekMs = (timestamp = Date.now()): number => {
  const date = new Date(timestamp);
  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.getTime();
};

export const startOfMonthMs = (timestamp = Date.now()): number => {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(1);
  return date.getTime();
};
