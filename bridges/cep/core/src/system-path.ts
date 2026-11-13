/** Normalize the native CEP file URI before loading JSX or claiming identity. */
export function cepSystemPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let path = value;
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURI(path).replace(/^file:\/\//i, "");
    } catch {
      return undefined;
    }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  path = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!path || path.length > 32768 || path.trim() !== path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) return undefined;
  if (path.split("/").some((part) => part === "." || part === "..")) return undefined;
  return path;
}
