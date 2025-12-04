export const startOfDayMs = (timestamp = Date.now()): number => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export const isSameDay = (left: number, right: number): boolean => {
  return startOfDayMs(left) === startOfDayMs(right);
};

export const startOfWeekMs = (timestamp = Date.now()): number => {
  const date = new Date(timestamp);
  const dayOfWeek = date.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysSinceMonday);
  return date.getTime();
};

export const startOfMonthMs = (timestamp = Date.now()): number => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
};
