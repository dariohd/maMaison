export function personRole(state, session) {
  if (!session || !session.person || session.person === "owner") return "owner";
  const person = (state.people || []).find((item) => item.id === session.person);
  return person && person.role === "setup" ? "setup" : "use";
}

export function phoneWriteAllowed(role, method, parts) {
  if (method === "GET") return true;
  const run = method === "POST" && parts[0] === "devices" && parts[2] === "actions" && parts[4] === "run";
  const picture = method === "POST" && parts[0] === "devices" && parts[2] === "actions" && parts[4] === "picture";
  const scene = method === "POST" && parts[0] === "scenes" && parts[2] === "run";
  const check = method === "POST" && parts.length === 1 && parts[0] === "check";
  if (run || picture || scene || check) return true;
  const rename = method === "PUT" && parts[0] === "devices" && parts.length === 2;
  const alerts = method === "POST" && parts[0] === "alerts" && parts[1] === "read";
  if ((rename || alerts) && (role === "owner" || role === "setup")) return true;
  return false;
}
