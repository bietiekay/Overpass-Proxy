export const startOfDayMs = (timestamp = Date.now()): number => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export const isSameDay = (left: number, right: number): boolean => {
  return startOfDayMs(left) === startOfDayMs(right);
};
