import { get, put } from "@vercel/blob";

const PATH = "house/state.json";

function empty() {
  return { snapshot: null, seenAt: 0, queue: [] };
}

async function textOf(result) {
  if (!result || result.statusCode === 404) return null;
  if (result.stream) return new Response(result.stream).text();
  if (result.blob && typeof result.blob.text === "function") return result.blob.text();
  if (typeof result.text === "function") return result.text();
  return null;
}

export async function load() {
  try {
    const result = await get(PATH, { access: "private", useCache: false });
    const text = await textOf(result);
    if (!text) return empty();
    const data = JSON.parse(text);
    if (!Array.isArray(data.queue)) data.queue = [];
    return data;
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/404|not found|NotFound|BlobNotFound/i.test(message)) return empty();
    throw error;
  }
}

export async function save(state) {
  await put(PATH, JSON.stringify(state), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });
}
