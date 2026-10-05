const replacements = new Map([
  ["@deepseek-ai/schemastery", new URL("./schemastery-stub.mjs", import.meta.url).href],
  ["@deepseek-ai/dsh-typert-protocol", new URL("./typert-protocol-stub.mjs", import.meta.url).href],
  ["@deepseek-ai/dsh-app-boot", new URL("./app-boot-stub.mjs", import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const replacement = replacements.get(specifier);
  if (replacement !== undefined) return { url: replacement, shortCircuit: true };
  return nextResolve(specifier, context);
}
