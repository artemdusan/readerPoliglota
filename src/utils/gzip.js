export async function gzipEncode(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  const arr = new Uint8Array(buf);
  let s = '';
  for (const byte of arr) s += String.fromCharCode(byte);
  return btoa(s);
}

export async function gzipDecode(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
