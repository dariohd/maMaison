const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

export function locked(state, now = Date.now()) {
  return Boolean(state && state.loginLockedUntil && now < state.loginLockedUntil);
}

export function noteFailure(state, now, mark) {
  if (locked(state, now)) return { changed: false, until: state.loginLockedUntil };
  const marks = (Array.isArray(state.loginFailureMarks) ? state.loginFailureMarks : [])
    .filter((item) => now - Number(String(item).split("-")[0]) < LOCK_MS);
  marks.push(mark);
  if (marks.length >= LOCK_AFTER) {
    state.loginLockedUntil = now + LOCK_MS;
    state.loginFailureMarks = [];
    state.loginFailures = 0;
    return { changed: true, until: state.loginLockedUntil };
  }
  state.loginFailureMarks = marks.slice(-20);
  state.loginFailures = state.loginFailureMarks.length;
  state.loginLockedUntil = 0;
  return { changed: true, until: 0 };
}
